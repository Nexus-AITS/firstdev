/**
 * Apply staged Supabase migrations + seed via the Management API — the same
 * SQL execution the Supabase dashboard SQL editor uses, so no CLI binary or
 * psql is required.
 *
 * Run: npm run db:migrate
 * Needs: SUPABASE_ACCESS_TOKEN (personal access token, sbp_…) in .env or the
 *        environment, with access to the project. The anon key CANNOT run DDL.
 *
 * The migration file is idempotent, so re-running is safe. Statements execute
 * as the postgres role, which bypasses the deny-by-default RLS from section 6
 * of the migration; the anon key still sees nothing until policies land.
 */
import { readFileSync, readdirSync } from "node:fs";

/* ---------- read .env (Vite env vars are not visible to Node) ---------- */
function loadEnv(path) {
  const out = {};
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

const env = loadEnv(new URL("../.env", import.meta.url));
const token = process.env.SUPABASE_ACCESS_TOKEN || env.SUPABASE_ACCESS_TOKEN;
// process.env wins so CI — or a failure-path self-test — can point the script
// at another endpoint without editing .env (same precedence the token uses).
const supabaseUrl = (process.env.VITE_SUPABASE_URL || env.VITE_SUPABASE_URL || "").replace(/\/+$/, "");

if (!token) {
  console.error("FAIL: SUPABASE_ACCESS_TOKEN (sbp_…) missing — add it to .env");
  process.exit(1);
}
if (!supabaseUrl) {
  console.error("FAIL: VITE_SUPABASE_URL missing from .env");
  process.exit(1);
}
const ref = new URL(supabaseUrl).hostname.split(".")[0];
// Self-hosted projects aren't behind api.supabase.com, and the failure-path
// self-test points this at a local stub — override the whole endpoint if set.
const api =
  process.env.SUPABASE_MIGRATE_API ||
  `https://api.supabase.com/v1/projects/${ref}/database/query`;
console.log(`project=${ref}`);

async function runQuery(sql, label) {
  const res = await fetch(api, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: sql }),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await res.text();
  if (!res.ok) {
    console.error(`FAIL: ${label} -> HTTP ${res.status}`);
    console.error(`      ${text.slice(0, 600)}`);
    process.exit(1);
  }
  console.log(`ok: ${label}`);
  return text;
}

/* ---------- 1) every staged migration, in order ---------- */
const migDir = new URL("../supabase/migrations/", import.meta.url);
const files = readdirSync(migDir).filter((f) => f.endsWith(".sql")).sort();
if (files.length === 0) {
  console.error("FAIL: no *.sql migrations found in supabase/migrations/");
  process.exit(1);
}
for (const f of files) {
  await runQuery(readFileSync(new URL(f, migDir), "utf8"), `migration ${f}`);
}

/* ---------- 2) seed (idempotent: on conflict do nothing) ---------- */
await runQuery(readFileSync(new URL("../supabase/seed.sql", import.meta.url), "utf8"), "seed supabase/seed.sql");

/* ---------- 3) verify as postgres (bypasses RLS) ---------- */
// Names purchase_type / purchase_label as well: a project that is missing
// migration ...000002 fails the SQL itself (runQuery exits 1) instead of having
// a partial apply reported as success.
const raw = await runQuery(
  "select count(*)::int as total, " +
    "coalesce(json_agg(t order by t.created_at), '[]'::json) as rows " +
    "from (select name, payment_status, created_at, purchase_type, purchase_label " +
    "      from public.registrations) t;",
  "verify public.registrations"
);

// Strict verification: a step that cannot prove its own claim must FAIL. The
// previous version printed "ALL CHECKS PASSED" from the catch block too, so a
// non-JSON (or shape-less) response was reported as a green migration.
let parsed;
try {
  parsed = JSON.parse(raw);
} catch {
  console.error("FAIL: verify response was not JSON — refusing to report success.");
  console.error(`      ${String(raw).slice(0, 300)}`);
}
const rows = parsed ? (Array.isArray(parsed) ? parsed : (parsed.result ?? [])) : [];
const row = rows[0];

if (typeof row?.total !== "number") {
  if (parsed) {
    console.error("FAIL: verify response carried no numeric `total` — refusing to report success.");
    console.error(`      ${JSON.stringify(parsed).slice(0, 300)}`);
  }
  // Set the code and let node unwind by itself: process.exit() called while
  // the fetch connection is still tearing down aborts with 0xC0000409 on
  // Windows instead of returning the clean 1 CI wants to see.
  process.exitCode = 1;
} else {
  console.log(`rows in public.registrations: ${row.total}`);
  for (const r of row?.rows ?? []) console.log(`  - ${r.name} | ${r.payment_status}`);
  console.log("ALL CHECKS PASSED — migration + seed applied");
}

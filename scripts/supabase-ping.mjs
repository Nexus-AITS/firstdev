/**
 * Connectivity check — proves the .env credentials reach a live Supabase
 * project with a real query against `public.registrations`.
 *
 * Run: npm run db:ping   (no server needed; talks directly to the project)
 *
 * Node cannot see Vite's import.meta.env, so the script parses `.env` itself
 * (KEY=value lines, optional quotes, `#` comments) — no dotenv dependency.
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

/* ---------- read .env ---------- */
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
const url = env.SUPABASE_URL;
const anonKey = env.SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  console.error("FAIL: SUPABASE_URL / SUPABASE_ANON_KEY missing from .env");
  process.exit(1);
}
console.log(`env ok: SUPABASE_URL=${url} anon_key_len=${anonKey.length}`);

const supabase = createClient(url, anonKey, { auth: { persistSession: false } });

/* ---------- 1) project reachable + key accepted ---------- */
let health;
try {
  const res = await fetch(`${url}/auth/v1/health`, {
    headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` },
  });
  health = { status: res.status, body: await res.text() };
  console.log(`auth /auth/v1/health -> HTTP ${health.status}`);
} catch (err) {
  console.error(`FAIL: cannot reach ${url} — ${err.message}`);
  process.exit(1);
}
if (health.status !== 200) {
  console.error(`FAIL: project rejected the anon key — ${health.body.slice(0, 200)}`);
  console.error("Hint: re-copy the `anon public` key from Supabase → Project Settings → API.");
  process.exit(1);
}
console.log("key accepted by GoTrue (project alive)");

/* ---------- 2) reachability of registrations (anon) ----------
 * Since Phase 2 the anon role has NO grants on this table at all, so
 * "permission denied" is the CORRECT and expected answer, not a fault. A
 * 42501 here proves both that the table exists and that RLS is closed; the
 * schema itself is inspected with a privileged query below. */
const { error } = await supabase
  .from("registrations")
  .select("id, name, email, payment_status")
  .limit(5);

if (error) {
  if (error.code === "PGRST205") {
    console.error(
      "FAIL: connected, but table public.registrations does not exist remotely yet.\n" +
        "      Apply supabase/migrations/20260926000000_create_registrations.sql in the\n" +
        "      SQL editor (see docs/supabase-data-model.md), then re-run db:ping."
    );
    process.exit(1);
  }
  if (error.code === "42501" || /permission denied/i.test(error.message)) {
    console.log("PASS: public.registrations exists and is closed to the anon key (RLS)");
  } else {
    console.error(`FAIL: select on public.registrations -> ${error.message} (${error.code ?? "n/a"})`);
    process.exit(1);
  }
} else {
  // Not an error, but worth flagging: if anon can read the roster, the Phase 2
  // policies are not in force and participant PII is exposed.
  console.error(
    "FAIL: the anon key CAN read public.registrations — the Phase 2 RLS policies are\n" +
      "      not applied. Run `npm run db:migrate` and then `npm run verify:rls`."
  );
  process.exit(1);
}

/* ---------- 3) row count, as postgres (RLS bypassed) ---------- */
const token = process.env.SUPABASE_ACCESS_TOKEN || env.SUPABASE_ACCESS_TOKEN;
if (token) {
  const ref = new URL(url).hostname.split(".")[0];
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      query:
        "select count(*)::int as total, " +
        "count(*) filter (where user_id is null)::int as unclaimed from public.registrations;",
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (res.ok) {
    const parsed = JSON.parse(await res.text());
    const rows = Array.isArray(parsed) ? parsed : (parsed.result ?? []);
    const r = rows[0] ?? {};
    console.log(`rows in public.registrations: ${r.total ?? "?"} (unclaimed: ${r.unclaimed ?? "?"})`);
    if (r.total === 0) {
      console.log("note: the roster is empty — the database holds only real registrations.");
    }
    if (r.unclaimed > 0) {
      console.log(
        "note: some rows predate ownership (migration ...0003). Their authors reclaim\n" +
          "      them by submitting a reference with the same email address."
      );
    }
  } else {
    console.log("note: SUPABASE_ACCESS_TOKEN absent — skipped the privileged row count.");
  }
} else {
  console.log("note: SUPABASE_ACCESS_TOKEN absent — skipped the privileged row count.");
}

console.log("ALL CHECKS PASSED — Supabase reachable with .env credentials");

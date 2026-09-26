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
const url = env.VITE_SUPABASE_URL;
const anonKey = env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  console.error("FAIL: VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY missing from .env");
  process.exit(1);
}
console.log(`env ok: VITE_SUPABASE_URL=${url} anon_key_len=${anonKey.length}`);

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

/* ---------- 2) real query against registrations ---------- */
const { data, error } = await supabase
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
  console.error(`FAIL: select on public.registrations -> ${error.message} (${error.code ?? "n/a"})`);
  process.exit(1);
}

console.log(`PASS: connected — public.registrations exists`);
if (data.length === 0) {
  console.log(
    "note: 0 rows visible to the anon key — RLS is deny-by-default by design\n" +
      "      (migration section 6). Seed rows live in the table; they are visible\n" +
      "      via the SQL editor / npm run db:migrate until policies are added."
  );
} else {
  console.log(`rows visible to anon (showing ${data.length}):`);
  for (const r of data) {
    console.log(`  - ${r.name ?? r.email ?? r.id} | ${r.payment_status ?? "-"}`);
  }
}
console.log("ALL CHECKS PASSED — Supabase reachable with .env credentials");

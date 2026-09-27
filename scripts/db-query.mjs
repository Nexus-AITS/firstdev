/**
 * Run a read-only SQL query against the project and print the JSON result.
 *
 * A dev/ops escape hatch for inspecting the schema and checking policy state
 * without opening the dashboard. Takes SQL as argv, or reads it from stdin when
 * no argument is given (which is how you pass multi-line SQL through a shell
 * that eats quotes).
 *
 *   node scripts/db-query.mjs "select count(*) from public.registrations"
 *   Get-Content query.sql | node scripts/db-query.mjs
 *
 * Uses the Management API with SUPABASE_ACCESS_TOKEN, so it runs as postgres and
 * BYPASSES RLS. That is the point — it is an operator tool, not an app path.
 */
import { readFileSync } from "node:fs";

function loadEnv(path) {
  const out = {};
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

const env = loadEnv(new URL("../.env", import.meta.url));
const token = process.env.SUPABASE_ACCESS_TOKEN || env.SUPABASE_ACCESS_TOKEN;
const supabaseUrl = (process.env.SUPABASE_URL || env.SUPABASE_URL || "").replace(/\/+$/, "");

if (!token || !supabaseUrl) {
  console.error("FAIL: SUPABASE_ACCESS_TOKEN and SUPABASE_URL are both required");
  process.exit(1);
}

const ref = new URL(supabaseUrl).hostname.split(".")[0];
const api = `https://api.supabase.com/v1/projects/${ref}/database/query`;

const sql = process.argv[2] ?? readFileSync(0, "utf8");
if (!sql.trim()) {
  console.error("usage: node scripts/db-query.mjs \"<sql>\"  (or pipe SQL on stdin)");
  process.exit(1);
}

const res = await fetch(api, {
  method: "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ query: sql }),
  signal: AbortSignal.timeout(60_000),
});

const text = await res.text();
if (!res.ok) {
  console.error(`HTTP ${res.status}`);
  console.error(text.slice(0, 2000));
  process.exit(1);
}

try {
  const parsed = JSON.parse(text);
  const rows = Array.isArray(parsed) ? parsed : (parsed.result ?? []);
  console.log(JSON.stringify(rows, null, 2));
} catch {
  console.log(text);
}

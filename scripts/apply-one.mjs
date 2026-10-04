/**
 * Apply ONE .sql file through the Management API, bypassing the migration runner.
 *
 * WHY THIS EXISTS: `npm run db:migrate` replays every staged migration from
 * 0000, and migration 0000 creates an obsolete unique index on
 * (college, roll_no) that live data legitimately violates — two participants at
 * one college bought under the same roll number. The runner therefore cannot
 * reach migration 0043 even though 0043 is a brand-new CREATE OR REPLACE.
 *
 * So new migrations are applied here, on their own, and the runner stays broken
 * until 0000 is fixed. Both run the identical SQL execution the dashboard does.
 *
 *   node scripts/apply-one.mjs supabase/migrations/<file>.sql
 */
import { readFileSync } from "node:fs";

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

const file = process.argv[2];
if (!file) {
  console.error("usage: node scripts/apply-one.mjs <path.sql>");
  process.exit(1);
}

const env = loadEnv(new URL("../.env", import.meta.url));
const token = process.env.SUPABASE_ACCESS_TOKEN || env.SUPABASE_ACCESS_TOKEN;
const supabaseUrl = (process.env.SUPABASE_URL || env.SUPABASE_URL || "").replace(/\/+$/, "");
if (!token) {
  console.error("FAIL: SUPABASE_ACCESS_TOKEN (sbp_…) missing — add it to .env");
  process.exit(1);
}
const ref = new URL(supabaseUrl).hostname.split(".")[0];
const api = `https://api.supabase.com/v1/projects/${ref}/database/query`;

const sql = readFileSync(file, "utf8");
console.log(`project=${ref}  file=${file}`);

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
  console.error(`FAIL: HTTP ${res.status}`);
  console.error(text.slice(0, 2000));
  process.exitCode = 1;
} else {
  console.log("ok");
  console.log(text.slice(0, 600));
}
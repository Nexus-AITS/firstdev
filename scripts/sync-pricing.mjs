/**
 * Sync the public.pricing table from the JS source of truth.
 *
 *   npm run db:sync-pricing                # add missing rows only
 *   npm run db:sync-pricing -- --overwrite # also correct prices that differ
 *
 * These are the REAL bundle and event prices, imported from the same
 * bundles.js / events.js the site has always used — not invented placeholders.
 * The purpose is to give `public.pricing` a starting state matching what is
 * already published, so a master can then change a price from the console
 * without a code change and redeploy.
 *
 * Default behaviour is deliberately insert-only. A sync that overwrote prices on
 * every run would silently undo a price a master had just changed, so
 * `--overwrite` must be asked for explicitly.
 */
import { readFileSync } from "node:fs";

/* ---------- read .env ---------- */
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

const overwrite = process.argv.includes("--overwrite");

/* ---------- parse the real prices out of the JS data files ---------- */

/**
 * The data files are ES modules built around literal object arrays, so a regex
 * is the honest way to read them here: importing them would need Vite's
 * import.meta, which plain Node does not have. Each pattern anchors on the key
 * it needs, so an unrelated `id:` elsewhere in the file cannot be matched.
 */
const bundlesSrc = readFileSync(new URL("../src/data/bundles.js", import.meta.url), "utf8");
const eventsSrc = readFileSync(new URL("../src/data/events.js", import.meta.url), "utf8");

const bundleEntries = [];
for (const block of bundlesSrc.split(/\n  \{/)) {
  const id = block.match(/\bid:\s*"([^"]+)"/)?.[1];
  const price = block.match(/\bprice:\s*"?(\d+)"?/)?.[1];
  if (id && price !== undefined) bundleEntries.push({ kind: "bundle", ref_id: id, price: Number(price) });
}

const eventEntries = [];
for (const block of eventsSrc.split(/\n  \{/)) {
  const id = block.match(/\bid:\s*"([^"]+)"/)?.[1];
  const payment = block.match(/\bpayment:\s*(\d+)/)?.[1];
  if (id && payment !== undefined) eventEntries.push({ kind: "event", ref_id: id, price: Number(payment) });
}

const entries = [...bundleEntries, ...eventEntries];
if (entries.length === 0) {
  console.error("FAIL: parsed no prices from bundles.js / events.js — has their shape changed?");
  process.exit(1);
}

const literal = (s) => `'${String(s).replace(/'/g, "''")}'`;

/* ---------- apply ---------- */

const values = entries.map((e) => `(${literal(e.kind)}, ${literal(e.ref_id)}, ${e.price})`).join(",\n     ");

const sql = overwrite
  ? `insert into public.pricing (kind, ref_id, price) values
     ${values}
     on conflict (kind, ref_id) do update
       set price = excluded.price, updated_at = now(), updated_by = 'db:sync-pricing';`
  : `insert into public.pricing (kind, ref_id, price) values
     ${values}
     on conflict (kind, ref_id) do nothing;`;

const res = await fetch(api, {
  method: "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ query: sql }),
  signal: AbortSignal.timeout(60_000),
});

if (!res.ok) {
  console.error(`FAIL: HTTP ${res.status}`);
  console.error((await res.text()).slice(0, 600));
  process.exit(1);
}

const verify = await fetch(api, {
  method: "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify({
    query:
      "select kind, count(*)::int as n, min(price)::int as lo, max(price)::int as hi " +
      "from public.pricing group by kind order by kind;",
  }),
  signal: AbortSignal.timeout(60_000),
});
const rows = await verify.json();

console.log(
  `parsed ${entries.length} real prices (${bundleEntries.length} bundles, ${eventEntries.length} events)`
);
console.log(overwrite ? "mode: OVERWRITE" : "mode: insert-only (existing prices untouched)");
for (const r of Array.isArray(rows) ? rows : (rows.result ?? [])) {
  console.log(`  ${r.kind}: ${r.n} rows, Rs ${r.lo}-${r.hi}`);
}
console.log("OK — public.pricing is populated");

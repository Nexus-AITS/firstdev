/**
 * Prove that a price edited in public.pricing actually reaches the public site.
 *
 * This exists because the pricing feature was shipped BROKEN and nothing caught
 * it. The database held the prices, the console could edit them, and the public
 * pages still showed the numbers compiled into the JavaScript bundle — because
 * nothing on the public side ever called loadPricing(), and the components
 * rendered `bundle.price` / `event.payment` instead of the DB-first accessors.
 * Every existing test passed, because they all asserted against those same
 * compiled-in constants.
 *
 * So this check does the only thing that could have caught it: it moves a real
 * price in the database and asserts the RENDERED page changes to match.
 *
 *   node scripts/verify-pricing.mjs
 *
 * Needs SUPABASE_ACCESS_TOKEN + SUPABASE_URL (Management API, to read the
 * current price and to restore it) and SUPABASE_ANON_KEY (to confirm the public
 * PostgREST read works for an anonymous visitor). The price is ALWAYS restored,
 * even when an assertion fails.
 */
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const BASE = process.env.VERIFY_BASE || "http://localhost:4173";

/**
 * The probe: a PUBLISHED event whose price is safe to move for the duration of a
 * test.
 *
 * An event rather than a bundle, and that switch is deliberate. This used to
 * probe bundle/bundled-349 on /bundled, which quietly made the whole check
 * depend on that one bundle staying published: a master withdrawing it left the
 * probe rendering nothing, `renderedPrice` returned null, and the test reported a
 * harness error instead of a verdict. Events are the surface that always has
 * something on it, and paradox-2065 is an individual, solo event — no team cap,
 * no squad semantics — so moving its price exercises the plain price path
 * without touching a bundle or a payment mode.
 */
const PROBE = { kind: "event", refId: "paradox-2065" };
/** The page that renders it, and the text that identifies its row. */
const PROBE_PATH = "/events/paradox";
const PROBE_TITLE = "PARADOX 2065";
/** A distinctive value, far from any real price, so a match cannot be a coincidence. */
const PROBE_PRICE = 4242;

let pass = 0;
let fail = 0;

function out(ok, label, detail = "") {
  if (ok) {
    pass += 1;
    console.log(`PASS  ${label}${detail ? `  |  ${detail}` : ""}`);
  } else {
    fail += 1;
    console.log(`FAIL  ${label}${detail ? `  |  ${detail}` : ""}`);
  }
}

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
const anonKey = process.env.SUPABASE_ANON_KEY || env.SUPABASE_ANON_KEY;

if (!token || !supabaseUrl) {
  console.error("FAIL: SUPABASE_ACCESS_TOKEN and SUPABASE_URL are both required");
  process.exit(1);
}
if (!anonKey) {
  console.error("FAIL: SUPABASE_ANON_KEY is required (the public read is the thing under test)");
  process.exit(1);
}

const ref = new URL(supabaseUrl).hostname.split(".")[0];
const api = `https://api.supabase.com/v1/projects/${ref}/database/query`;
const rest = `${supabaseUrl}/rest/v1`;

async function sql(query) {
  const res = await fetch(api, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`management API HTTP ${res.status}: ${text.slice(0, 300)}`);
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : (parsed.result ?? []);
}

async function setPrice(price) {
  await sql(
    `update public.pricing set price = ${Number(price)}, updated_at = now(), ` +
      `updated_by = 'verify:pricing' where kind = '${PROBE.kind}' and ref_id = '${PROBE.refId}';`
  );
}

/** What an anonymous visitor's PostgREST read returns — the public read path. */
async function publicPrice() {
  const res = await fetch(
    `${rest}/pricing?select=price&kind=eq.${PROBE.kind}&ref_id=eq.${PROBE.refId}&is_active=eq.true`,
    {
      headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` },
      signal: AbortSignal.timeout(30_000),
    }
  );
  if (!res.ok) throw new Error(`public pricing read HTTP ${res.status}`);
  const rows = await res.json();
  return Array.isArray(rows) && rows.length ? Number(rows[0].price) : null;
}

/**
 * The price as actually painted on the probe's realm page, read out of the DOM.
 *
 * Scoped to the probe's OWN card (the one naming PROBE_TITLE) rather than the
 * whole page, so an unrelated card happening to cost the same amount cannot
 * produce a false pass. Every card on a realm page carries a fee, so an
 * unscoped "first number on the page" match would pass by accident.
 */
async function renderedPrice(page) {
  await page.goto(`${BASE}${PROBE_PATH}`, { waitUntil: "domcontentloaded" });
  // The first paint deliberately shows the compiled fallback; the point of the
  // test is what the page shows AFTER the database answers, so give it time.
  await page.waitForTimeout(2500);
  const card = page.locator("article").filter({ hasText: PROBE_TITLE }).first();
  if ((await card.count()) === 0) return null;
  const text = await card.innerText();
  const m = text.replace(/,/g, "").match(/₹\s*(\d+)/);
  return m ? m[1] : null;
}


const original = await sql(
  `select price from public.pricing where kind = '${PROBE.kind}' and ref_id = '${PROBE.refId}';`
);
const originalPrice = original[0]?.price ?? null;

if (originalPrice == null) {
  console.error(
    `FAIL: no public.pricing row for ${PROBE.kind}/${PROBE.refId} — run "npm run db:sync-pricing" first`
  );
  process.exit(1);
}

console.log(`probe: ${PROBE.kind}/${PROBE.refId} is currently Rs ${originalPrice}`);
console.log(`target: ${BASE}${PROBE_PATH}\n`);

const browser = await chromium.launch();
let exitCode = 0;
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();

  /* --- 1. the public read path an anonymous visitor actually uses --- */
  const anonPrice = await publicPrice();
  out(anonPrice === originalPrice, "anonymous visitor can read public.pricing", `rest=${anonPrice}`);

  /* --- 2. baseline: the page shows the real, current price --- */
  const before = await renderedPrice(page);
  out(
    before === String(originalPrice),
    "the event page renders the current database price",
    `rendered=${before} db=${originalPrice}`
  );

  /* --- 3. THE regression test: move the price, expect the page to follow --- */
  await setPrice(PROBE_PRICE);
  const moved = await publicPrice();
  out(moved === PROBE_PRICE, "price change is visible to the public read", `rest=${moved}`);

  const after = await renderedPrice(page);
  out(
    after === String(PROBE_PRICE),
    "public page follows a price changed in the database",
    `rendered=${after} expected=${PROBE_PRICE}`
  );

  /* --- 4. an event fee too, not just a bundle --- */
  const eventRow = await sql(
    `select ref_id, price from public.pricing where kind = 'event' and ref_id = 'nexus-breach';`
  );
  const eventPrice = eventRow[0]?.price;
  if (eventPrice != null) {
    await sql(
      `update public.pricing set price = ${PROBE_PRICE}, updated_by = 'verify:pricing' ` +
        `where kind = 'event' and ref_id = 'nexus-breach';`
    );
    await page.goto(`${BASE}/events/nexus-breach`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    const shown = await page.getByText(`₹${PROBE_PRICE}`, { exact: true }).count();
    out(shown >= 1, "event detail fee follows the database", `matches=${shown}`);
    await sql(
      `update public.pricing set price = ${eventPrice}, updated_by = 'verify:pricing' ` +
        `where kind = 'event' and ref_id = 'nexus-breach';`
    );
  }

  await ctx.close();
} catch (err) {
  console.error(`FAIL  harness error: ${err?.message || err}`);
  exitCode = 1;
} finally {
  /* Always put the real price back — a failed assertion must not leave a
     fictional price on the public site. */
  await setPrice(originalPrice).catch((e) =>
    console.error(`FAIL  could not restore ${PROBE.refId}: ${e?.message || e}`)
  );
  await browser.close();
  const restored = await sql(
    `select price from public.pricing where kind = '${PROBE.kind}' and ref_id = '${PROBE.refId}';`
  );
  out(restored[0]?.price === originalPrice, "probe price restored", `now=${restored[0]?.price}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0 || exitCode !== 0) process.exitCode = 1;
else console.log("=== PUBLIC PRICING VERIFIED ===");

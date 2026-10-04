/**
 * Does the roster money strip follow the roster?
 *
 *   VERIFY_BASE=http://localhost:4173 node scripts/verify-finance-refresh.mjs
 *
 * THE QUESTION
 *
 * The FinanceStrip above the roster shows To verify / Received / Awaiting
 * reference / Rejected. An operator confirming a payment, or a colleague making a
 * change in another browser, presses the roster Refresh button to pick it up.
 * The obvious expectation is that the money moves too.
 *
 * THE ANSWER THIS SUITE FOUND: no.
 *
 * FinanceStrip has exactly one effect, `useEffect(load, [load])`, where `load`
 * closes over the session token. Nothing about a refresh reaches it - Admin
 * renders `<FinanceStrip token={session.token} />` and passes nothing else. So the
 * figures are fetched once, when the tab mounts, and never again for the life of
 * the session. The rows underneath refresh correctly, which is what makes this
 * easy to miss: the list is right and the money above it is stale.
 *
 * THE CONTROLS, because "the number did not change" proves nothing on its own
 *
 *   1. No-DB-change: two Refresh clicks with nothing changed must leave the
 *      figures alone. Without this, a figure that moves for its own reasons
 *      would be mistaken for evidence of refreshing.
 *   2. Row total: the pager count must go up by one. Row total moves and money
 *      does not is a DIFFERENT bug from "the refresh did nothing", and the
 *      difference matters.
 *   3. The probe is CLONED from a real row. An invented college_name is not in
 *      the colleges lookup, so the roster list never showed it while the money
 *      function - which reads the table directly - still counted it. That
 *      half-truth makes a wrong conclusion look right.
 */
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

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
const env = { ...loadEnv(new URL("../.env", import.meta.url)), ...process.env };
const BASE = process.env.VERIFY_BASE || "http://localhost:4173";
const STAMP = Date.now().toString(36);
const PROBE_NAME = "ZZ finance probe " + STAMP;
const PROBE_AMOUNT = 4242;

let failures = 0;
const out = (ok, label, detail = "") => {
  console.log("  " + (ok ? "PASS" : "FAIL") + "  " + label + (detail ? "  |  " + detail : ""));
  if (!ok) failures += 1;
};

/* Returns null on ANY failure, including a 400 carrying a JSON error body.

   The Management API answers a refused statement with HTTP 400 and a JSON
   `{ message }` payload. Parsing that and handing it back made every
   `inserted != null` assertion un-failable: the insert was being rejected by a
   CHECK constraint, the helper returned the error object, and the suite reported
   a probe it had never written. An assertion that cannot fail is worse than no
   assertion, because it converts a broken setup into a green run. */
const sql = async (query) => {
  if (!env.SUPABASE_ACCESS_TOKEN) return null;
  const ref = new URL(env.SUPABASE_URL).hostname.split(".")[0];
  const res = await fetch("https://api.supabase.com/v1/projects/" + ref + "/database/query", {
    method: "POST",
    headers: { Authorization: "Bearer " + env.SUPABASE_ACCESS_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  if (!res.ok) {
    console.log("        (sql refused: " + text.slice(0, 160) + ")");
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e && e.message ? e.message : e)));

/* The four figures, read from their data-finance hooks. */
const readMoney = () =>
  page.evaluate(() => {
    const acc = {};
    for (const el of document.querySelectorAll("[data-finance]")) {
      acc[el.dataset.finance] = el.innerText.replace(/\s+/g, " ").trim();
    }
    return acc;
  });

/* The pager "a-b of N". Found by climbing from the refresh button to the first
   ancestor whose text carries "of <n>". The case-insensitive flag is load
   bearing: the pager carries an `uppercase` class, so innerText is "1-25 OF 407"
   and a case-sensitive pattern returns null, which would leave every control
   silently vacuous. */
const readTotal = () =>
  page.evaluate(() => {
    let el = document.querySelector("#roster-refresh");
    while (el && el !== document.body) {
      const m = (el.innerText || "").match(/of\s+([\d,]+)/i);
      if (m) return Number(m[1].replace(/,/g, ""));
      el = el.parentElement;
    }
    return null;
  });

const openRoster = async () => {
  await page.locator("nav[aria-label=\"Console sections\"] button:has-text(\"Roster\")").click({ timeout: 20000 });
  await page.locator("#roster-refresh").waitFor({ timeout: 20000 });
  await page.waitForTimeout(1500);
};

console.log("=== FINANCE STRIP vs ROSTER REFRESH (UI) ===\n");

try {
  await page.goto(BASE + "/nexus-admin", { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.locator("input[name=\"username\"]").fill(env.SUPABASE_STAFF_EMAIL);
  await page.locator("input[name=\"password\"]").fill(env.SUPABASE_STAFF_PASSWORD);
  await page.locator("button[type=\"submit\"]").first().click();
  await page.locator("nav[aria-label=\"Console sections\"] button").first().waitFor({ timeout: 30000 });
  out(true, "signed in to the console", env.SUPABASE_STAFF_EMAIL);

  await openRoster();
  const figCount = await page.locator("[data-finance]").count();
  out(figCount >= 4, "the money strip is on the roster tab", figCount + " figures");

  const t0 = await readMoney();
  const n0 = await readTotal();
  out(n0 != null && t0["to-verify"] != null, "baseline read", "rows=" + n0 + "  " + t0["to-verify"]);

  /* CONTROL 1 - with nothing changed, two Refresh clicks must change nothing. */
  await page.locator("#roster-refresh").click();
  await page.waitForTimeout(1800);
  await page.locator("#roster-refresh").click();
  await page.waitForTimeout(1800);
  const t1 = await readMoney();
  const n1 = await readTotal();
  out(
    JSON.stringify(t0) === JSON.stringify(t1) && n0 === n1,
    "CONTROL 1: with no database change, Refresh leaves the figures alone",
    n0 + " -> " + n1
  );

  /* A real registration, cloned from a real row so it passes every filter. */
  const inserted = await sql(
    "insert into public.registrations " +
      "(name, roll_number, college_name, year, department, phone_number, email, " +
      "payment_status, payment_method, utr_number, purchase_amount, purchase_type, " +
      "purchase_ref, purchase_label) " +
      "select '" + PROBE_NAME + "', 'zzfin" + STAMP + "', college_name, year, department, " +
      "       phone_number, 'zz-fin-" + STAMP + "@example.invalid', 'unverified', 'utr'," +
      "       'ZZUTR" + STAMP + "', " + PROBE_AMOUNT + ", " +
      "       purchase_type, purchase_ref, purchase_label " +
      "  from public.registrations r " +
      " where r.payment_status = 'unverified' and r.payment_method = 'utr' " +
      "   and not exists (select 1 from public.event_catalogue ec" +
      "                where ec.id = r.purchase_ref and ec.requires_event_id) " +
      " order by r.created_at limit 1;"
  );
  out(inserted != null, "a probe registration of " + PROBE_AMOUNT + " is written to the database");

  /* The operator move: press Refresh. */
  await page.locator("#roster-refresh").click();
  await page.waitForTimeout(2500);

  const t2 = await readMoney();
  const n2 = await readTotal();

  /* CONTROL 2 - the row list really did pick it up. */
  out(
    n2 === n0 + 1,
    "CONTROL 2: the refresh DID pick up the new row, so the refresh works",
    n0 + " -> " + n2
  );

  const moved = Object.keys(t0).filter((k) => t0[k] !== t2[k]);
  out(
    moved.length > 0,
    "the money figures followed the refresh",
    moved.length
      ? moved.map((k) => k + ": " + t0[k] + " -> " + t2[k]).join("; ")
      : "NOTHING MOVED. before=" + t0["to-verify"] + "  after=" + t2["to-verify"]
  );
  const amount = (text) => {
    const m = String(text || "").match(/([\d,]+)/);
    return m ? Number(m[1].replace(/,/g, "")) : null;
  };
  const a0 = amount(t0["to-verify"]);
  const a2 = amount(t2["to-verify"]);
  out(
    a0 != null && a2 === a0 + PROBE_AMOUNT,
    "To verify rose by exactly the probe amount",
    a0 + " + " + PROBE_AMOUNT + " = " + a2 + "  shown: " + t2["to-verify"]
  );

  /* THE WORKAROUND. If leaving and returning does pick it up, that is the
     operator's answer today and it belongs in the report. */
  await page.locator("nav[aria-label=\"Console sections\"] button:has-text(\"Pricing\")").click();
  await page.waitForTimeout(1200);
  await openRoster();
  const t3 = await readMoney();
  const a3 = amount(t3["to-verify"]);
  out(
    a3 === a2,
    "and switching tabs and back does not lose it",
    "still " + t3["to-verify"]
  );

  out(errors.length === 0, "no uncaught errors", errors.join(" | "));
} finally {
  await sql("delete from public.registrations where name = '" + PROBE_NAME + "';");
  const left = await sql("select count(*)::int as n from public.registrations where name = '" + PROBE_NAME + "';");
  out(
    Array.isArray(left) && left[0] && left[0].n === 0,
    "the probe registration is gone",
    JSON.stringify(left)
  );
  await browser.close();
}

console.log(
  failures === 0
    ? "\n=== FINANCE REFRESH CHECKS PASSED ==="
    : "\n=== " + failures + " FINANCE REFRESH CHECK(S) FAILED ==="
);
process.exitCode = failures === 0 ? 0 : 1;







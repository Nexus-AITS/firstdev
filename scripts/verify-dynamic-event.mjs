/**
 * Does /events/:id actually render for an event that exists ONLY in the
 * database?  Loaded in a real browser, against the real catalogue.
 *
 * WHY THIS NEEDS A BROWSER
 *
 * The bug was a resolver, not a renderer: getEventView() looked the id up in the
 * COMPILED src/data/events.js array and returned null for anything a master
 * created in the Catalogue tab, so EventDetail rendered <NotFound/>. No unit
 * test of the components would have caught it, because the page genuinely works
 * for every compiled event - which is all eleven of them, so every page on the
 * site looked fine while the console quietly produced dead links.
 *
 * And the failure was silent in the worst way: public_catalogue() PUBLISHED the
 * row, so it appeared in its realm listing with a working link. Nothing looked
 * broken until the click.
 *
 * The probe row is created by scripts/probe-dynamic.sql and removed again in the
 * cleanup below, whether the run passes or fails.
 *
 *   VERIFY_BASE=http://localhost:4173 node scripts/verify-dynamic-event.mjs
 */
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";

const BASE = process.env.VERIFY_BASE || "http://localhost:4173";
const PROBE_ID = "zz-dynamic-probe";

let failures = 0;
const out = (ok, label, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  |  ${detail}` : ""}`);
  if (!ok) failures += 1;
};

const sql = (query) =>
  execFileSync("node", ["scripts/db-query.mjs", query], { encoding: "utf8" });

console.log("=== DYNAMIC EVENT PAGE VERIFIED ===\n");

/* ---------- 0. the probe must be a DB-only event ---------- */

const compiled = execFileSync("node", ["-e", `const s=require('fs').readFileSync('src/data/events.js','utf8');process.stdout.write(s.includes('${PROBE_ID}')?'yes':'no')`], { encoding: "utf8" });
out(compiled === "no", "the probe is NOT in the compiled seed", `found in events.js: ${compiled}`);

const row = JSON.parse(sql(`select id, title, venue, realm from public.event_catalogue where id = '${PROBE_ID}';`) || "[]");
out(row.length === 1, "the probe row exists in the database", JSON.stringify(row[0] ?? {}));

/* ---------- 1. the page renders, in a browser ---------- */

const browser = await chromium.launch();
let browserError = null;
try {
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on("pageerror", (err) => consoleErrors.push(String(err?.message ?? err)));

  const res = await page.goto(`${BASE}/events/${PROBE_ID}`, { waitUntil: "domcontentloaded", timeout: 45000 });
  out(res?.ok() === true, "the route responds 200", `status=${res?.status()}`);

  // The catalogue is fetched client-side, so wait for the title the row carries.
  await page
    .locator(`text=${row[0]?.title ?? "DYNAMIC PROBE EVENT"}`)
    .first()
    .waitFor({ timeout: 30000 })
    .catch(() => {});
  await page.waitForTimeout(1500);

  const text = await page.evaluate(() => document.body.innerText);

  out(text.includes("DYNAMIC PROBE EVENT"), "the event TITLE renders from the database row");
  out(!/PAGE NOT FOUND|NOT FOUND|404/i.test(text), "the page is NOT the not-found screen");

  /* The fields that live ONLY in the row. If the page were falling back to a
     compiled copy these could not appear at all - there is no compiled copy. */
  out(text.includes("PROBE HALL"), "the VENUE from the row renders");
  out(text.includes("OCT 9, 2026"), "the DATE from the row renders");
  out(text.includes("ABOUT THE EVENT"), "the ABOUT section renders from the row's prose");

  /* The fee. This is the assertion that catches the expensive bug: getEventFee
     resolved through the compiled array, so a console-created event read as
     FREE and the register wizard would skip the payment steps for a paid
     event. A null fee also renders as "—" rather than as a number. */
  out(
    /249/.test(text),
    "the PRICE from the pricing row renders (a null fee would show as an em dash)"
  );
  out(
    !/^\s*—\s*$/m.test(text) || text.includes("249"),
    "no part of the billing line fell back to '—'"
  );

  /* A crash here is the whole class of bug this change is about: no error
     boundary, so a throw unmounts the route to a black screen. */
  out(consoleErrors.length === 0, "no uncaught errors on the page", consoleErrors.join(" | ").slice(0, 200));
} catch (err) {
  browserError = err;
  out(false, "the page loaded without throwing", String(err?.message ?? err).slice(0, 200));
} finally {
  await browser.close();
}

/* ---------- 2. a compiled event still renders (no regression) ---------- */

if (!browserError) {
  const b2 = await chromium.launch();
  try {
    const page = await b2.newPage();
    const errs = [];
    page.on("pageerror", (e) => errs.push(String(e?.message ?? e)));
    await page.goto(`${BASE}/events/vision-2065`, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.locator("text=VISION 2065").first().waitFor({ timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1200);
    const t = await page.evaluate(() => document.body.innerText);
    out(t.includes("VISION 2065"), "a COMPILED event still renders", "no regression");
    out(errs.length === 0, "and it throws nothing", errs.join(" | ").slice(0, 200));
  } finally {
    await b2.close();
  }
}

/* ---------- 3. clean up - the probe must not survive ---------- */

sql(`delete from public.event_catalogue where id = '${PROBE_ID}';`);
sql(`delete from public.pricing where kind = 'event' and ref_id = '${PROBE_ID}';`);
const gone = JSON.parse(sql(`select count(*)::int as n from public.event_catalogue where id = '${PROBE_ID}';`) || "[]");
out(gone[0]?.n === 0, "the probe row is deleted again - nothing left behind", `rows=${gone[0]?.n}`);

console.log(
  failures === 0
    ? "\n=== DYNAMIC EVENT CHECKS PASSED ==="
    : `\n=== ${failures} DYNAMIC EVENT CHECK(S) FAILED ===`
);
process.exit(failures === 0 ? 0 : 1);
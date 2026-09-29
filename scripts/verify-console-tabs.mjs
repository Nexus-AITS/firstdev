/**
 * Open EVERY console tab as a master and assert none of them crashes.
 *
 *   node scripts/verify-console-tabs.mjs      (or: npm run verify:tabs)
 *   VERIFY_BASE=http://localhost:4173 node scripts/verify-console-tabs.mjs
 *
 * WHY THIS EXISTS
 *
 * A missing import does not fail the build. `roleCan` was used in
 * ContactManager.jsx without being imported, and Rollup was perfectly happy: to a
 * bundler an unresolved identifier is just a global, not an error. It worked
 * everywhere the tab was not rendered, so `npm run build` passed, the other
 * suites passed, and the only place it showed up was a master clicking CONTACTS,
 * where the tab threw on its first render, React unmounted the tree, and the
 * page went to a black screen.
 *
 * That is the failure mode this is here to catch: not "a test failed" but "a
 * whole screen is unreachable and the build is green". So it does not assert
 * content - it signs in, clicks every tab the master can see, and fails on any
 * uncaught page error or any tab that renders nothing. A crash is a crash
 * whichever assertion happened to be written for it.
 *
 * It is deliberately cheap: one sign-in, one click per tab, no fixtures. That is
 * what makes it likely to still be run when something else is on fire.
 */
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const BASE = process.env.VERIFY_BASE || "http://localhost:4173";

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
const username = process.env.SUPABASE_STAFF_EMAIL || env.SUPABASE_STAFF_EMAIL;
const password = process.env.SUPABASE_STAFF_PASSWORD || env.SUPABASE_STAFF_PASSWORD;
if (!username || !password) {
  console.error("FAIL: SUPABASE_STAFF_EMAIL / SUPABASE_STAFF_PASSWORD are required (a master account)");
  process.exit(1);
}

/* Errors collected per tab rather than globally, so a failure names the tab. */
let errors = [];
const collect = (e) => errors.push(`PAGEERROR ${e.message}`.slice(0, 220));
const noisy = /favicon|fonts\.g|Failed to load resource|net::ERR_|Download the React DevTools/i;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("pageerror", collect);
  page.on("console", (m) => {
    if (m.type() === "error" && !noisy.test(m.text())) errors.push(`CONSOLE ${m.text()}`.slice(0, 220));
  });

  await page.goto(`${BASE}/nexus-admin`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#staff-username", { timeout: 20000 });
  await page.fill("#staff-username", username);
  await page.fill("#staff-password", password);
  await page.click('#admin-signin button[type="submit"]');
  await page.waitForSelector('nav[aria-label="Console sections"] button', { timeout: 20000 });
  await page.waitForTimeout(3000);

  const tabs = await page.locator('nav[aria-label="Console sections"] button').allInnerTexts();
  out(tabs.length >= 1, "signed in and the console nav rendered", `tabs=${tabs.length}`);

  for (const tab of tabs) {
    const name = tab.trim();
    if (!name) continue;
    errors = [];

    await page.click(`nav[aria-label="Console sections"] button:has-text("${name}")`);
    // Long enough for the tab's data to land. A crash happens on the first
    // render, so this is about letting a healthy one finish loading, not about
    // waiting out a slow one.
    await page.waitForTimeout(2500);

    const body = await page
      .locator("body")
      .innerText()
      .catch(() => "");
    const rendered = body.replace(/\s+/g, " ").trim().length;
    // The blank-page tell: React unmounts the tree on an uncaught render error,
    // so the document keeps its <html> and <body> and loses everything inside.
    const blank = rendered < 40;

    out(
      !blank && errors.length === 0,
      `"${name}" renders without crashing`,
      blank ? "BLANK PAGE — the tree unmounted" : errors.join(" | ") || `${rendered} chars`
    );
  }
} catch (err) {
  fail += 1;
  console.log(`FAIL  suite aborted  |  ${String(err.message).slice(0, 300)}`);
} finally {
  await browser.close();
  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
}
process.exit(fail ? 1 : 0);

/**
 * Scroll-position regression checks: route transitions must land at the
 * TOP of the destination, never clamp to the bottom.
 * Run: node verify-scroll.mjs  (requires `npm run preview` on :4173)
 */
import { chromium } from "playwright";

const BASE = "http://localhost:4173";
let failures = 0;
const out = (ok, label, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  |  ${detail}` : ""}`);
};

const browser = await chromium.launch({ channel: "chrome" });

/* -------- ENTER NEXUS: bottom of home -> top of /events -------- */
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);
  await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: "instant" }));
  await page.waitForTimeout(900);
  const before = await page.evaluate(() => Math.round(window.scrollY));
  await page.getByRole("button", { name: /enter the nexus/i }).click();
  await page.waitForTimeout(7200); // full cinematic transition
  const path = new URL(page.url()).pathname;
  const after = await page.evaluate(() => Math.round(window.scrollY));
  out(
    path === "/events" && after <= 2 && errs.length === 0,
    "ENTER NEXUS lands at top",
    `from y=${before} -> ${path} scrollY=${after}${errs[0] ? ` err=${errs[0]}` : ""}`
  );
  await ctx.close();
}

/* -------- portal navigation: mid-events -> top of realm -------- */
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(BASE + "/events", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(900);
  await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: "instant" }));
  await page.waitForTimeout(500);
  const before = await page.evaluate(() => Math.round(window.scrollY));
  await page.locator('a[href="/events/paradox"]').first().click();
  await page.waitForTimeout(1400);
  const path = new URL(page.url()).pathname;
  const after = await page.evaluate(() => Math.round(window.scrollY));
  out(
    path === "/events/paradox" && after <= 2,
    "portal navigation lands at top",
    `from y=${before} -> ${path} scrollY=${after}`
  );
  await ctx.close();
}

/* -------- regular link: bottom of /events -> top of /about -------- */
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(BASE + "/events", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(900);
  await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: "instant" }));
  await page.waitForTimeout(500);
  await page.locator('header a[href="/about"], nav a[href="/about"]').first().click();
  await page.waitForTimeout(1400);
  const path = new URL(page.url()).pathname;
  const after = await page.evaluate(() => Math.round(window.scrollY));
  out(path === "/about" && after <= 2, "navbar link lands at top", `${path} scrollY=${after}`);
  await ctx.close();
}

await browser.close();
if (failures) {
  console.log(`\n=== ${failures} CHECK(S) FAILED ===`);
  process.exit(1);
}
console.log("\n=== ALL SCROLL CHECKS PASSED ===");
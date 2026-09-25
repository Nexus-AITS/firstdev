import { mkdirSync } from "node:fs";
mkdirSync("artifacts/screenshots", { recursive: true });
/** Element-level capture of the event meta strip (bypasses Lenis scroll drift). */
import { chromium } from "playwright";

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto("http://localhost:4173/events/nexus-breach", {
  waitUntil: "networkidle",
});
await page.waitForTimeout(3000);
const strip = page
  .locator('div.grid')
  .filter({ has: page.locator('p:text-is("Payment")') })
  .first();
await strip.scrollIntoViewIfNeeded();
await page.waitForTimeout(1200);
await strip.screenshot({ path: "artifacts/screenshots/pay-meta-strip.png" });
console.log("saved: pay-meta-strip.png");

const free = await page.goto("http://localhost:4173/events/free-fire", {
  waitUntil: "networkidle",
});
await page.waitForTimeout(2500);
const freeStrip = page
  .locator('div.grid')
  .filter({ has: page.locator('p:text-is("Payment")') })
  .first();
await freeStrip.scrollIntoViewIfNeeded();
await page.waitForTimeout(1000);
await freeStrip.screenshot({ path: "artifacts/screenshots/pay-meta-freefire.png" });
console.log("saved: pay-meta-freefire.png");

await browser.close();
console.log("done");
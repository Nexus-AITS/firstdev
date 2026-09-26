import { mkdirSync } from "node:fs";
mkdirSync("artifacts/screenshots", { recursive: true });
/**
 * Admin console captures for visual review.
 * Run: node scripts/shot-admin.mjs   (preview must run on :4173)
 */
import { chromium } from "playwright";

const browser = await chromium.launch({ channel: "chrome" });
const faults = [];

const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("console", (m) => {
  if (m.type() === "error") faults.push(`console.error: ${m.text()}`);
});
page.on("pageerror", (e) => faults.push(`pageerror: ${e.message}`));

await page.goto("http://localhost:4173/admin123456789", { waitUntil: "networkidle" });
await page.waitForTimeout(2500);
await page.screenshot({ path: "artifacts/screenshots/admin-hero.png" });

await page.locator("#admin-table-wrap").scrollIntoViewIfNeeded();
await page.waitForTimeout(1200);
await page.screenshot({ path: "artifacts/screenshots/admin-table.png" });

await page.getByRole("button", { name: "To review" }).click();
await page.waitForTimeout(700);
await page.screenshot({ path: "artifacts/screenshots/admin-review.png" });
await page.close();

const mob = await browser.newPage({ viewport: { width: 390, height: 844 } });
mob.on("pageerror", (e) => faults.push(`mobile pageerror: ${e.message}`));
await mob.goto("http://localhost:4173/admin123456789", { waitUntil: "networkidle" });
await mob.waitForTimeout(2500);
await mob.screenshot({ path: "artifacts/screenshots/admin-mob.png" });
await mob.close();

await browser.close();
console.log("screenshots saved: admin-hero, admin-table, admin-review, admin-mob");
console.log(
  faults.length ? `FAULTS:\n${faults.join("\n")}` : "no console errors / page errors"
);
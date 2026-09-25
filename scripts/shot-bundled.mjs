import { mkdirSync } from "node:fs";
mkdirSync("artifacts/screenshots", { recursive: true });
/**
 * Captures the Bundled page (hero, cards, footer, mobile) for visual review.
 * Run: node scripts/shot-bundled.mjs   (preview must run on :4173)
 */
import { chromium } from "playwright";

const browser = await chromium.launch({ channel: "chrome" });

const desktop = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const faults = [];
desktop.on("console", (m) => {
  if (m.type() === "error") faults.push(`console.error: ${m.text()}`);
});
desktop.on("pageerror", (e) => faults.push(`pageerror: ${e.message}`));

await desktop.goto("http://localhost:4173/bundled", { waitUntil: "networkidle" });
await desktop.waitForTimeout(3500);
await desktop.screenshot({ path: "artifacts/screenshots/bundled-hero.png" });

await desktop.evaluate(() => window.scrollTo(0, 820));
await desktop.waitForTimeout(1800);
await desktop.screenshot({ path: "artifacts/screenshots/bundled-cards.png" });

await desktop.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
await desktop.waitForTimeout(1800);
await desktop.screenshot({ path: "artifacts/screenshots/bundled-bottom.png" });
await desktop.close();

const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
mobile.on("console", (m) => {
  if (m.type() === "error") faults.push(`mobile console.error: ${m.text()}`);
});
mobile.on("pageerror", (e) => faults.push(`mobile pageerror: ${e.message}`));
await mobile.goto("http://localhost:4173/bundled", { waitUntil: "networkidle" });
await mobile.waitForTimeout(3000);
await mobile.screenshot({ path: "artifacts/screenshots/bundled-mobile.png" });
await mobile.close();

await browser.close();
console.log(
  "screenshots saved: bundled-hero.png, bundled-cards.png, bundled-bottom.png, bundled-mobile.png"
);
console.log(faults.length ? `FAULTS:\n${faults.join("\n")}` : "no console errors / page errors");
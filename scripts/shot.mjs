import { mkdirSync } from "node:fs";
mkdirSync("artifacts/screenshots", { recursive: true });
/**
 * Captures cinematic screenshots of the NEXUS hero for visual review.
 * Run: node shot.mjs   (preview must run on :4173)
 */
import { chromium } from "playwright";

const browser = await chromium.launch({ channel: "chrome" });

const desktop = await browser.newPage({ viewport: { width: 1440, height: 900 } });
// surface runtime faults (shader compile failures from new material features
// such as `dispersion` show up here and would otherwise render silently black)
const faults = [];
desktop.on("console", (m) => {
  if (m.type() === "error") faults.push(`console.error: ${m.text()}`);
});
desktop.on("pageerror", (e) => faults.push(`pageerror: ${e.message}`));
await desktop.goto("http://localhost:4173/", { waitUntil: "networkidle" });
await desktop.waitForTimeout(4000);
await desktop.screenshot({ path: "artifacts/screenshots/hero-desktop.png" });
// close crop of the crystal core for material inspection
await desktop.screenshot({ path: "artifacts/screenshots/hero-core.png", clip: { x: 460, y: 60, width: 520, height: 620 } });

// scrolled story state (crystal fragmented)
await desktop.evaluate(() => window.scrollTo(0, document.body.scrollHeight * 0.3));
await desktop.waitForTimeout(2500);
await desktop.screenshot({ path: "artifacts/screenshots/hero-story.png" });
await desktop.close();

const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
await mobile.goto("http://localhost:4173/", { waitUntil: "networkidle" });
await mobile.waitForTimeout(3500);
await mobile.screenshot({ path: "artifacts/screenshots/hero-mobile.png" });
await mobile.close();

await browser.close();
console.log("screenshots saved: hero-desktop.png, hero-story.png, hero-mobile.png");
console.log(faults.length ? `FAULTS:\n${faults.join("\n")}` : "no console errors / page errors");

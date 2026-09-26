import { mkdirSync } from "node:fs";
mkdirSync("artifacts/screenshots", { recursive: true });
/**
 * Captures the /events realm gateway for visual review:
 * the dark intro, the revealed composition, hover dominance and mobile.
 * Run: node shot-events.mjs   (preview must run on :4173)
 */
import { chromium } from "playwright";

const browser = await chromium.launch({ channel: "chrome" });
const faults = [];

const desktop = await browser.newPage({ viewport: { width: 1440, height: 900 } });
desktop.on("console", (m) => {
  if (m.type() === "error") faults.push(`console.error: ${m.text()}`);
});
desktop.on("pageerror", (e) => faults.push(`pageerror: ${e.message}`));

await desktop.goto("http://localhost:4173/events", { waitUntil: "domcontentloaded" });
await desktop.waitForTimeout(700); // mid-darkness intro
await desktop.screenshot({ path: "artifacts/screenshots/events-intro.png" });

await desktop.waitForTimeout(3600); // fully revealed
await desktop.screenshot({ path: "artifacts/screenshots/events-desktop.png" });

// hover dominance: focus NEXUS REBUILDERS
const forge = desktop.locator('main a[href="/events/forge"]');
await forge.hover();
await desktop.waitForTimeout(1400);
await desktop.screenshot({ path: "artifacts/screenshots/events-hover-forge.png" });

// scroll to the Arena station (lower depth layer)
await desktop.evaluate(() => window.scrollTo(0, 1150));
await desktop.waitForTimeout(1600);
await desktop.screenshot({ path: "artifacts/screenshots/events-scrolled.png" });
await desktop.close();

const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
await mobile.goto("http://localhost:4173/events", { waitUntil: "domcontentloaded" });
await mobile.waitForTimeout(4200);
await mobile.screenshot({ path: "artifacts/screenshots/events-mobile.png", fullPage: false });
await mobile.close();

await browser.close();
console.log("saved: events-intro.png, events-desktop.png, events-hover-forge.png, events-scrolled.png, events-mobile.png");
console.log(faults.length ? `FAULTS:\n${faults.join("\n")}` : "no console errors / page errors");

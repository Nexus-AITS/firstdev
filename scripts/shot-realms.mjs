import { mkdirSync } from "node:fs";
mkdirSync("artifacts/screenshots", { recursive: true });
/**
 * Captures the realm pages (Forge / Paradox / Arena) for visual review:
 * staged header reveal, hero crystal, crystalline event objects.
 * Run: node shot-realms.mjs   (preview must run on :4173)
 */
import { chromium } from "playwright";

const browser = await chromium.launch({ channel: "chrome" });
const faults = [];
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("console", (m) => {
  if (m.type() === "error") faults.push(`console.error: ${m.text()}`);
});
page.on("pageerror", (e) => faults.push(`pageerror: ${e.message}`));

for (const realm of ["forge", "paradox", "arena"]) {
  await page.goto(`http://localhost:4173/events/${realm}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2600);
  await page.screenshot({ path: `artifacts/screenshots/realm-${realm}-top.png` });
  await page.evaluate(() => window.scrollTo(0, 950));
  await page.waitForTimeout(1400);
  await page.screenshot({ path: `artifacts/screenshots/realm-${realm}-events.png` });
}

await page.close();
await browser.close();
console.log("saved: realm-{forge,paradox,arena}-{top,events}.png");
console.log(faults.length ? `FAULTS:\n${faults.join("\n")}` : "no console errors / page errors");

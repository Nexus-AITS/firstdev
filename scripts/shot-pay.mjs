import { mkdirSync } from "node:fs";
mkdirSync("artifacts/screenshots", { recursive: true });
/**
 * Captures payment / max-size surfaces for visual review.
 * Run: node scripts/shot-pay.mjs   (preview must run on :4173)
 */
import { chromium } from "playwright";

const browser = await chromium.launch({ channel: "chrome" });
const faults = [];

const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("console", (m) => {
  if (m.type() === "error") faults.push(`console.error: ${m.text()}`);
});
page.on("pageerror", (e) => faults.push(`pageerror: ${e.message}`));

// event detail — 5-cell meta strip with the Payment cell
await page.goto("http://localhost:4173/events/nexus-breach", {
  waitUntil: "networkidle",
});
await page.waitForTimeout(3000);
await page.evaluate(() => window.scrollTo(0, 740));
await page.waitForTimeout(1500);
await page.screenshot({ path: "artifacts/screenshots/pay-detail-meta.png" });

// CTA — billing line with ₹ + max size
await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
await page.waitForTimeout(1500);
await page.screenshot({ path: "artifacts/screenshots/pay-detail-cta.png" });

// register wizard — step 1: details (with fee strip + context)
await page.goto("http://localhost:4173/register?event=nexus-breach", {
  waitUntil: "networkidle",
});
await page.waitForTimeout(2200);
await page.screenshot({ path: "artifacts/screenshots/pay-register-details.png" });

// step 2: payment QR
await page.fill("#reg-name", "Sample Participant");
await page.fill("#reg-roll", "24S00A0001");
await page.fill("#reg-college", "AITS Tirupati");
await page.selectOption("#reg-year", "2nd");
await page.fill("#reg-dept", "CSE");
await page.fill("#reg-phone", "9000000000");
await page.fill("#reg-email", "sample.participant@example.com");
await page.click("#reg-details-next");
await page.waitForTimeout(900);
await page.screenshot({ path: "artifacts/screenshots/pay-register-qr.png" });

// step 3: UTR field
await page.click("#reg-pay-next");
await page.waitForTimeout(700);
await page.screenshot({ path: "artifacts/screenshots/pay-register-utr.png" });
await page.close();

// forge rows with price lines
const forge = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await forge.goto("http://localhost:4173/events/forge", {
  waitUntil: "networkidle",
});
await forge.waitForTimeout(3000);
await forge.evaluate(() => window.scrollTo(0, 860));
await forge.waitForTimeout(1500);
await forge.screenshot({ path: "artifacts/screenshots/pay-forge.png" });
await forge.close();

// paradox cards with price lines
const para = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await para.goto("http://localhost:4173/events/paradox", {
  waitUntil: "networkidle",
});
await para.waitForTimeout(3000);
await para.evaluate(() => window.scrollTo(0, 760));
await para.waitForTimeout(1500);
await para.screenshot({ path: "artifacts/screenshots/pay-paradox.png" });
await para.close();

// mobile — meta strip tail-cell span check
const mob = await browser.newPage({ viewport: { width: 390, height: 844 } });
mob.on("pageerror", (e) => faults.push(`mobile pageerror: ${e.message}`));
await mob.goto("http://localhost:4173/events/nexus-breach", {
  waitUntil: "networkidle",
});
await mob.waitForTimeout(3000);
await mob.evaluate(() => window.scrollTo(0, 640));
await mob.waitForTimeout(1500);
await mob.screenshot({ path: "artifacts/screenshots/pay-detail-mob.png" });
await mob.close();

await browser.close();
console.log(
  "screenshots saved: pay-detail-meta, pay-detail-cta, pay-register-details, pay-register-qr, pay-register-utr, pay-forge, pay-paradox, pay-detail-mob"
);
console.log(
  faults.length ? `FAULTS:\n${faults.join("\n")}` : "no console errors / page errors"
);
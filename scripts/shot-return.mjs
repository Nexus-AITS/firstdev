import { mkdirSync } from "node:fs";
mkdirSync("artifacts/screenshots", { recursive: true });
import { chromium } from "playwright";

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto("http://localhost:4173/events/forge", { waitUntil: "networkidle" });
await page.waitForTimeout(1800);
await page.screenshot({ path: "artifacts/screenshots/ret-top.png" });
await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
await page.waitForTimeout(1600);
await page.screenshot({ path: "artifacts/screenshots/ret-bottom.png" });
console.log("done");
await browser.close();

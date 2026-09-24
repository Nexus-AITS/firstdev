import { mkdirSync } from "node:fs";
mkdirSync("artifacts/screenshots", { recursive: true });
import { chromium } from "playwright";

const BASE = "http://localhost:4173";
const EVENTS = [
  "nexus-breach",
  "vision-2065",
  "circuits-of-nexus",
  "ai-turing-gambit",
  "code-rebuilding",
  "the-scientist-files",
  "paradox-2065",
  "matrix",
  "pixel-resistance",
  "free-fire",
];

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

for (const slug of EVENTS) {
  await page.goto(`${BASE}/events/${slug}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1700);
  await page.screenshot({
    path: `artifacts/screenshots/sig-${slug}.png`,
    clip: { x: 740, y: 70, width: 660, height: 700 },
  });
  console.log(`captured ${slug}`);
}

for (const realm of ["forge", "paradox", "arena"]) {
  await page.goto(`${BASE}/events/${realm}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  await page.evaluate(() => {
    const el = document.getElementById("events");
    if (el) el.scrollIntoView();
  });
  await page.waitForTimeout(1400);
  await page.screenshot({ path: `artifacts/screenshots/rs-${realm}.png` });
  console.log(`captured realm ${realm}`);
}

console.log("console errors:", errors.length);
await browser.close();

import { mkdirSync } from "node:fs";
mkdirSync("artifacts/screenshots", { recursive: true });
import { chromium } from "playwright";

const BASE = "http://localhost:4173";
const browser = await chromium.launch({ channel: "chrome" });
const errors = [];

const desk = await browser.newPage({ viewport: { width: 1440, height: 900 } });
desk.on("console", (m) => m.type() === "error" && errors.push(m.text()));

/* 1 â€” realm header type badge */
await desk.goto(`${BASE}/events/forge`, { waitUntil: "networkidle" });
await desk.waitForTimeout(1700);
await desk.screenshot({ path: "artifacts/screenshots/type-realm-header.png" });

/* 2 â€” event detail hero badge */
await desk.goto(`${BASE}/events/nexus-breach`, { waitUntil: "networkidle" });
await desk.waitForTimeout(1500);
await desk.screenshot({ path: "artifacts/screenshots/type-detail-hero.png" });

/* 3 â€” forge row badge */
await desk.evaluate(() => {
  document.querySelectorAll("article")[0]?.scrollIntoView({ block: "center" });
});
await desk.waitForTimeout(1300);
await desk.screenshot({ path: "artifacts/screenshots/type-forge-row.png" });

/* 4 â€” paradox card badge */
await desk.goto(`${BASE}/events/paradox`, { waitUntil: "networkidle" });
await desk.waitForTimeout(900);
await desk.evaluate(() => window.scrollBy(0, 900));
await desk.waitForTimeout(1400);
await desk.screenshot({ path: "artifacts/screenshots/type-paradox-card.png" });

/* 5 â€” arena rows badge */
await desk.goto(`${BASE}/events/arena`, { waitUntil: "networkidle" });
await desk.waitForTimeout(900);
await desk.evaluate(() => window.scrollBy(0, 950));
await desk.waitForTimeout(1400);
await desk.screenshot({ path: "artifacts/screenshots/type-arena-rows.png" });

/* 6 â€” gateway station badge */
await desk.goto(`${BASE}/events`, { waitUntil: "networkidle" });
await desk.waitForTimeout(3400);
await desk.evaluate(() => window.scrollBy(0, 500));
await desk.waitForTimeout(1200);
await desk.screenshot({ path: "artifacts/screenshots/type-gateway.png" });

/* 7 â€” mobile overflow check (longest category) */
const mob = await browser.newPage({ viewport: { width: 375, height: 812 } });
mob.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await mob.goto(`${BASE}/events/paradox-2065`, { waitUntil: "networkidle" });
await mob.waitForTimeout(1500);
const overflow = await mob.evaluate(
  () => document.documentElement.scrollWidth - document.documentElement.clientWidth
);
await mob.screenshot({ path: "artifacts/screenshots/type-mobile.png" });
console.log("mobile horizontal overflow px:", overflow);

console.log("console errors:", errors.length);
await browser.close();

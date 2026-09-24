/**
 * Performance probe: measures FPS + long tasks on Home (idle + during
 * wheel-scroll), then verifies reload behaviour (land at top, no stuck
 * scroll). Run: npm run build && npm run preview, then `node scripts/perf.mjs`.
 */
import { chromium } from "playwright";

const BASE = "http://localhost:4173";
const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const faults = [];
page.on("pageerror", (e) => faults.push(e.message));

await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(3500); // let lazy WebGL mount + warm up

const sample = (ms) =>
  page.evaluate(
    (dur) =>
      new Promise((resolve) => {
        const longTasks = [];
        try {
          new PerformanceObserver((list) => {
            for (const e of list.getEntries()) if (e.duration > 80) longTasks.push(Math.round(e.duration));
          }).observe({ entryTypes: ["longtask"] });
        } catch {
          /* unsupported */
        }
        let frames = 0;
        const t0 = performance.now();
        const tick = (t) => {
          frames += 1;
          if (t - t0 < dur) requestAnimationFrame(tick);
          else resolve({ fps: Math.round((frames * 1000) / (t - t0)), longTasks });
        };
        requestAnimationFrame(tick);
      }),
    ms
  );

const idle = await sample(3000);

// scroll sample: wheel through the story while measuring
const scrollPromise = sample(4000);
for (let i = 0; i < 26; i++) {
  await page.mouse.wheel(0, 420);
  await page.waitForTimeout(140);
}
const duringScroll = await scrollPromise;

// reload behaviour: land at top, scroll usable
await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(1500);
await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
await page.waitForTimeout(400);
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForTimeout(2500);
const afterReload = await page.evaluate(() => ({
  y: Math.round(window.scrollY),
  h1: document.querySelector("h1")?.textContent?.slice(0, 30) || "",
}));
// can we scroll after reload?
await page.mouse.wheel(0, 600);
await page.waitForTimeout(600);
const scrollAfter = await page.evaluate(() => Math.round(window.scrollY));

console.log(`idle FPS:            ${idle.fps}  (long tasks >80ms: ${idle.longTasks.length ? idle.longTasks.join(",") : "none"})`);
console.log(`scroll FPS:          ${duringScroll.fps}  (long tasks >80ms: ${duringScroll.longTasks.length ? duringScroll.longTasks.join(",") : "none"})`);
console.log(`reload -> scrollY:   ${afterReload.y}  h1="${afterReload.h1}"`);
console.log(`wheel after reload:  scrollY=${scrollAfter} (should be > 0)`);
if (faults.length) console.log(`page errors:         ${faults.join(" | ")}`);

const ok =
  idle.longTasks.length === 0 &&
  afterReload.y <= 2 &&
  scrollAfter > 0 &&
  faults.length === 0;
console.log(ok ? "\n=== PERF CHECK PASSED ===" : "\n=== PERF CHECK FAILED ===");
await browser.close();
process.exit(ok ? 0 : 1);

/**
 * Performance probe: for each profile — desktop 1440×900 @dpr1 and
 * mobile 390×844 @dpr3 with touch — measures FPS + long tasks on Home
 * (idle + during wheel-scroll), then verifies reload behaviour (land at
 * top, no stuck scroll). Run: npm run build && npm run preview, then
 * `node scripts/perf.mjs`.
 */
import { chromium } from "playwright";

const BASE = "http://localhost:4173";

const PROFILES = [
  { name: "desktop", viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false, warmup: 3500 },
  // DPR 3 is the fill-cost worst case of a modern phone; even on the host
  // GPU it exercises the mobile tier path (particle/crystal DPR caps 1.2,
  // low quality, reduced fragment and particle counts).
  { name: "mobile", viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, warmup: 5000 },
];

const sample = (page, ms) =>
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

async function runProfile(browser, profile) {
  const faults = [];
  const page = await browser.newPage({
    viewport: profile.viewport,
    deviceScaleFactor: profile.deviceScaleFactor,
    isMobile: profile.isMobile,
    hasTouch: profile.hasTouch,
  });
  page.on("pageerror", (e) => faults.push(e.message));

  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(profile.warmup); // let lazy WebGL mount + warm up

  const idle = await sample(page, 3000);

  // scroll sample: wheel through the story while measuring
  const scrollPromise = sample(page, 4000);
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

  await page.close();

  const ok =
    idle.longTasks.length === 0 &&
    afterReload.y <= 2 &&
    scrollAfter > 0 &&
    faults.length === 0;
  return { idle, duringScroll, afterReload, scrollAfter, faults, ok };
}

const browser = await chromium.launch({ channel: "chrome" });
let allOk = true;
for (const profile of PROFILES) {
  const r = await runProfile(browser, profile);
  const tag = `[${profile.name}]`;
  console.log(`${tag} idle FPS:            ${r.idle.fps}  (long tasks >80ms: ${r.idle.longTasks.length ? r.idle.longTasks.join(",") : "none"})`);
  console.log(`${tag} scroll FPS:          ${r.duringScroll.fps}  (long tasks >80ms: ${r.duringScroll.longTasks.length ? r.duringScroll.longTasks.join(",") : "none"})`);
  console.log(`${tag} reload -> scrollY:   ${r.afterReload.y}  h1="${r.afterReload.h1}"`);
  console.log(`${tag} wheel after reload:  scrollY=${r.scrollAfter} (should be > 0)`);
  if (r.faults.length) console.log(`${tag} page errors:         ${r.faults.join(" | ")}`);
  console.log(`${tag} ${r.ok ? "PROFILE PASSED" : "PROFILE FAILED"}`);
  console.log("");
  allOk = allOk && r.ok;
}
await browser.close();
console.log(allOk ? "=== PERF CHECK PASSED ===" : "=== PERF CHECK FAILED ===");
process.exit(allOk ? 0 : 1);

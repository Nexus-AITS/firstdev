/**
 * Long-task timeline probe (CPU-only, no network throttle).
 *
 *   node scripts/longtask-probe.mjs [url] [seconds]
 *
 * Answers one question Lighthouse's single TBT number cannot: *when* is the
 * main thread blocked? The hero is a WebGL scene that keeps animating after
 * load, so TBT can come either from the one-off boot (parse three.js, build the
 * cluster, compile shaders) or from the steady-state render loop. The buckets
 * below separate the two: TBT-style excess-over-50ms, per second, plus the
 * longest task in each second.
 *
 * 4x CPU throttling matches Lighthouse's mobile preset; the network is left
 * unthrottled so the timeline is CPU-bound and easy to read.
 */
import { chromium } from "playwright";

const URL = process.argv[2] || "http://localhost:4173/";
const SECONDS = Number(process.argv[3] || 14);

const browser = await chromium.launch({ channel: "chrome" });
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  userAgent:
    "Mozilla/5.0 (Linux; Android 11; Moto G Power) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36",
});
const page = await context.newPage();
const client = await context.newCDPSession(page);
await client.send("Emulation.setCPUThrottlingRate", { rate: 4 });

await page.addInitScript(() => {
  window.__lt = [];
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) window.__lt.push([Math.round(e.startTime), Math.round(e.duration)]);
    }).observe({ entryTypes: ["longtask"] });
  } catch {
    /* unsupported */
  }
});

await page.goto(URL, { waitUntil: "load", timeout: 90000 });

const snapshots = [];
for (let s = 1; s <= SECONDS; s++) {
  await page.waitForTimeout(1000);
  snapshots.push(await page.evaluate(() => (window.__lt || []).slice()));
}

const buckets = [];
let prev = [];
for (let i = 0; i < snapshots.length; i++) {
  const fresh = snapshots[i].slice(prev.length);
  const tbt = fresh.reduce((a, [, d]) => a + Math.max(0, d - 50), 0);
  const longest = fresh.reduce((m, [, d]) => Math.max(m, d), 0);
  buckets.push({ second: i + 1, tasks: fresh.length, tbt: Math.round(tbt), longest });
  prev = snapshots[i];
}

console.log(JSON.stringify({ url: URL, cpuThrottle: 4, buckets }, null, 2));
console.log("");
console.log("second | tasks | TBT ms | longest");
for (const b of buckets) {
  console.log(`${String(b.second).padStart(6)} | ${String(b.tasks).padStart(5)} | ${String(b.tbt).padStart(6)} | ${b.longest}`);
}
const total = buckets.reduce((a, b) => a + b.tbt, 0);
const early = buckets.filter((b) => b.second <= 6).reduce((a, b) => a + b.tbt, 0);
console.log(`\ntotal TBT ${total} ms | first 6 s ${early} ms (${Math.round((early / total) * 100)}%) | after 6 s ${total - early} ms`);

await browser.close();

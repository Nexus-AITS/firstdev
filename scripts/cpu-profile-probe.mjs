/**
 * Boot CPU profile probe (CPU-only, no network throttle).
 *
 *   node scripts/cpu-profile-probe.mjs [url] [seconds]
 *
 * The long-task timeline (scripts/longtask-probe.mjs) shows every long task on
 * the home page happens in the first second — so TBT is a single boot burst,
 * not the render loop. This probe points at *what* that burst is: a CDP CPU
 * profile, aggregated by self time, top offenders first, with the owning
 * chunk printed so a "three.js" cost can be told apart from app code.
 *
 * 4x CPU throttling matches Lighthouse's mobile preset.
 */
import { chromium } from "playwright";

const URL = process.argv[2] || "http://localhost:4173/";
const SECONDS = Number(process.argv[3] || 9);

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
await client.send("Profiler.enable");
await client.send("Profiler.setSamplingInterval", { interval: 250 });
await client.send("Profiler.start");

await page.goto(URL, { waitUntil: "load", timeout: 90000 });
await page.waitForTimeout(SECONDS * 1000);
const { profile } = await client.send("Profiler.stop");

const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const self = new Map();
let total = 0;
for (let i = 0; i < profile.samples.length; i++) {
  const node = byId.get(profile.samples[i]);
  if (!node) continue;
  const cf = node.callFrame;
  const us = profile.timeDeltas[i] || 0;
  total += us;
  const url = (cf.url || "").replace(/^https?:\/\/[^/]+/, "");
  const file = url ? url.split("/").pop().split("?")[0] : "(native)";
  const key = `${cf.functionName || "(anonymous)"} @ ${file}:${cf.lineNumber + 1}`;
  self.set(key, (self.get(key) || 0) + us);
}

const rows = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 28);
const ms = (us) => Math.round(us / 1000);

console.log(`\n===== CPU profile: ${URL} (4x CPU, ${SECONDS}s) =====`);
console.log(`profiled ${ms(total)} ms of CPU\n`);
console.log("self ms | %    | function @ file:line");
for (const [key, us] of rows) {
  console.log(`${String(ms(us)).padStart(7)} | ${String(((us / total) * 100).toFixed(1)).padStart(4)} | ${key}`);
}

// Roll the same samples up per file so chunk-level cost is obvious.
const perFile = new Map();
for (const [key, us] of self) {
  const file = key.split(" @ ")[1].split(":")[0];
  perFile.set(file, (perFile.get(file) || 0) + us);
}
console.log("\nself ms | file");
for (const [file, us] of [...perFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log(`${String(ms(us)).padStart(7)} | ${file}`);
}
console.log("");

await browser.close();

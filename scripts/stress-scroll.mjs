/** Stress: ENTER NEXUS must land at top on every run (sampled continuously). */
import { chromium } from "playwright";

const BASE = "http://localhost:4173";
const browser = await chromium.launch({ channel: "chrome" });
let failures = 0;

async function runOnce(i, { reduced = false } = {}) {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    ...(reduced ? { reducedMotion: "reduce" } : {}),
  });
  const page = await ctx.newPage();
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(reduced ? 900 : 1500);
  await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: "instant" }));
  await page.waitForTimeout(700);
  const before = await page.evaluate(() => Math.round(window.scrollY));
  await page.getByRole("button", { name: /enter the nexus/i }).click();

  // sample scroll every ~300ms for ~11s to catch any LATE jump to bottom
  const trace = [];
  let peak = 0;
  for (let t = 0; t < 37; t++) {
    const { s, path } = await page.evaluate(() => ({
      s: Math.round(window.scrollY),
      path: location.pathname,
    }));
    if (s > peak) peak = s;
    trace.push(`${path}@${s}`);
    await page.waitForTimeout(300);
  }
  const finalPath = new URL(page.url()).pathname;
  const final = await page.evaluate(() => Math.round(window.scrollY));
  const ok = finalPath === "/events" && final <= 2;
  if (!ok) failures += 1;
  console.log(
    `${ok ? "PASS" : "FAIL"}  run${i}${reduced ? " (reduced-motion)" : ""}  from y=${before} -> ${finalPath}@${final} peakAfterClick=${peak}`
  );
  if (!ok) console.log(`       trace: ${trace.join(" ")}`);
  await ctx.close();
}

for (let i = 1; i <= 3; i++) await runOnce(i);
await runOnce(4, { reduced: true });

await browser.close();
if (failures) {
  console.log(`\n=== ${failures} STRESS RUN(S) FAILED ===`);
  process.exit(1);
}
console.log("\n=== ALL STRESS RUNS PASSED ===");
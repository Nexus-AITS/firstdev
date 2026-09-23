import { mkdirSync } from "node:fs";
mkdirSync("artifacts/screenshots", { recursive: true });
/** Assert real event data from nexus 65.docx renders on every detail page. */
import { chromium } from "playwright";

const BASE = "http://localhost:4173";
const CHECKS = [
  ["/events/nexus-breach", ["OCT 5 â€” 6, 2026", "LABS Aâ€“E", "RJ45", "valedictory"]],
  ["/events/vision-2065", ["OCT 5, 2026", "CLASS ROOMS", "Advance registration"]],
  ["/events/circuits-of-nexus", ["OCT 5, 2026", "GROUND FLOOR", "materials and circuits"]],
  ["/events/ai-turing-gambit", ["OCT 6, 2026", "2 CLASSROOMS", "NEXUS AI"]],
  ["/events/code-rebuilding", ["OCT 6, 2026", "LABS D & E", "corrupted code"]],
  ["/events/the-scientist-files", ["OCT 6, 2026", "COLLEGE PREMISES", "three fictional case files"]],
  ["/events/paradox-2065", ["OCT 6, 2026", "E-BLOCK CLASSROOM", "What If?"]],
  ["/events/shutter-quest", ["OCT 6, 2026", "AI-generated"]],
  ["/events/matrix", ["OCT 6, 2026", "10:00 AM â€“ 12:30 PM"]],
  ["/events/pixel-resistance", ["OCT 6, 2026", "2 CLASSROOMS", "plagiarism"]],
  ["/events/neon-vanguard", ["AFTER COLLEGE HOURS"]],
  ["/events/velocity-rift", ["AFTER COLLEGE HOURS"]],
  ["/events/titan-protocol", ["AFTER COLLEGE HOURS"]],
];

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errs = [];
page.on("pageerror", (e) => errs.push(e.message));
let failures = 0;

for (const [route, expects] of CHECKS) {
  await page.goto(BASE + route, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(650);
  const text = await page.evaluate(() => document.body.innerText);
  const missing = expects.filter((s) => !text.includes(s));
  const ok = missing.length === 0;
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${route}${ok ? "" : `  missing: ${missing.join(" | ")}`}`);
}

// visual confirmation of a detail page with the new data
await page.goto(BASE + "/events/nexus-breach", { waitUntil: "networkidle" });
await page.waitForTimeout(1600);
await page.screenshot({ path: "artifacts/screenshots/detail-data-shot.png" });

await browser.close();
if (errs.length) console.log("PAGE ERRORS:", errs.join(" | "));
if (failures) {
  console.log(`\n=== ${failures} DATA CHECK(S) FAILED ===`);
  process.exit(1);
}
console.log("\n=== ALL EVENT DATA CHECKS PASSED ===");
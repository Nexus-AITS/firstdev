import { mkdirSync } from "node:fs";
mkdirSync("artifacts/screenshots", { recursive: true });
/** Assert real event data from nexus 65.docx renders on every detail page. */
import { chromium } from "playwright";
import { events, formatFee, getEventFields } from "../src/data/events.js";

// Overridable: vite preview silently falls back to another port when 4173 is
// taken, and asserting data against the wrong build proves nothing.
const BASE = process.env.VERIFY_BASE || "http://localhost:4173";
const CHECKS = [
  ["/events/nexus-breach", ["OCT 5 — 6, 2026", "LABS A–E", "RJ45", "valedictory"]],
  ["/events/vision-2065", ["OCT 5, 2026", "CLASS ROOMS", "Advance registration"]],
  ["/events/circuits-of-nexus", ["OCT 7, 2026", "GROUND FLOOR", "materials and circuits"]],
  ["/events/ai-turing-gambit", ["OCT 6, 2026", "2 CLASSROOMS", "NEXUS AI"]],
  ["/events/code-rebuilding", ["OCT 6, 2026", "LABS D & E", "corrupted code"]],
  ["/events/the-scientist-files", ["OCT 6, 2026", "COLLEGE PREMISES", "three fictional case files"]],
  ["/events/paradox-2065", ["OCT 6, 2026", "E-BLOCK CLASSROOM", "What If?"]],
  ["/events/shutter-quest", ["OCT 6, 2026", "AI-generated"]],
  ["/events/matrix", ["OCT 6, 2026", "10:00 AM – 12:30 PM"]],
  ["/events/pixel-resistance", ["OCT 6, 2026", "2 CLASSROOMS", "plagiarism"]],
  ["/events/free-fire", ["AFTER COLLEGE HOURS", "FREE FIRE", "MAIN STAGE"]],
];

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errs = [];
page.on("pageerror", (e) => errs.push(e.message));
let failures = 0;

/* ---------- catalogue invariants, checked without a browser ----------
 *
 * formatFee's FREE case used to be covered by a page assertion on FREE FIRE
 * being free. It is a PAID event now, so that assertion was removed — and with
 * it the only guard on "a zero-priced event must read FREE, never ₹0". The
 * invariant is a property of the function, not of any one event, so it is
 * asserted here where it survives the catalogue changing again.
 */
const dataChecks = [
  [formatFee(0) === "FREE", "a zero-priced event reads FREE", formatFee(0)],
  [formatFee(349) === "₹349", "a priced event reads ₹n", formatFee(349)],
  [
    formatFee(null) !== "FREE" && !/^₹0/.test(formatFee(null)),
    "a missing fee never masquerades as free",
    String(formatFee(null)),
  ],
  [
    events.every((e) => e.payment != null),
    "every event declares a payment (0 is explicit, never omitted)",
    events.filter((e) => e.payment == null).map((e) => e.id).join(",") || "all present",
  ],
  [
    getEventFields("free-fire").some((f) => f.name === "free_fire_id"),
    "FREE FIRE declares the in-game ID field",
    JSON.stringify(getEventFields("free-fire").map((f) => f.name)),
  ],
  [
    events.filter((e) => e.id !== "free-fire").every((e) => getEventFields(e.id).length === 0),
    "no other event inherits that field",
    events
      .filter((e) => e.id !== "free-fire" && getEventFields(e.id).length)
      .map((e) => e.id)
      .join(",") || "none",
  ],
];
for (const [ok, label, detail] of dataChecks) {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}  |  ${detail}`);
}

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
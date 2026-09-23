import { chromium } from "playwright";

/** Regression suite: return-to-events affordances on every realm page. */
const BASE = "http://localhost:4173";
const REALMS = ["forge", "paradox", "arena"];

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errs = [];
page.on("console", (m) => m.type() === "error" && errs.push(m.text()));

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  | " + extra : ""}`);
};

const pathNow = () => page.evaluate(() => location.pathname);
const scrollNow = () => page.evaluate(() => window.scrollY);

for (const realm of REALMS) {
  await page.goto(`${BASE}/events/${realm}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(900);

  const top = page.getByRole("link", { name: "All events", exact: true });
  check(`top return link on /events/${realm}`, (await top.count()) === 1);

  const bottom = page.getByRole("link", { name: "Return to all events", exact: true });
  check(`bottom return button on /events/${realm}`, (await bottom.count()) === 1);

  /* click top link -> /events at top */
  await top.click();
  await page.waitForTimeout(900);
  const p1 = await pathNow();
  const y1 = await scrollNow();
  check(`top link returns to /events at top`, p1 === "/events" && y1 <= 2, `path=${p1} scrollY=${y1}`);

  /* click bottom button -> /events at top */
  await page.goto(`${BASE}/events/${realm}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  const btn = page.getByRole("link", { name: "Return to all events", exact: true });
  await btn.scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  await btn.click();
  await page.waitForTimeout(900);
  const p2 = await pathNow();
  const y2 = await scrollNow();
  check(`bottom button returns to /events at top`, p2 === "/events" && y2 <= 2, `path=${p2} scrollY=${y2}`);
}

check("no console errors", errs.length === 0, `count=${errs.length}`);

console.log(
  fail === 0
    ? `\n=== ALL RETURN CHECKS PASSED (${pass}/${pass + fail}) ===`
    : `\n=== RETURN CHECKS FAILED (passed ${pass}, failed ${fail}) ===`
);
await browser.close();
process.exit(fail === 0 ? 0 : 1);

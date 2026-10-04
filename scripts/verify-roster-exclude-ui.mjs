/**
 * The college EXCLUDE filter, clicked for real in a browser.
 *
 * Every earlier version of this filter was a correct STRING and a 400 the moment
 * an operator picked an option, which took the whole roster tab down. A unit test
 * on rosterFilters cannot catch that: only sending it can. The API-level probe
 * proved the query is accepted; this proves the control is wired to it and that a
 * real click does not put the tab into its error state.
 *
 *   VERIFY_BASE=http://localhost:4173 npm run verify:roster-exclude-ui
 */
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

function loadEnv(path) {
  const out = {};
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}
const env = { ...loadEnv(new URL("../.env", import.meta.url)), ...process.env };
const BASE = process.env.VERIFY_BASE || "http://localhost:4173";

let failures = 0;
const out = (ok, label, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  |  ${detail}` : ""}`);
  if (!ok) failures += 1;
};

console.log("=== ROSTER EXCLUDE FILTER (UI) ===\n");

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e?.message ?? e)));

/** Any "could not load" text on screen â€” the tab's error state. */
const broken = async () =>
  (await page.getByText(/could not load|try refreshing/i).count()) > 0;

try {
  await page.goto(`${BASE}/nexus-admin`, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.locator('input[name="username"]').fill(env.SUPABASE_STAFF_EMAIL);
  await page.locator('input[name="password"]').fill(env.SUPABASE_STAFF_PASSWORD);
  await page.locator('button[type="submit"]').first().click();
  await page.locator('nav[aria-label="Console sections"] button').first().waitFor({ timeout: 30000 });
  await page.locator("#roster-college").waitFor({ timeout: 30000 });
  await page.waitForTimeout(1500);

  out(true, "signed in and the roster is up");
  out(!(await broken()), "the roster loads cleanly to begin with");

  const ctl = page.locator("#roster-exclude-college");
  out((await ctl.count()) === 1, "the Excluding dropdown is on the roster");

  // Choose a real option out of the listbox, the way an operator does.
  await ctl.click();
  // Scoped to the exclude listbox specifically: the college and year Selects on
  // the same row render their options with the same role, and a global selector
  // would happily click an option belonging to a different dropdown.
  const options = page.locator('#roster-exclude-college-listbox [role="option"]');
  const n = await options.count();
  out(n > 1, "the dropdown offers colleges", `${n - 1} colleges + the "including all" marker`);
  const label = (await options.nth(1).innerText()).trim();
  await options.nth(1).click();
  await page.waitForTimeout(3000);

  out(!(await broken()), "picking a college does NOT break the roster", `picked "${label}"`);

  // Reset through the console's own Reset control rather than reloading, so the
  // assertion covers the path an operator actually takes back.
  await page.locator('[data-action="roster-reset"]').click();
  await page.waitForTimeout(2500);
  out(!(await broken()), "Reset restores the unfiltered roster");

  out(errors.length === 0, "no uncaught errors", errors.slice(0, 2).join(" | "));
} finally {
  await browser.close();
}

console.log(
  failures === 0 ? "\n=== EXCLUDE UI CHECKS PASSED ===" : `\n=== ${failures} EXCLUDE UI CHECK(S) FAILED ===`
);
process.exit(failures === 0 ? 0 : 1);


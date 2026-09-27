import { mkdirSync, readFileSync } from "node:fs";
import { chromium } from "playwright";

mkdirSync("artifacts/screenshots", { recursive: true });

/**
 * Operations console captures for visual review.
 * Run: node scripts/shot-admin.mjs   (preview must run on :4173)
 *
 * Captures the signed-OUT gate (the public face of the console) and, when
 * SUPABASE_STAFF_EMAIL / SUPABASE_STAFF_PASSWORD are present in .env, signs in
 * and captures each tab for the signed-in role. Without credentials it still
 * proves the important negative: an anonymous visitor sees the gate and no
 * roster markup at all.
 */

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

let env = {};
try {
  env = loadEnv(new URL("../.env", import.meta.url));
} catch {
  /* no .env — the gate-only captures below still run */
}
const staffUser = process.env.SUPABASE_STAFF_EMAIL || env.SUPABASE_STAFF_EMAIL;
const staffPass = process.env.SUPABASE_STAFF_PASSWORD || env.SUPABASE_STAFF_PASSWORD;

const browser = await chromium.launch({ channel: "chrome" });
const faults = [];
const BASE = process.env.VERIFY_BASE || "http://localhost:4173";

const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("console", (m) => {
  if (m.type() === "error") faults.push(`console.error: ${m.text()}`);
});
page.on("pageerror", (e) => faults.push(`pageerror: ${e.message}`));

await page.goto(`${BASE}/nexus-admin`, { waitUntil: "networkidle" });
// The gate only renders once the runtime-config fetch and the staff-session
// resolve have both settled.
await page.waitForTimeout(3500);
await page.screenshot({ path: "artifacts/screenshots/admin-hero.png" });

// Prove for ourselves what an anonymous visitor got: no roster in the DOM.
const anon = await page.evaluate(() => ({
  table: document.querySelectorAll("#admin-table-wrap").length,
  rows: document.querySelectorAll("#admin-table-wrap > li").length,
  signIn: document.querySelectorAll("#admin-signin").length,
  google: [...document.querySelectorAll("button")].filter((b) =>
    /google/i.test(b.textContent || "")
  ).length,
}));
console.log(
  `an anonymous visitor sees: signIn=${anon.signIn} table=${anon.table} rows=${anon.rows} googleButtons=${anon.google}`
);
if (anon.table || anon.rows) faults.push("anonymous visitor can see roster markup");
if (anon.google) faults.push("a social login button is present on the console");

/* ---------- signed in ---------- */
if (staffUser && staffPass) {
  await page.fill("#staff-username", staffUser);
  await page.fill("#staff-password", staffPass);
  await page.click("#admin-signin-submit");

  const entered = await page
    .locator("#admin-table-wrap")
    .waitFor({ state: "attached", timeout: 25000 })
    .then(() => true)
    .catch(() => false);
  console.log(`signed in as ${staffUser}: console=${entered}`);

  if (entered) {
    await page.waitForTimeout(1200);
    await page.screenshot({ path: "artifacts/screenshots/admin-roster.png", fullPage: true });

    // Each tab the signed-in role is actually allowed to see.
    for (const [label, file] of [
      ["Audit log", "admin-audit"],
      ["Staff", "admin-staff"],
      ["Pricing", "admin-pricing"],
    ]) {
      const tab = page.getByRole("button", { name: label, exact: true });
      if (!(await tab.count())) continue;
      await tab.first().click();
      await page.waitForTimeout(900);
      await page.screenshot({ path: `artifacts/screenshots/${file}.png`, fullPage: true });
    }
  }
} else {
  console.log(
    "note: no SUPABASE_STAFF_EMAIL / SUPABASE_STAFF_PASSWORD set, so only the signed-out\n" +
      "      gate was captured. Set them in .env to capture the signed-in tabs."
  );
}
await page.close();

const mob = await browser.newPage({ viewport: { width: 390, height: 844 } });
mob.on("pageerror", (e) => faults.push(`mobile pageerror: ${e.message}`));
await mob.goto(`${BASE}/nexus-admin`, { waitUntil: "networkidle" });
await mob.waitForTimeout(3500);
await mob.screenshot({ path: "artifacts/screenshots/admin-mob.png" });
await mob.close();

await browser.close();
console.log("screenshots saved: admin-hero, admin-mob (+ roster/audit/staff/pricing when signed in)");
console.log(
  faults.length ? `FAULTS:\n${faults.join("\n")}` : "no console errors / page errors"
);
process.exit(faults.length ? 1 : 0);
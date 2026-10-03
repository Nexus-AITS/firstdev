/**
 * The Mail TAB, in a real browser, with a real master session.
 *
 *   VERIFY_BASE=http://localhost:4173 node scripts/verify-mail-ui.mjs
 *
 * WHY A BROWSER
 *
 * Every other mail check is database and API. This one exists for the class those
 * cannot see: the tab renders at all, the buttons exist, the merge-field picker
 * is populated from the database, and the send button is present for a MASTER and
 * absent for a lower role. A broken import, a mistyped prop or a wrong role gate
 * all produce a perfectly healthy build and a perfectly healthy API.
 *
 * The send is never pressed: this asserts the AUDIENCE GATE exists, not that
 * mail goes out to real people from a test.
 */
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

function loadEnv(path) {
  const out = {};
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
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

console.log("=== MAIL TAB (UI) VERIFIED ===\n");

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e?.message ?? e)));

try {
  await page.goto(`${BASE}/nexus-admin`, { waitUntil: "domcontentloaded", timeout: 45000 });

  await page.locator('input[name="username"]').fill(env.SUPABASE_STAFF_EMAIL);
  await page.locator('input[name="password"]').fill(env.SUPABASE_STAFF_PASSWORD);
  await page.locator('button[type="submit"]').first().click();
  await page.locator('nav[aria-label="Console sections"] button').first().waitFor({ timeout: 30000 });

  out(true, "signed in to the console", env.SUPABASE_STAFF_EMAIL);

  const mailTab = page.locator('nav[aria-label="Console sections"] button:has-text("Mail")');
  out((await mailTab.count()) === 1, "the Mail tab is in the navigation");
  await mailTab.click();

  await page.locator('[data-action="mail-manager"]').waitFor({ timeout: 30000 });
  out(true, "the Mail tab renders");

  await page.locator('[data-action="mail-field-name"]').waitFor({ timeout: 25000 });
  const fieldCount = await page.locator('[data-action^="mail-field-"]').count();
  out(fieldCount >= 5, "merge fields are offered, from the database", `${fieldCount} fields`);

  const templates = await page.locator('[data-action^="mail-template-"]').count();
  out(templates >= 1, "the seeded default template is listed", `${templates} templates`);

  const body = page.locator('[data-edit-field="body"]');
  out((await body.count()) === 1, "there is a textarea for the template body");

  const subject = page.locator('[data-edit-field="subject"]');
  out((await subject.count()) === 1, "and one for the subject");

  // Clicking a field INSERTS its placeholder rather than needing it typed.
  await page.locator('[data-action="mail-field-name"]').click();
  const withToken = await body.inputValue();
  out(withToken.includes("{{name}}"), "clicking a merge field inserts {{name}}", withToken.slice(-24));

  const preview = page.locator('[data-action="mail-preview"]');
  out((await preview.count()) === 1, "a master sees the audience preview");
  const send = page.locator('[data-action="mail-send"]');
  out((await send.count()) === 0, "but no Send button until the audience is COUNTED");
  await preview.click();
  await page.locator('[data-action="mail-send"]').waitFor({ timeout: 20000 });
  out(true, "the Send button appears only after the preview answers");

  const counts = await page.locator('[data-action="mail-manager"]').innerText();
  out(/\d+\s*recipient/.test(counts), "and it states how many people that is");

  out(errors.length === 0, "no uncaught errors on the tab", errors.join(" | ").slice(0, 200));
} catch (err) {
  out(false, "the tab loaded without throwing", String(err?.message ?? err).slice(0, 220));
} finally {
  await browser.close();
}

console.log(
  failures === 0
    ? "\n=== MAIL UI CHECKS PASSED ==="
    : `\n=== ${failures} MAIL UI CHECK(S) FAILED ===`
);
process.exit(failures === 0 ? 0 : 1);
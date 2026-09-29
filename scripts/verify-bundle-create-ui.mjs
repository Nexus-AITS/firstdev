/**
 * Drive BUNDLE CREATION in the real console, as a real master, against the live
 * project and the built site.
 *
 *   node scripts/verify-bundle-create-ui.mjs      (or: npm run verify:bundle-ui)
 *   VERIFY_BASE=http://localhost:4173 node scripts/verify-bundle-create-ui.mjs
 *
 * This file exists because of a shipped bug. Creating a bundle in the console
 * reported success and wrote nothing:
 *
 *   rpc() in staff.js returned `{ ok: res.ok }` - the HTTP status. But every
 *   staff_* RPC reports a refusal by RETURNING {"ok": false, "error": "..."}
 *   with HTTP 200, because a refusal ("you are not a master", "no active event
 *   called X", "another live bundle already offers this") is an answer written
 *   for the operator, not a transport error. So `!result.ok` was false for every
 *   refusal, the console cleared the form, called onSaved() and printed
 *   "Bundle saved. The public catalogue is updated." - over a save the database
 *   had thrown away.
 *
 * Nothing caught it because every bundle test to that point asserted a REFUSAL
 * through the raw transport, and no test ever drove the console UI. So this one
 * checks the two halves of the contract where the operator meets it:
 *
 *   A. a refused save shows the server's sentence, does NOT print the success
 *      banner, and does NOT clear the form (the operator keeps their typing)
 *   B. an accepted save really is in the database, really is in the list after
 *      the reload, really does print the banner, and numbers its lines from 0
 *
 * Everything it creates is removed in the finally block. It refuses to run
 * without a master account, and it never edits a pre-existing bundle.
 */
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const BASE = process.env.VERIFY_BASE || "http://localhost:4173";
const stamp = Date.now().toString(36).slice(-6);
const GOOD = `zz-ui-good-${stamp}`;

let pass = 0;
let fail = 0;
function out(ok, label, detail = "") {
  if (ok) {
    pass += 1;
    console.log(`PASS  ${label}${detail ? `  |  ${detail}` : ""}`);
  } else {
    fail += 1;
    console.log(`FAIL  ${label}${detail ? `  |  ${detail}` : ""}`);
  }
}

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
const env = loadEnv(new URL("../.env", import.meta.url));
const username = process.env.SUPABASE_STAFF_EMAIL || env.SUPABASE_STAFF_EMAIL;
const password = process.env.SUPABASE_STAFF_PASSWORD || env.SUPABASE_STAFF_PASSWORD;
const supabaseUrl = (process.env.SUPABASE_URL || env.SUPABASE_URL || "").replace(/\/+$/, "");
const mgmtToken = process.env.SUPABASE_ACCESS_TOKEN || env.SUPABASE_ACCESS_TOKEN;
const ref = new URL(supabaseUrl).hostname.split(".")[0];
const mgmt = `https://api.supabase.com/v1/projects/${ref}/database/query`;

if (!username || !password) {
  console.error("FAIL: SUPABASE_STAFF_EMAIL / SUPABASE_STAFF_PASSWORD are required (a master account)");
  process.exit(1);
}
if (!mgmtToken || !supabaseUrl) {
  console.error("FAIL: SUPABASE_ACCESS_TOKEN / SUPABASE_URL are required (for teardown)");
  process.exit(1);
}

async function sql(query) {
  const res = await fetch(mgmt, {
    method: "POST",
    headers: { Authorization: `Bearer ${mgmtToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`mgmt HTTP ${res.status}: ${text.slice(0, 300)}`);
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : (parsed.result ?? []);
}

const browser = await chromium.launch();
try {
  await sql(`delete from public.bundle_catalogue where id like 'zz-ui-good-%'`);
  const page = await browser.newPage();
  await page.goto(`${BASE}/nexus-admin`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#staff-username", { timeout: 20000 });
  await page.fill("#staff-username", username);
  await page.fill("#staff-password", password);
  await page.click('#admin-signin button[type="submit"]');
  await page.waitForTimeout(4000);

  await page.click('nav[aria-label="Console sections"] button:has-text("Catalogue")');
  await page.waitForSelector('[data-action="catalogue-manager"]', { timeout: 20000 });
  await page.click('[data-action="catalogue-tab-bundles"]');
  await page.waitForSelector('[data-action="save-bundle"]', { timeout: 20000 });
  out(true, "signed in as a master and reached the bundles tab");

  /* ---- A. a REFUSED save ---- */
  // "X" is one character: the RPC requires 2-49, and refuses with a sentence.
  await page.fill("#cat-bundle-id", "X");
  await page.fill("#cat-bundle-name", "Refused Probe");
  await page.fill("#cat-bundle-number", "ZZ");
  await page.click('button:has-text("+ Event")');
  await page.waitForTimeout(300);
  await page.click('[data-action="save-bundle"]');
  await page.waitForTimeout(3000);

  const body = await page.locator('[data-action="catalogue-manager"]').innerText();
  out(
    /2-49 characters/i.test(body),
    "a refused save shows the server's reason instead of 'created'",
    body.replace(/\s+/g, " ").match(/.{0,90}2-49 characters.{0,40}/i)?.[0] ?? "(no message found)"
  );
  // Match the console's own sentence, not loose words: the form itself contains
  // a "Published" checkbox and a "Save bundle" button, so a /saved|published/i
  // test would pass on the labels and prove nothing.
  const SAVED = "Bundle saved.";

  out(
    !body.includes(SAVED),
    "and it does NOT claim the bundle was saved",
    body.includes(SAVED) ? "found the success banner anyway" : "no success banner"
  );

  // The form must still hold what was typed: a refused save is recoverable, and
  // the old code cleared it and called onSaved(), so the operator lost the work.
  const keptId = await page.inputValue("#cat-bundle-id");
  out(keptId === "X", "the form keeps what was typed, so nothing is lost", `id=${keptId}`);

  const none = await sql(`select count(*)::int as n from public.bundle_catalogue where id = 'X'`);
  out(none[0].n === 0, "and the refused save wrote no row", JSON.stringify(none));

  /* ---- B. an ACCEPTED save ---- */
  await page.fill("#cat-bundle-id", GOOD);
  await page.fill("#cat-bundle-name", "UI Probe");
  await page.fill("#cat-bundle-number", "ZZ");
  await page.click('[data-action="save-bundle"]');
  await page.waitForTimeout(3500);

  const row = await sql(
    `select is_active, content_key from public.bundle_catalogue where id = '${GOOD}'`
  );
  out(
    row.length === 1,
    "an accepted save is actually in the database",
    JSON.stringify(row)
  );

  const listed = await page.locator(`[data-action="catalogue-manager"]`).innerText();
  out(listed.includes(GOOD), "and the console list shows it after the reload");
  out(
    listed.includes(SAVED),
    "and this time the success banner IS shown",
    listed.includes(SAVED) ? "banner present" : "banner MISSING"
  );

  const lines = await sql(
    `select position from public.bundle_includes where bundle_id = '${GOOD}' order by position`
  );
  out(
    lines.length >= 1 && lines[0].position === 0,
    "its include lines are numbered from zero",
    JSON.stringify(lines)
  );
} catch (err) {
  fail += 1;
  console.log(`FAIL  suite aborted  |  ${String(err.message).slice(0, 300)}`);
} finally {
  await browser.close();
  await sql(`delete from public.bundle_catalogue where id like 'zz-ui-good-%'`);
  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
}
process.exit(fail ? 1 : 0);


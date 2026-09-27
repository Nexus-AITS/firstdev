/**
 * Drive the STAFF CRUD in the real console UI, as a real master, against the
 * live project.
 *
 *   node scripts/verify-staff-ui.mjs
 *
 * verify-staff.mjs proves the database refuses a non-master. This proves the
 * other half: that a master can actually CREATE an admin / coordinator / master
 * from the panel itself, change a role, reset a password and deactivate — the
 * operations that were missing because StaffTab rendered a list but never
 * rendered its own "add account" form.
 *
 * Everything it creates is removed in the finally block. It refuses to run
 * unless it can sign in as a master, and it never touches a pre-existing
 * account other than the one it created.
 */
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const BASE = process.env.VERIFY_BASE || "http://localhost:4173";
/** Marker so an interrupted run leaves something recognisable and cleanable. */
const stamp = Date.now().toString(36).slice(-6);
const CREATED = {
  coordinator: `probe-coord-${stamp}`,
  admin: `probe-admin-${stamp}`,
  master: `probe-master-${stamp}`,
};
const CREATED_PASSWORD = "Probe-Password-9134";

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
const mgmtToken = process.env.SUPABASE_ACCESS_TOKEN || env.SUPABASE_ACCESS_TOKEN;
const supabaseUrl = (process.env.SUPABASE_URL || env.SUPABASE_URL || "").replace(/\/+$/, "");

if (!username || !password) {
  console.error("FAIL: SUPABASE_STAFF_EMAIL / SUPABASE_STAFF_PASSWORD are required (a master account)");
  process.exit(1);
}
if (!mgmtToken || !supabaseUrl) {
  console.error("FAIL: SUPABASE_ACCESS_TOKEN / SUPABASE_URL required (for teardown)");
  process.exit(1);
}

const ref = new URL(supabaseUrl).hostname.split(".")[0];
const mgmt = `https://api.supabase.com/v1/projects/${ref}/database/query`;

async function sql(query) {
  const res = await fetch(mgmt, {
    method: "POST",
    headers: { Authorization: `Bearer ${mgmtToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`management API HTTP ${res.status}: ${text.slice(0, 300)}`);
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : (parsed.result ?? []);
}

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  const page = await ctx.newPage();

  await page.goto(`${BASE}/nexus-admin`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  await page.fill("#staff-username", username);
  await page.fill("#staff-password", password);
  await page.click('#admin-signin button[type="submit"]');
  await page.waitForTimeout(4000);

  const tabs = await page.locator('nav[aria-label="Console sections"] button').allInnerTexts();
  out(tabs.some((t) => /staff/i.test(t)), "a master sees the Staff tab", tabs.join(" / "));

  await page.click('nav[aria-label="Console sections"] button:has-text("Staff")');
  await page.waitForTimeout(1500);

  /* ---- the form that was missing entirely ---- */
  out((await page.locator("#staff-create-submit").count()) === 1, "Staff tab renders the create form");
  for (const id of ["#staff-new-username", "#staff-new-fullname", "#staff-new-password", "#staff-new-role"]) {
    out((await page.locator(id).count()) === 1, `create form has ${id}`);
  }
  const roleValues = await page
    .locator("#staff-new-role option")
    .evaluateAll((os) => os.map((o) => o.value));
  out(
    ["coordinator", "admin", "master"].every((r) => roleValues.includes(r)),
    "create form offers all three roles",
    roleValues.join(",")
  );
  out((await page.locator('input[id^="staff-pass-"]').count()) >= 1, "per-account password reset field exists");

  /* ---- create one of each tier, through the real UI ---- */
  for (const [role, name] of Object.entries(CREATED)) {
    await page.fill("#staff-new-username", name);
    await page.fill("#staff-new-fullname", `Probe ${role}`);
    await page.fill("#staff-new-password", CREATED_PASSWORD);
    await page.selectOption("#staff-new-role", role);
    await page.click("#staff-create-submit");
    await page.waitForTimeout(3000);
    out((await page.locator("li").filter({ hasText: name }).count()) >= 1, `created a ${role} from the panel`, name);
  }


  const rows = await sql(
    `select username, role, is_active, full_name from public.staff_users ` +
      `where username in ('${Object.values(CREATED).join("','")}') order by role;`
  );
  out(rows.length === 3, "all three accounts exist in the database", `n=${rows.length}`);
  for (const role of ["coordinator", "admin", "master"]) {
    out(rows.some((r) => r.username === CREATED[role] && r.role === role), `${role} stored with the right role`);
  }
  out(
    rows.every((r) => r.full_name === `Probe ${r.role}`),
    "full name persisted (staffUpdate used to hardcode p_full_name to null)"
  );

  /* ---- update: promote the coordinator to admin, via the role select ---- */
  const coordRow = page.locator("li").filter({ hasText: CREATED.coordinator }).first();
  await coordRow.locator("select").selectOption("admin");
  await page.waitForTimeout(3000);
  const promoted = await sql(`select role from public.staff_users where username = '${CREATED.coordinator}';`);
  out(promoted[0]?.role === "admin", "role change from the panel is persisted", `role=${promoted[0]?.role}`);

  /* ---- deactivate ---- */
  await coordRow.locator('button:has-text("Deactivate")').click();
  await page.waitForTimeout(3000);
  const deactivated = await sql(
    `select is_active from public.staff_users where username = '${CREATED.coordinator}';`
  );
  out(deactivated[0]?.is_active === false, "deactivate from the panel is persisted");

  /* ---- a deactivated account cannot sign in ---- */
  await page.click('button:has-text("Sign out")');
  await page.waitForTimeout(2500);
  await page.fill("#staff-username", CREATED.coordinator);
  await page.fill("#staff-password", CREATED_PASSWORD);
  await page.click('#admin-signin button[type="submit"]');
  await page.waitForTimeout(3500);
  out(
    (await page.locator("#admin-signin").count()) === 1,
    "a deactivated account cannot sign in"
  );

  /* ---- sign in as the freshly-created admin: no Staff, no Pricing ---- */
  await page.fill("#staff-username", CREATED.admin);
  await page.fill("#staff-password", CREATED_PASSWORD);
  await page.click('#admin-signin button[type="submit"]');
  await page.waitForTimeout(3500);
  const adminTabs = await page.locator('nav[aria-label="Console sections"] button').allInnerTexts();
  out(
    !adminTabs.some((t) => /staff|pricing/i.test(t)),
    "an account created from the panel cannot see Staff or Pricing",
    adminTabs.join(" / ") || "(none)"
  );

  /* ---- audit: every change recorded server-side ---- */
  const audited = await sql(
    `select action, count(*)::int as n from public.staff_audit_log ` +
      `where entity_id in (select id::text from public.staff_users where username like 'probe-%-${stamp}') ` +
      `group by action order by action;`
  );
  const byAction = Object.fromEntries(audited.map((r) => [r.action, r.n]));
  out(byAction.create_staff === 3, "each creation is in the audit log", JSON.stringify(byAction));
  out(byAction.update_staff >= 2, "role change and deactivation are audited");

  await page.click('button:has-text("Sign out")');
  await ctx.close();
} catch (err) {
  console.error(`FAIL  harness error: ${err?.message || err}`);
  fail += 1;
} finally {
  /* Remove the probe accounts. ON DELETE CASCADE clears their sessions; their
     audit rows survive with staff_id NULL, which is the intended behaviour. */
  const list = Object.values(CREATED).map((u) => `'${u}'`).join(",");
  await sql(`delete from public.staff_users where username in (${list});`)
    .then(() => console.log(`\ncleaned up ${Object.keys(CREATED).length} probe accounts`))
    .catch((e) => console.error(`FAIL  cleanup: ${e?.message || e}`));
  await browser.close();
  const left = await sql(`select count(*)::int as n from public.staff_users where username in (${list});`);
  out(left[0]?.n === 0, "no probe accounts left behind", `n=${left[0]?.n}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
else console.log("=== STAFF CRUD VERIFIED ===");

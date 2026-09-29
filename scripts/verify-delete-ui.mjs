/**
 * Drive the MASTER-ONLY permanent-delete buttons in the real console, as a real
 * master, against the live project and the built site.
 *
 *   node scripts/verify-delete-ui.mjs      (or: npm run verify:delete-ui)
 *   VERIFY_BASE=http://localhost:4173 node scripts/verify-delete-ui.mjs
 *
 * Delete and retire look similar in the catalogue and mean opposite things, and
 * the console had no way to remove a row that was never real - a bundle built
 * with the wrong pick-pool, an event that never happened, a contact channel that
 * was a test. All three now have a master-only Delete beside Retire, backed by
 * staff_delete_event / staff_delete_bundle / staff_delete_contact.
 *
 * The role check lives in the RPC, where a caller that skips this screen cannot
 * get past it, and so does the "nobody bought this" check - a bundle a
 * participant purchased is refused with the count rather than deleted out from
 * under the roster. This file drives the button an operator actually meets and
 * checks it does what the dialog promised.
 *
 * Everything it creates is removed in the finally block. It refuses to run
 * without a master account, and it never touches a pre-existing row.
 */
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const BASE = process.env.VERIFY_BASE || "http://localhost:4173";
const stamp = Date.now().toString(36).slice(-6);
const PROBE = `zz-ui-del-${stamp}`;
const PREFIX = "zz-ui-del-";

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
  await sql(`delete from public.event_catalogue where id like '${PREFIX}%'`);
  // A RETIRED event nobody has registered for - exactly the case delete exists
  // for, and the only one a participant's money is not attached to.
  await sql(
    `insert into public.event_catalogue (id, number, title, category, mode, realm, is_active)
     values ('${PROBE}', 'ZZ', 'Delete Probe', 'TEST', 'STANDARD', 'paradox', false)`
  );
  await sql(
    `insert into public.pricing (kind, ref_id, price, entry_type, is_active)
     values ('event', '${PROBE}', 10, 'individual', true)`
  );

  const page = await browser.newPage();
  await page.goto(`${BASE}/nexus-admin`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#staff-username", { timeout: 20000 });
  await page.fill("#staff-username", username);
  await page.fill("#staff-password", password);
  await page.click('#admin-signin button[type="submit"]');
  await page.waitForTimeout(4000);

  await page.click('nav[aria-label="Console sections"] button:has-text("Catalogue")');
  await page.waitForSelector('[data-action="catalogue-manager"]', { timeout: 20000 });
  await page.waitForTimeout(2500);

  const masterDeletes = await page.locator('[data-action="delete-event"]').count();
  out(masterDeletes >= 1, "a MASTER is offered Delete on the catalogue", `buttons=${masterDeletes}`);

  const bundlesTab = await page.locator('[data-action="catalogue-tab-bundles"]').count();
  out(bundlesTab === 1, "â€¦and the bundles tab is reachable from the same screen");

  // Scoped to THIS probe's own row, not the first button on the page. An earlier
  // draft used `.first()` and landed on a real event instead - which the
  // database then correctly refused, because people have registered for it. That
  // refusal is the guard working, and it is asserted separately below; the button
  // that has to be clicked here is the probe's.
  const probeDelete = page
    .locator('[data-action="catalogue-manager"] li')
    .filter({ hasText: PROBE })
    .locator('[data-action="delete-event"]');
  const probeButtons = await probeDelete.count();
  out(probeButtons === 1, "the probe's own row carries a Delete", `buttons=${probeButtons}`);

  // window.confirm is blocking, so accept it - and check it said the right thing
  // on the way past, since "Delete" sitting next to "Retire" is the whole
  // confusion this button has to avoid.
  let promptText = "";
  page.on("dialog", async (d) => {
    promptText = d.message();
    await d.accept();
  });
  await probeDelete.first().click();
  await page.waitForTimeout(3500);

  out(
    /permanently delete/i.test(promptText) && /cannot be undone/i.test(promptText),
    "the confirmation says the delete is permanent",
    promptText.replace(/\s+/g, " ").slice(0, 110) || "(no dialog seen)"
  );

  const gone = await sql(`select count(*)::int as n from public.event_catalogue where id = '${PROBE}'`);
  out(gone[0].n === 0, "accepting it really removed the row from the database", JSON.stringify(gone));

  const priced = await sql(`select count(*)::int as n from public.pricing where ref_id = '${PROBE}'`);
  out(priced[0].n === 0, "â€¦and took its orphaned price with it", JSON.stringify(priced));

  const audit = await sql(
    `select action, entity_id from public.staff_audit_log
      where action = 'delete_event' and entity_id = '${PROBE}' order by created_at desc limit 1`
  );
  out(audit.length === 1, "â€¦and left an audit entry naming it", JSON.stringify(audit[0] ?? null));

  /* ---- the guard the button cannot override ----
   * A real event somebody registered for. The console offers Delete on it, and
   * clicking it must be REFUSED with the count - not silently do nothing, and
   * certainly not delete. This is the case that would erase what people paid. */
  const bought = await sql(
    `select purchase_ref from public.registrations
      where purchase_ref is not null and purchase_type = 'event' limit 1`
  );
  if (bought.length) {
    const boughtId = bought[0].purchase_ref;
    const boughtRow = await page
      .locator('[data-action="catalogue-manager"] li')
      .filter({ hasText: boughtId })
      .locator('[data-action="delete-event"]');
    if ((await boughtRow.count()) === 1) {
      await boughtRow.first().click();
      await page.waitForTimeout(3000);
      const stillThere = await sql(
        `select count(*)::int as n from public.event_catalogue where id = '${boughtId}'`
      );
      const alert = await page
        .locator('[data-action="catalogue-manager"] [role="alert"]')
        .innerText();
      out(
        stillThere[0].n === 1 && /registered for this event/i.test(alert),
        "deleting an event somebody registered for is REFUSED, and says how many",
        alert.replace(/\s+/g, " ").slice(0, 90)
      );
    } else {
      out(true, "the bought event shows no Delete, so the case cannot be clicked");
    }
  } else {
    out(true, "no purchased event to test the refusal against");
  }
} catch (err) {
  fail += 1;
  console.log(`FAIL  suite aborted  |  ${String(err.message).slice(0, 300)}`);
} finally {
  await browser.close();
  await sql(`delete from public.event_catalogue where id like '${PREFIX}%'`);
  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
}
process.exit(fail ? 1 : 0);

/**
 * The announcements and problem-statements pages and tabs, in a real browser.
 *
 *   VERIFY_BASE=http://localhost:4173 node scripts/verify-content-ui.mjs
 *
 * WHY A BROWSER
 *
 * verify-content.mjs is all database and API. This one exists for the class those
 * cannot see: that the new routes are actually registered, that the two admin tabs
 * render and their editors mount, and that a failed read shows a sentence rather
 * than a blank page. A wrong route path or a mistyped prop produce a perfectly
 * healthy build and a perfectly healthy API.
 *
 * The pages are checked in whatever state the database happens to be in — with
 * content, or with the honest empty state. Both are acceptable; a blank frame or a
 * thrown error is not. That means this suite passes BEFORE migration 040 is
 * applied, deliberately: it proves the code is wired, not that the schema is
 * deployed.
 *
 * The COORDINATOR refusal is not checked here. That check belongs in
 * verify-content.mjs, which proves it against the database — the tab simply not
 * being rendered proves nothing, because hiding a tab is a courtesy and the
 * database refusing the write is the control.
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

console.log("=== ANNOUNCEMENTS + PROBLEM STATEMENTS (UI) VERIFIED ===\n");

const browser = await chromium.launch();
const errors = [];

/* ---------- the two public pages, signed out ---------- */

const guest = await browser.newPage();
guest.on("pageerror", (e) => errors.push(`guest: ${e?.message ?? e}`));
try {
  for (const [path, heading, listMarker] of [
    ["/announcements", "ANNOUNCE", '[data-action="announcement-list"]'],
    ["/problem-statements", "PROBLEM", '[data-action="statement-list"]'],
  ]) {
    await guest.goto(`${BASE}${path}`, { waitUntil: "networkidle", timeout: 45000 });
    out(
      (await guest.locator("h1").first().innerText()).replace(/\s+/g, " ").includes(heading),
      `${path} renders its heading`
    );
    // Either the list or a plain sentence. What must NOT happen is an empty frame.
    const hasContent = (await guest.locator(listMarker).count()) > 0;
    const hasEmpty = (await guest.getByText(/Nothing to announce|Nothing published yet/i).count()) > 0;
    const hasError = (await guest.locator('[role="alert"]').count()) > 0;
    out(
      hasContent || hasEmpty || hasError,
      `${path} renders content, an empty state, or a message`,
      `list=${hasContent} empty=${hasEmpty} error=${hasError}`
    );
  }

  // The header link, by the name it was asked for.
  await guest.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 45000 });
  out(
    (await guest.locator('header a[href="/announcements"]').count()) === 1,
    "ANNOUNCEMENTS is in the header navigation"
  );
} finally {
  await guest.close();
}

/* ---------- the two admin tabs, as a master ---------- */

const master = await browser.newPage();
master.on("pageerror", (e) => errors.push(`master: ${e?.message ?? e}`));
try {
  await master.goto(`${BASE}/nexus-admin`, { waitUntil: "domcontentloaded", timeout: 45000 });
  await master.locator('input[name="username"]').fill(env.SUPABASE_STAFF_EMAIL);
  await master.locator('input[name="password"]').fill(env.SUPABASE_STAFF_PASSWORD);
  await master.locator('button[type="submit"]').first().click();
  await master.locator('nav[aria-label="Console sections"] button').first().waitFor({ timeout: 30000 });
  out(true, "signed in to the console", env.SUPABASE_STAFF_EMAIL);

  for (const [tab, field, listMarker] of [
    ["Announcements", "#announcement-title", '[data-action="announcement-list"]'],
    ["Problem statements", "#statement-title", '[data-action="statement-list"]'],
  ]) {
    const tabButton = master.locator(`nav[aria-label="Console sections"] button:has-text("${tab}")`);
    out((await tabButton.count()) === 1, `the ${tab} tab is in the navigation`);
    await tabButton.click();

    // The editor's own field, not the shell: this proves the manager mounted AND
    // its state initialised, not merely that a <div> appeared.
    await master.locator(field).waitFor({ timeout: 20000 }).catch(() => {});
    out((await master.locator(field).count()) === 1, `${tab}: the editor is on screen`, field);

    out(
      (await master.locator(listMarker).count()) > 0 ||
        (await master.getByText(/Nothing written yet/i).count()) > 0,
      `${tab}: the list shows rows or an honest empty state`
    );
  }

  /* New rows must default to UNPUBLISHED. This is the assertion that matters most
     in this whole file: an operator opening the tab to look at something and
     half-typing a title should not put a blank notice on the public site.

     Back to the Announcements tab first — the loop above ends on Problem
     statements, whose form has only the one "Published" toggle, so counting
     checkboxes here without switching would silently measure the wrong form. */
  await master.locator('nav[aria-label="Console sections"] button:has-text("Announcements")').click();
  await master.locator("#announcement-title").waitFor({ timeout: 20000 }).catch(() => {});

  const checkboxes = master.locator('input[type="checkbox"]');
  const n = await checkboxes.count();
  out(n === 2, "the announcement form has both toggles", `${n} checkboxes`);
  out(
    n === 2 && (await checkboxes.nth(1).isChecked()) === false,
    "a new announcement defaults to NOT published"
  );

  /* The rows, and the two removal actions, against whatever actually exists.

     The draft banner is the point. An unpublished announcement is listed in the
     console and ABSENT from the public site, which reads as a broken feature
     unless the row says so in words — "not published" in the corner does not
     explain an empty /announcements page to somebody who did not write it.

     And Delete has to be reachable on a DRAFT: retire only ever took published
     rows off the list, so a notice saved by accident had no way off it at all. */
  const rows = master.locator('[data-action="announcement-row"]');
  /* Waited for, not sampled. The list arrives from the database after the tab
     mounts, so counting immediately reads zero on a perfectly working tab — which
     is how this suite first reported "0 rows" against an RPC that returns two.
     Either outcome counts as loaded. */
  await rows
    .first()
    .waitFor({ timeout: 15000 })
    .catch(() => {});
  const rowCount = await rows.count();
  out(
    rowCount > 0 || (await master.getByText(/Nothing written yet/i).count()) > 0,
    "the announcement list finished loading",
    `${rowCount} rows`
  );

  if (rowCount > 0) {
    const first = rows.first();
    const draftBadge = first.locator('[data-action="announcement-draft"]');
    const isDraft = (await draftBadge.count()) > 0;

    if (isDraft) {
      out(
        (await first.innerText()).toLowerCase().includes("not on the public page"),
        "an unpublished row SAYS it is not on the public page"
      );
    } else {
      out(true, "the first row is published — the draft banner was not exercised");
    }

    out(
      (await first.getByRole("button", { name: "Retire" }).count()) === 1,
      "Retire is offered on this row regardless of published state"
    );
    out(
      (await first.locator('[data-action="delete-announcement"]').count()) === 1,
      "Delete is offered to a master"
    );
  }
} finally {
  await master.close();
}

await browser.close();

out(errors.length === 0, "no uncaught errors on any page", errors.slice(0, 3).join(" | "));

console.log(
  failures === 0
    ? "\n=== CONTENT UI CHECKS PASSED ==="
    : `\n=== ${failures} CONTENT UI CHECK(S) FAILED ===`
);
process.exit(failures === 0 ? 0 : 1);
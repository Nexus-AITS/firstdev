/**
 * The registration gate in a browser: the console switch, and the public page.
 *
 *   VERIFY_BASE=http://localhost:4173 node scripts/verify-gate-ui.mjs
 *
 * This suite CLOSES registration on the live project, so it is written to be
 * survivable: the gate is reopened in a finally, on every path, including a throw
 * in the middle of a click. A suite that can leave a site shut behind it is worse
 * than no suite, and this one deliberately closes the thing it is testing.
 *
 * It drives the REAL console button rather than calling the RPC, because the
 * claim being checked is that a master can stop registration from the console -
 * not that a database function exists.
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
const DB = env.SUPABASE_URL.replace(/\/+$/, "");
const NOTE = "ZZ probe: the organisers have closed registration for this test.";

let failures = 0;
const out = (ok, label, detail = "") => {
  console.log("  " + (ok ? "PASS" : "FAIL") + "  " + label + (detail ? "  |  " + detail : ""));
  if (!ok) failures += 1;
};

const anon = {
  apikey: env.SUPABASE_ANON_KEY,
  Authorization: "Bearer " + env.SUPABASE_ANON_KEY,
  "Content-Type": "application/json",
};
const gate = () =>
  fetch(DB + "/rest/v1/rpc/public_registration_gate", { method: "POST", headers: anon, body: "{}" })
    .then((r) => r.json());

const browser = await chromium.launch();
const errors = [];

console.log("=== REGISTRATION GATE (UI) ===\n");

try {
  /* ---- the console ---- */
  const master = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  master.on("pageerror", (e) => errors.push("console: " + (e?.message ?? e)));
  await master.goto(BASE + "/nexus-admin", { waitUntil: "domcontentloaded", timeout: 45000 });
  await master.locator("input[name=\"username\"]").fill(env.SUPABASE_STAFF_EMAIL);
  await master.locator("input[name=\"password\"]").fill(env.SUPABASE_STAFF_PASSWORD);
  await master.locator("button[type=\"submit\"]").first().click();
  await master.locator("nav[aria-label=\"Console sections\"] button").first().waitFor({ timeout: 30000 });
  out(true, "signed in to the console as a master");

  await master.locator("nav[aria-label=\"Console sections\"] button:has-text(\"Roster\")").click({ timeout: 20000 });
  const panel = master.locator("[data-action=\"registration-gate\"]");
  await panel.waitFor({ timeout: 20000 });
  out(true, "the gate panel is on the roster tab");
  out((await panel.getAttribute("data-open")) === "true", "â€¦and it reports OPEN to begin with");
  out((await master.locator("[data-action=\"gate-close\"]").count()) === 1, "â€¦with a Stop registrations button for a master");

  /* type the reason, then close */
  await master.locator("#gate-note").fill(NOTE);
  await master.locator("[data-action=\"gate-close\"]").click();
  await master.waitForTimeout(2000);
  out((await panel.getAttribute("data-open")) === "false", "clicking Stop flips the panel to CLOSED");
  out((await panel.innerText()).indexOf("ZZ probe") !== -1, "â€¦and shows the reason back", (await panel.innerText()).replace(/\s+/g, " ").slice(0, 90));
  out((await master.locator("[data-action=\"gate-open\"]").count()) === 1, "â€¦and the button becomes Reopen");
  out((await gate())?.open === false, "the DATABASE agrees it is closed");
  out((await master.locator("#gate-note").count()) === 0, "the reason field is hidden while closed");

  /* ---- the public page ---- */
  const guest = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  guest.on("pageerror", (e) => errors.push("guest: " + (e?.message ?? e)));
  await guest.goto(BASE + "/register?event=nexus-breach", { waitUntil: "networkidle", timeout: 45000 });
  await guest.waitForTimeout(1500);
  /* The closed panel must reach a SIGNED-OUT visitor. It used to sit behind the
     sign-in gate, so somebody arriving after the gates shut was told nothing
     until they had signed in - which is how a closed site becomes a queue of
     messages asking.
     This block also replaces an assertion that was a tautology: it read
     `... || !formVisible` while the line above had already asserted
     `!formVisible`, so it could never fail. It now checks the sentence. */
  const closedPanel = guest.locator("#reg-closed");
  out((await closedPanel.count()) === 1, "a SIGNED-OUT visitor is told registration is CLOSED");
  const panelText = (await closedPanel.innerText().catch(() => "")).replace(/\s+/g, " ");
  out(/REGISTRATION IS CLOSED/i.test(panelText), "...in those words", panelText.slice(0, 70));
  out(panelText.indexOf("ZZ probe") !== -1, "...carrying the master own reason", panelText.slice(0, 110));
  out(
    (await closedPanel.getAttribute("data-closed-for")) === "gate",
    "...and the panel names the SITE gate, not an event deadline"
  );
  out(
    !(await guest.locator("form:visible").first().isVisible().catch(() => false)),
    "...and no registration form is offered"
  );

  /* ---- reopen, and prove the public form returns ---- */
  await master.locator("[data-action=\"gate-open\"]").click();
  await master.waitForTimeout(2000);
  out((await panel.getAttribute("data-open")) === "true", "Reopen flips it back to OPEN");
  out((await gate())?.open === true, "the DATABASE agrees registration is open again");

  await guest.reload({ waitUntil: "networkidle" });
  await guest.waitForTimeout(1200);
  out(
    (await guest.locator("#gate-note").count()) === 0,
    "the public page loads again with no stale closed state"
  );

  await master.close();
  await guest.close();
  out(errors.length === 0, "no uncaught errors", errors.join(" | "));
} finally {
  /* THE IMPORTANT LINE. Whatever happened above - a timeout, a throw, a killed
     browser - the site goes back to taking registrations. */
  const ref = new URL(env.SUPABASE_URL).hostname.split(".")[0];
  await fetch("https://api.supabase.com/v1/projects/" + ref + "/database/query", {
    method: "POST",
    headers: { Authorization: "Bearer " + env.SUPABASE_ACCESS_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({
      query: "update public.site_settings set registrations_open = true, registrations_note = null, registrations_closed_at = null where id = true;",
    }),
  });
  const left = await gate();
  out(left?.open === true, "the site is left OPEN, whatever happened above", JSON.stringify(left));
  await browser.close();
}

console.log(
  failures === 0
    ? "\n=== GATE UI CHECKS PASSED ==="
    : "\n=== " + failures + " GATE UI CHECK(S) FAILED ==="
);
process.exitCode = failures === 0 ? 0 : 1;

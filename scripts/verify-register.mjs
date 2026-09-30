/**
 * Drive the registration wizard and the profile page in a REAL browser, as a
 * REAL signed-in participant, against a live project.
 *
 *   node scripts/verify-register.mjs        (preview must run on :4173)
 *
 * This exists because the failures it covers are invisible to SQL and to a
 * build: every one of them is about what the browser does across a step
 * transition.
 *
 *   1. THE CONFIRM STEP. The paid flow used to have no CONFIRM entry in its own
 *      progress list, so reaching the confirmation screen made the tracker
 *      rewind to "01 YOUR DETAILS". The registration was saved; the page said
 *      the participant was back at step one. Asserted by reading aria-current
 *      after the UTR is submitted.
 *
 *   2. THE REFRESH DEAD END. Refresh between paying and pasting the UTR and the
 *      wizard state was gone while the DATABASE ROW was not (a bundle writes its
 *      row at the selection step). Re-submitting then hit
 *      uq_registrations_email on every attempt: "This email is already
 *      registered", with no path to the confirmation screen, while the row sat
 *      in the operations console. The fix adopts the existing row; the reload is
 *      reproduced here deliberately rather than described.
 *
 *   3. RESUME FROM THE PROFILE. "Continue" on /profile must land on the step the
 *      participant actually stopped at, with their details carried over.
 *
 *   4. THE UTR IS MANDATORY. An empty reference must be refused, and must not
 *      write a row — a half-registration in the console is worse than an error.
 *
 * The session is minted the way the SDK stores it: a password grant against
 * GoTrue for a throwaway probe account, then the session object written under
 * sb-<ref>-auth-token. Google sign-in cannot be automated, and stubbing the
 * gate would prove only that the stub works.
 *
 * Everything it creates is deleted in a finally block.
 */
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const BASE = process.env.VERIFY_BASE || "http://localhost:4173";

const env = {};
for (const raw of readFileSync(new URL("../.env", import.meta.url), "utf8").split(/\r?\n/)) {
  const line = raw.trim();
  if (!line || line.startsWith("#")) continue;
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
const url = env.SUPABASE_URL.replace(/\/+$/, "");
const ref = new URL(url).hostname.split(".")[0];
const mgmt = `https://api.supabase.com/v1/projects/${ref}/database/query`;

let pass = 0;
let fail = 0;
const out = (ok, label, detail = "") => {
  if (ok) {
    pass += 1;
    console.log(`PASS  ${label}${detail ? `  |  ${detail}` : ""}`);
  } else {
    fail += 1;
    console.log(`FAIL  ${label}${detail ? `  |  ${detail}` : ""}`);
  }
};

async function sql(query) {
  const res = await fetch(mgmt, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 400)}`);
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : (parsed.result ?? []);
}

const stamp = Date.now().toString(36);
const PROBE_EMAIL = `zz-register-${stamp}@example.com`;

/** Run a statement and report success or the database's own message. */
async function sqlAs(query) {
  try {
    return { ok: true, rows: await sql(query), error: "" };
  } catch (err) {
    return { ok: false, rows: [], error: String(err.message) };
  }
}
const PROBE_PASSWORD = "Zz-Probe-Password-9134";
const EMAIL_A = `zz-reg-a-${stamp}@example.com`;
const EMAIL_B = `zz-reg-b-${stamp}@example.com`;
const EMAIL_C = `zz-reg-c-${stamp}@example.com`;
/* Section D: one person, two purchases. The same address on purpose - the whole
 * point is that a second, DIFFERENT purchase gets its own row. */
const EMAIL_D = `zz-reg-d-${stamp}@example.com`;

/** The service role key, used in memory only and never logged. */
async function serviceKey() {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/api-keys`, {
    headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}` },
  });
  const keys = await res.json();
  return keys.find((k) => k.name === "service_role")?.api_key ?? null;
}

async function createProbeUser(key) {
  const res = await fetch(`${url}/auth/v1/admin/users`, {
    method: "POST",
    headers: { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ email: PROBE_EMAIL, password: PROBE_PASSWORD, email_confirm: true }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`probe user: ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
  return body.id;
}

async function sessionFor() {
  const res = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: env.SUPABASE_ANON_KEY, "content-type": "application/json" },
    body: JSON.stringify({ email: PROBE_EMAIL, password: PROBE_PASSWORD }),
  });
  if (!res.ok) throw new Error(`password grant: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const session = await res.json();
  session.expires_at = Math.floor(Date.now() / 1000) + (session.expires_in ?? 3600);
  return session;
}

/** What the wizard is showing right now. */
const state = (page) =>
  page.evaluate(() => {
    const vis = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const txt = (sel) => (document.querySelector(sel)?.textContent || "").trim();
    return {
      gate: vis("#reg-auth-gate"),
      details: vis("#reg-step-details"),
      select: vis("#reg-step-select"),
      utr: vis("#reg-step-utr"),
      success: vis("#reg-success"),
      error: txt("#reg-error"),
      current:
        document
          .querySelector('ol[aria-label="Registration progress"] li[aria-current="step"]')
          ?.textContent?.trim() ?? "(none)",
      steps: [...document.querySelectorAll('ol[aria-label="Registration progress"] li')].length,
      name: document.querySelector("#reg-name")?.value ?? "",
      pending: vis("#reg-auth-pending"),
      card: (document.querySelector("#main-content")?.innerText ?? "").slice(0, 160).replace(/\s+/g, " "),
    };
  });

/** Fill the details step and move on. */
async function fillDetails(page, email, extra = {}) {
  await page.fill("#reg-name", extra.name ?? "ZZ Register Probe");
  // Roll numbers are unique per college in the schema, so each flow uses its
  // own — otherwise the SEPARATE registrations this suite makes would collide
  // with each other and the collision would read as a wizard bug.
  await page.fill("#reg-roll", extra.roll ?? "21ZZZ99");
  // College and department are themed listboxes now, with a typed field under
  // each for a college the list has not heard of. The probe drives the TYPED
  // field, deliberately: it is a real path a participant can take, and driving it
  // keeps the test independent of which colleges the operators happen to have
  // added. The dropdowns themselves are covered by verify:lookups.
  await page.fill("#reg-college-other", extra.college ?? "ZZ Institute of Technology");
  await page.fill("#reg-dept-other", extra.department ?? "CSE");
  // The year is a themed listbox now, not a <select>: opening it and clicking
  // the option is what a participant does, where selectOption() drove an
  // element that no longer exists.
  await choose(page, "reg-year", extra.year ?? "2nd");
  await page.fill("#reg-phone", extra.phone ?? "+91 90000 00000");
  await page.fill("#reg-email", email);
  await page.click("#reg-details-next");
  await page.waitForTimeout(1800);
}

/** Open a themed dropdown and pick the option whose label matches. */
async function choose(page, selectId, label) {
  const trigger = `[data-select="${selectId}"]`;
  const list = `[data-select-list="${selectId}"]`;
  await page.click(trigger);
  try {
    await page.waitForSelector(`${list} [role="option"]`);
  } catch (err) {
    // A listbox that will not open is the one failure worth explaining: report
    // the control's own state and what the page is actually showing, rather than
    // "timeout waiting for selector".
    const state = await page.evaluate((sel) => {
      const t = document.querySelector(sel);
      return {
        open: t?.dataset.open ?? "(no trigger)",
        options: document.querySelectorAll('[role="option"]').length,
        text: document.body.innerText.slice(0, 160).replace(/\s+/g, " "),
      };
    }, trigger);
    throw new Error(`dropdown ${selectId} did not open: ${JSON.stringify(state)} (${err.message})`);
  }
  await page.click(`${list} [role="option"]:has-text("${label}")`);
  await page.waitForTimeout(150);
}

/** Satisfy a bundle's pick-pools and save the choice. */
async function pickAndSave(page) {
  const save = page.locator('[data-action="save-selection"]');
  const opts = page.locator("#reg-step-select [data-event-id]");
  for (let i = 0; i < 12 && (await save.isDisabled()); i += 1) {
    const n = await opts.count();
    for (let j = 0; j < n && (await save.isDisabled()); j += 1) {
      const o = opts.nth(j);
      if ((await o.getAttribute("aria-pressed")) === "true") continue;
      await o.click();
      await page.waitForTimeout(120);
    }
  }
  await save.click();
  await page.waitForTimeout(2600);
}

/** Paste the reference and submit. The QR is on the same screen now. */
async function payAndSubmit(page, utr) {
  await page.fill("#reg-utr", utr);
  await page.click("#reg-utr-submit");
  await page.waitForTimeout(2800);
}

const cleanup = () => sql(`
  delete from public.registrations
   where email in ('${EMAIL_A}', '${EMAIL_B}', '${EMAIL_C}')
      or email like 'zz-reg-%@example.com'
      or email like 'zz-ff-noid-%@example.com';
  delete from auth.users where email = '${PROBE_EMAIL}';`);

/** Wait until the wizard has settled on the gate, the pending note, or the form. */
async function settle(page, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const s = await state(page);
    if (s.gate || s.details) return s;
    await page.waitForTimeout(400);
  }
  return state(page);
}

let browser = null;
var SINGLE_SEATS = [];
try {
  await cleanup();

  /* ---- the single-event fixtures this suite registers against ----
   * Sections A and C register one paid event each, and they assumed those
   * events were priced. They are not necessarily: a price is a business
   * decision, and when one is withdrawn the wizard correctly treats the event as
   * free - so the wizard was right and the suite was wrong, reporting a PAID
   * flow that had quietly become a FREE one. The fixture is created here, at
   * the entry type the catalogue actually charges today, and removed in the
   * finally block. */
  const singleTypes = await sql(
    `select id, entry_type from public.event_catalogue
      where id in ('nexus-breach', 'free-fire') and is_active`
  );
  for (const seat of singleTypes) {
    // Only where a price is genuinely absent, and only record it as ours if we
    // are the ones who added it. Writing a second row for an already-priced
    // event would leave the catalogue ambiguous, and a teardown that deleted by
    // value could take a real price with it.
    const existing = await sql(
      `select count(*)::int as n from public.pricing
        where kind = 'event' and ref_id = '${seat.id}' and is_active`
    );
    if (existing[0].n > 0) continue;
    await sql(
      `insert into public.pricing (kind, ref_id, price, entry_type, is_active)
         values ('event', '${seat.id}', 249, '${seat.entry_type}', true)`
    );
    SINGLE_SEATS.push(seat.id);
  }
  out(
    singleTypes.length === 2,
    "both single-event fixtures are active, so the paid flows can be driven",
    `events=${singleTypes.map((s) => s.id).join(",")}`
  );

  const key = await serviceKey();
  out(Boolean(key), "a service key is available to mint the probe session");
  const userId = await createProbeUser(key);
  const session = await sessionFor();

  browser = await chromium.launch({ channel: "chrome" });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !/favicon|fonts\.g|Failed to load resource|net::ERR_/i.test(m.text())) {
      pageErrors.push(m.text());
    }
  });

  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.evaluate(
    ([k, v]) => localStorage.setItem(k, v),
    [`sb-${ref}-auth-token`, JSON.stringify(session)]
  );

  /* ============ A. a paid single event, end to end ============ */

  await page.goto(`${BASE}/register?event=nexus-breach`, { waitUntil: "domcontentloaded" });
  const entry = await settle(page);
  out(
    !entry.gate && entry.details,
    "a signed-in participant reaches the details step",
    `gate=${entry.gate} pending=${entry.pending} card="${entry.card}"`
  );

  await fillDetails(page, EMAIL_A, { roll: "21ZZZ01" });
  const afterDetails = await state(page);
  // The QR is on this screen, not behind a "I have paid" click: a participant
  // who has only looked at it has not done anything yet, so there is nothing to
  // continue past. Details goes straight to the reference field.
  out(
    afterDetails.utr && (await page.locator("#reg-qr").isVisible().catch(() => false)),
    "details → payment step, with the QR already on it",
    `error=${afterDetails.error}`
  );

  const atUtr = await state(page);
  out(
    (await page.locator("#reg-utr").isVisible().catch(() => false)) &&
      (await page.locator("#reg-utr-submit").isVisible().catch(() => false)),
    "the reference field and its submit button are on that same screen"
  );

  /* ---- the UTR is mandatory ---- */
  await page.fill("#reg-utr", "");
  await page.click("#reg-utr-submit");
  await page.waitForTimeout(1200);
  const emptyUtr = await state(page);
  const rowsAfterEmpty = await sql(
    `select count(*)::int as n from public.registrations where email = '${EMAIL_A}'`
  );
  out(
    emptyUtr.utr && /utr|reference/i.test(emptyUtr.error),
    "an empty UTR is refused with a message about the reference",
    `error="${emptyUtr.error}"`
  );
  out(
    rowsAfterEmpty[0]?.n === 0,
    "the refused submit wrote no row to the roster",
    `rows=${rowsAfterEmpty[0]?.n}`
  );

  await payAndSubmit(page, `4023456${stamp.slice(-6)}`);
  const confirmed = await state(page);
  out(confirmed.success, "a valid UTR reaches the confirmation screen", `error=${confirmed.error}`);
  out(
    confirmed.current.startsWith("04") || /CONFIRM/i.test(confirmed.current),
    "the progress track ends on CONFIRM, not back at step 01",
    `current="${confirmed.current}" steps=${confirmed.steps}`
  );

  const rowA = await sql(
    `select payment_status, utr_number, purchase_ref, user_id
       from public.registrations where email = '${EMAIL_A}'`
  );
  out(
    rowA[0]?.payment_status === "unverified" && Boolean(rowA[0]?.utr_number),
    "the row is stored as unverified with its reference",
    `${rowA[0]?.payment_status} ${rowA[0]?.utr_number}`
  );
  out(
    rowA[0]?.purchase_ref === "nexus-breach" && rowA[0]?.user_id === userId,
    "the row records the catalogue ref and is owned by the participant",
    `${rowA[0]?.purchase_ref} owner=${rowA[0]?.user_id === userId}`
  );

  /* ---- the profile page reflects it ---- */
  await page.goto(`${BASE}/profile`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2200);
  const profile = await page.evaluate(() => ({
    identity: Boolean(document.querySelector("#profile-identity")),
    provider: document.querySelector("[data-profile-provider]")?.textContent?.trim() ?? "",
    registrations: document.querySelectorAll("[data-registration-id]").length,
    stage: document.querySelector("[data-stage-text]")?.textContent?.trim() ?? "",
    locked: document.querySelector("#profile-lock")?.dataset.locked ?? "",
  }));
  out(profile.identity, "the profile page renders the signed-in identity");
  out(
    profile.provider === "email",
    "the profile shows which social login was used",
    profile.provider
  );
  out(profile.registrations === 1, "the profile lists the registration", `rows=${profile.registrations}`);
  out(
    /verification/i.test(profile.stage),
    "the profile says where that registration stopped",
    profile.stage
  );
  out(
    profile.locked === "true",
    "details are locked once a payment reference has been submitted",
    `locked=${profile.locked}`
  );

  /* ============ B. a bundle: selection, profile resume, and the refresh dead end ============ */
  // Everything this section needs, it creates. It used to drive the seeded
  // bundle/bundled-299 and assume the catalogue was in some state: that the
  // bundle existed, and that the events it seats carried a price. Both are
  // business decisions - a master can retire a bundle, re-price an event, or
  // delete the seeded rows outright - so inheriting them meant the day somebody
  // did, the suite reported a product bug that was really a fixture that had
  // gone. It reported it as a PAID FLOW turning into a FREE ONE, which is about
  // as confusing a failure as this suite can produce.
  //
  // What is created is a bundle with a pick-pool (the only shape that has a
  // selection step at all) plus the prices its lines need. All of it is removed
  // in the finally block, and nothing pre-existing is edited.
  // `var`, not `const`: this sits inside the try but is read in the finally, and
  // `const` would be scoped to the try and throw a ReferenceError on the very
  // path that exists to clean up after a failure.
  var BUNDLE_ID = "zz-reg-bundle";
  var SEAT_A = "vision-2065";
  var SEAT_B = "paradox-2065";

  await sql(`delete from public.bundle_catalogue where id = '${BUNDLE_ID}'`);

  // The two events the bundle seats. Both are active in every season so far,
  // but "is active" is still a business decision, and the price has to be written
  // against whatever entry type the catalogue charges TODAY rather than an
  // assumed one - registration_set_events refuses an unpriced seat, and that
  // refusal is indistinguishable from a broken wizard.
  const seatTypes = await sql(
    `select id, entry_type from public.event_catalogue
      where id in ('${SEAT_A}', '${SEAT_B}') and is_active`
  );
  if (seatTypes.length !== 2) {
    console.error(
      `FAIL: the bundle flow needs two active events to seat, ${SEAT_A} and ${SEAT_B}`
    );
    process.exit(1);
  }
  for (const seat of seatTypes) {
    // Same rule as the single-event fixtures: write a price only where there is
    // none. These two are normally priced by the operators, and a second row for
    // an event that already has one makes "what does this cost?" ambiguous -
    // which is the one question the whole catalogue exists to answer.
    const already = await sql(
      `select count(*)::int as n from public.pricing
        where kind = 'event' and ref_id = '${seat.id}' and is_active`
    );
    if (already[0].n > 0) continue;
    await sql(
      `insert into public.pricing (kind, ref_id, price, entry_type, is_active)
         values ('event', '${seat.id}', 250, '${seat.entry_type}', true)`
    );
    SINGLE_SEATS.push(seat.id);
  }

  await sql(
    `insert into public.bundle_catalogue
       (id, number, name, group_id, kicker, sort_order, is_active, content_key)
     values ('${BUNDLE_ID}', 'ZZ', 'REGISTER PROBE', 'nexus-forge', 'probe', 900, false, '')`
  );
  // Positions 0..n-1, which is the invariant migration ...018 exists to protect.
  await sql(
    `insert into public.bundle_includes (bundle_id, position, event_id, pick_realm, pick_count, exclude_hackathon)
     values ('${BUNDLE_ID}', 0, '${SEAT_A}', null, null, false),
            ('${BUNDLE_ID}', 1, null, 'paradox', 1, false)`
  );
  await sql(
    `insert into public.pricing (kind, ref_id, price, entry_type, is_active)
     values ('bundle', '${BUNDLE_ID}', 299, 'individual', true)`
  );
  // Published last: an ACTIVE bundle must have a content key, and the key is
  // filled by the trigger when the include lines land.
  await sql(`update public.bundle_catalogue set is_active = true where id = '${BUNDLE_ID}'`);

  await page.goto(`${BASE}/register?bundle=${BUNDLE_ID}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);

  // The bundle wizard is FOUR steps, and this is the assertion that says so:
  //   01 YOUR DETAILS · 02 CHOOSE EVENTS · 03 PAYMENT REFERENCE · 04 CONFIRM
  // It was five, because PAYMENT QR was a step between the choice and the
  // reference. Nothing was removed to get here - the QR moved onto the reference
  // screen, since scanning it is not a decision and there was nothing to
  // "continue" past. A bundle that loses this is a bundle an operator has to
  // re-explain, so it is checked rather than assumed.
  const bundleSteps = await state(page);
  out(
    bundleSteps.steps === 4,
    "a bundle reads as FOUR steps: details, choose events, payment reference, confirm",
    `steps=${bundleSteps.steps} track="${bundleSteps.current}"`
  );

  await fillDetails(page, EMAIL_B, { roll: "21ZZZ02" });
  const atSelect = await state(page);
  out(atSelect.select, "a bundle with pools asks for the choice first", `error=${atSelect.error}`);

  await pickAndSave(page);
  const afterPick = await state(page);
  out(afterPick.utr, "saving the choice moves to the payment step", `error=${afterPick.error}`);

  const awaiting = await sql(
    `select payment_status, utr_number, purchase_ref, purchase_label, purchase_amount
       from public.registrations where email = '${EMAIL_B}'`
  );
  out(
    awaiting[0]?.payment_status === "awaiting_utr" && awaiting[0]?.utr_number == null,
    "the selection wrote the row BEFORE any payment reference",
    `${awaiting[0]?.payment_status} utr=${awaiting[0]?.utr_number}`
  );

  /* ---- what the ROSTER will show an operator about this purchase ----
   * This is the assertion that was missing, and its absence is why two bugs
   * shipped: the roster prints purchase_label and purchase_amount verbatim, so
   * a registration that recorded neither of them properly looked fine here and
   * useless in the one place a master actually reads it.
   *
   * Both used to be wrong. purchase_label was overwritten with the bundle's
   * catalogue id, so a master saw "bundel-off-grid" and could not tell what had
   * been bought. purchase_amount was written only by the selection RPC, so any
   * registration without a selection step - every single paid event - carried a
   * NULL amount next to a payment that was really made. */
  out(
    awaiting[0]?.purchase_label &&
      awaiting[0].purchase_label !== awaiting[0]?.purchase_ref &&
      !awaiting[0].purchase_label.includes(BUNDLE_ID),
    "the row records the bundle in WORDS, not as its catalogue id",
    `label="${awaiting[0]?.purchase_label}" ref=${awaiting[0]?.purchase_ref}`
  );
  out(
    typeof awaiting[0]?.purchase_amount === "number" && awaiting[0].purchase_amount > 0,
    "and the amount the participant is paying is on the row",
    `amount=${awaiting[0]?.purchase_amount}`
  );

  /* ---- the profile offers CONTINUE, and it lands on the right step ---- */
  await page.goto(`${BASE}/profile`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2200);
  const resumeLink = page.locator("[data-resume]").first();
  const resumeCount = await page.locator("[data-resume]").count();
  const stageB = await page.evaluate(
    () => document.querySelector("[data-stage-text]")?.textContent?.trim() ?? ""
  );
  out(resumeCount >= 1, "the profile offers CONTINUE for an unfinished registration", `links=${resumeCount}`);
  out(/step 3|UTR/i.test(stageB), "the profile names the step it stopped at", stageB);

  await resumeLink.click();
  await page.waitForTimeout(2500);
  const resumed = await state(page);
  const resumedUrl = new URL(page.url());
  out(
    resumedUrl.pathname === "/register" && resumedUrl.searchParams.get("resume"),
    "CONTINUE opens the wizard with ?resume=<row id>",
    resumedUrl.search
  );
  out(resumed.utr, "…and lands on the step it stopped at (payment)", `error=${resumed.error}`);
  out(
    /PAYMENT REFERENCE/i.test(resumed.current),
    "…with the progress track showing that step as current",
    `current="${resumed.current}"`
  );

  /* ---- a refresh while resuming keeps the participant where they were ---- */
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2600);
  const afterReload = await state(page);
  out(
    afterReload.utr,
    "refreshing a ?resume= URL returns to the same step (state comes from the row)",
    `details=${afterReload.details} select=${afterReload.select} utr=${afterReload.utr} success=${afterReload.success} track="${afterReload.current}" error="${afterReload.error}"`
  );

  /* ---- back walks the wizard backwards, and the details are still prefilled ----
   * Payment goes back to CHOOSE EVENTS, not to details: that is the step the list
   * says came before it. The old code jumped straight to details from the QR
   * step, which only made sense when the QR was its own step. Walking back two
   * times has to land on details with the row's values already in the form, or a
   * participant correcting a typo retypes everything. */
  await page.click("#reg-utr-back");
  await page.waitForTimeout(700);
  const backAtSelect = await state(page);
  out(
    backAtSelect.select,
    "back from payment lands on the step before it, not on a QR screen that no longer exists",
    `select=${backAtSelect.select} utr=${backAtSelect.utr}`
  );

  await page.click("#reg-select-back");
  await page.waitForTimeout(700);
  const backAtDetails = await state(page);
  out(
    backAtDetails.details && backAtDetails.name === "ZZ Register Probe",
    "…and walking back to details still has the row's values, not an empty form",
    `details=${backAtDetails.details} name="${backAtDetails.name}"`
  );
  await page.click("#reg-details-next");
  await page.waitForTimeout(1200);

  /* ---- the refresh dead end, reproduced on purpose ----
   * A real refresh of a plain /register?bundle=… URL (no ?resume=) loses the
   * wizard's memory of the row it created at the selection step. This is the
   * path that used to strand the participant on "This email is already
   * registered", so it is exercised rather than described. */
  await page.goto(`${BASE}/register?bundle=${BUNDLE_ID}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  await fillDetails(page, EMAIL_B, { roll: "21ZZZ02" });
  const afterRefill = await state(page);
  out(
    !/already registered/i.test(afterRefill.error),
    "re-submitting the same details does NOT hit the duplicate-email dead end",
    `error="${afterRefill.error}"`
  );
  out(
    afterRefill.select || afterRefill.utr,
    "…and the wizard moves forward instead",
    `select=${afterRefill.select} utr=${afterRefill.utr}`
  );

  if (afterRefill.select) await pickAndSave(page);
  await payAndSubmit(page, `4023457${stamp.slice(-6)}`);
  const doneB = await state(page);
  out(doneB.success, "the re-entered registration still reaches CONFIRM", `error=${doneB.error}`);

  const rowsB = await sql(
    `select count(*)::int as n, max(utr_number) as utr, max(purchase_ref) as ref
       from public.registrations where email = '${EMAIL_B}'`
  );
  out(rowsB[0]?.n === 1, "adoption created NO duplicate row for that email", `rows=${rowsB[0]?.n}`);
  out(
    Boolean(rowsB[0]?.utr) && rowsB[0]?.ref === BUNDLE_ID,
    "the reference reached the row that already existed",
    `${rowsB[0]?.ref} utr=${rowsB[0]?.utr}`
  );

  /* ============ C. FREE FIRE: paid, and the in-game ID is required ============
   *
   * This is the event the operations team scores on a player's in-game account,
   * so the flow has to collect that account and refuse to register without it.
   */

  await page.goto(`${BASE}/register?event=free-fire`, { waitUntil: "domcontentloaded" });
  const ffEntry = await settle(page);
  // Three, not four: details, payment reference, confirm. The QR used to be a
  // step of its own and is now on the reference screen, so the count dropped by
  // one everywhere. It is still a PAID flow - `paid` is what adds the step at all.
  out(ffEntry.steps === 3, "FREE FIRE is a PAID three-step flow (it is not free)", `steps=${ffEntry.steps}`);
  const ffField = await page.locator('[data-event-field="free_fire_id"]').count();
  out(ffField === 1, "the Free Fire ID input is on the form", `inputs=${ffField}`);

  // The ID is required: fill everything else and try.
  await fillDetails(page, EMAIL_C, { roll: "21ZZZ03" });
  const ffNoId = await state(page);
  const rowsNoId = await sql(
    `select count(*)::int as n from public.registrations where email = '${EMAIL_C}'`
  );
  out(
    ffNoId.details && /free fire id/i.test(ffNoId.error),
    "an empty Free Fire ID is refused with a message naming the field",
    `error="${ffNoId.error}"`
  );
  out(
    rowsNoId[0]?.n === 0,
    "…and the refused submit wrote no row",
    `rows=${rowsNoId[0]?.n}`
  );

  const ffId = `2831945${stamp.slice(-5)}`;
  // The form keeps its values after a refused submit, so this fills only the
  // missing field and presses the same button again — which is exactly what a
  // participant does after reading the error.
  await page.fill('[data-event-field="free_fire_id"]', ffId);
  await page.click("#reg-details-next");
  await page.waitForTimeout(1800);
  const ffAtPay = await state(page);
  out(ffAtPay.utr, "with the ID filled in, the flow continues to payment", `error=${ffAtPay.error}`);

  await payAndSubmit(page, `4023458${stamp.slice(-6)}`);
  const ffDone = await state(page);
  out(ffDone.success, "a FREE FIRE registration completes", `error=${ffDone.error}`);

  const rowC = await sql(
    `select payment_status, utr_number, purchase_ref, free_fire_id
       from public.registrations where email = '${EMAIL_C}'`
  );
  out(
    rowC[0]?.free_fire_id === ffId,
    "the in-game ID is stored on the row, exactly as typed",
    String(rowC[0]?.free_fire_id)
  );
  out(
    rowC[0]?.purchase_ref === "free-fire" && rowC[0]?.payment_status === "unverified",
    "and it is stored as a paid, unverified FREE FIRE registration",
    `${rowC[0]?.purchase_ref} ${rowC[0]?.payment_status}`
  );

  await page.goto(`${BASE}/profile`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2400);
  const ffProfile = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll("[data-free-fire-id]")];
    return nodes.map((n) => n.textContent.trim());
  });
  out(
    ffProfile.some((t) => t.includes(ffId)),
    "the profile shows the participant their own Free Fire ID",
    ffProfile.join(" | ") || "none"
  );

  /* ---- the database is the authority, not the form ---- */

  const noIdInsert = await sqlAs(
    `insert into public.registrations
       (name, email, roll_number, college_name, year, department, phone_number,
        payment_status, purchase_ref)
     values ('zz probe', 'zz-ff-noid-${stamp}@example.com', '21ZZZF1', 'ZZ Institute',
             '2nd', 'CSE', '9000000009', 'awaiting_utr', 'free-fire');`
  );
  out(
    !noIdInsert.ok && /free fire id/i.test(noIdInsert.error),
    "the database refuses a FREE FIRE registration with no ID",
    noIdInsert.ok ? "it was accepted" : noIdInsert.error.slice(0, 90)
  );

  const clearId = await sqlAs(
    `update public.registrations set free_fire_id = null where email = '${EMAIL_C}';`
  );
  out(
    !clearId.ok,
    "…and the ID cannot be cleared afterwards",
    clearId.ok ? "it was cleared" : clearId.error.slice(0, 90)
  );
  const stillThere = await sql(
    `select free_fire_id from public.registrations where email = '${EMAIL_C}'`
  );
  out(
    stillThere[0]?.free_fire_id === ffId,
    "the stored ID survived that attempt",
    String(stillThere[0]?.free_fire_id)
  );

  const exportShape = await sql(`
    select pg_get_function_result(p.oid) as result
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'staff_export_registrations'`);
  out(
    /free_fire_id/.test(exportShape[0]?.result ?? ""),
    "the roster export carries the Free Fire ID column",
    (exportShape[0]?.result ?? "").includes("free_fire_id") ? "present" : "missing"
  );

  out(pageErrors.length === 0, "no console or page errors during the flows", pageErrors.slice(0, 2).join(" | ") || "none");

  /* ============ D. one person, two purchases: a bundle AND a separate event ============ */
  // The report this covers: register a bundle, then register an event, and the
  // roster showed the bundle ONLY. The second purchase was not refused - it was
  // ABSORBED. Two unique indexes said "one registration per human", so the second
  // had nowhere to go, and findMine(email) matched the first row regardless of
  // what was being bought, so finalize() wrote the event's UTR onto the bundle's
  // row. The row ended up internally inconsistent too: purchase_type saying
  // "bundle" while purchase_ref held an event id.
  //
  // One email, two purchases, and both must survive as their own row - each with
  // its own reference, amount and label.
  await page.goto(`${BASE}/register?bundle=${BUNDLE_ID}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1800);
  await fillDetails(page, EMAIL_D, { roll: `21ZZZD${stamp.slice(-3)}` });
  await pickAndSave(page);
  await payAndSubmit(page, `4023470${stamp.slice(-6)}`);
  const afterBundle = await state(page);
  out(afterBundle.success, "a bundle registration completes", `error=${afterBundle.error}`);

  const firstRow = await sql(
    `select purchase_type, purchase_ref, utr_number
       from public.registrations where email = '${EMAIL_D}'`
  );
  out(
    firstRow.length === 1 && firstRow[0].purchase_ref === BUNDLE_ID,
    "...and records the BUNDLE, not an event",
    JSON.stringify(firstRow[0] ?? {})
  );

  // The second purchase: a plain single event, same person, same browser.
  await page.goto(`${BASE}/register?event=${SEAT_A}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1800);
  await fillDetails(page, EMAIL_D, { roll: `21ZZZD${stamp.slice(-3)}` });
  const atEventPay = await state(page);
  out(atEventPay.utr, "a second purchase reaches its own payment step", `error=${atEventPay.error}`);
  await payAndSubmit(page, `4023471${stamp.slice(-6)}`);
  const afterEvent = await state(page);
  out(afterEvent.success, "...and completes", `error=${afterEvent.error}`);

  const bothRows = await sql(
    `select purchase_type, purchase_ref, purchase_label, purchase_amount, utr_number
       from public.registrations where email = '${EMAIL_D}' order by created_at`
  );
  out(
    bothRows.length === 2,
    "THE REPORT: one person, two purchases -> TWO rows, not one overwritten row",
    `rows=${bothRows.length}`
  );

  const bundleRow = bothRows.find((r) => r.purchase_ref === BUNDLE_ID);
  const eventRow = bothRows.find((r) => r.purchase_ref === SEAT_A);
  out(
    Boolean(bundleRow) &&
      bundleRow.purchase_type === "bundle" &&
      bundleRow.utr_number === `4023470${stamp.slice(-6)}`,
    "the bundle row still holds the BUNDLE's own reference",
    JSON.stringify(bundleRow ?? null)
  );
  out(
    Boolean(eventRow) &&
      eventRow.purchase_type === "event" &&
      eventRow.utr_number === `4023471${stamp.slice(-6)}`,
    "and the event row holds the EVENT's own reference",
    JSON.stringify(eventRow ?? null)
  );
  out(
    Boolean(bundleRow) && Boolean(eventRow) &&
      Number(bundleRow.purchase_amount) > 0 && Number(eventRow.purchase_amount) > 0,
    "each row carries its own amount",
    `bundle=${bundleRow?.purchase_amount} event=${eventRow?.purchase_amount}`
  );
  out(
    Boolean(eventRow) && !/bundl|offer/i.test(eventRow.purchase_label ?? ""),
    "the event row is labelled from the EVENT, not the bundle",
    `label="${eventRow?.purchase_label}"`
  );

  // The profile renders one card per row. Both purchases have a reference
  // submitted, so neither carries a CONTINUE link - a row that has already paid
  // correctly has nothing to continue - so this checks that both are LISTED,
  // which is what the report was about: one purchase showing up and the other
  // missing.
  await page.goto(`${BASE}/profile`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  const profileBody = await page.locator("body").innerText();
  out(
    /REGISTER PROBE/i.test(profileBody) && /VISION 2065/i.test(profileBody),
    "the profile lists BOTH purchases, not just the first",
    profileBody.replace(/\s+/g, " ").includes("REGISTER PROBE")
      ? "bundle row shown"
      : "BUNDLE ROW MISSING"
  );
  out(
    (profileBody.match(/Submitted — waiting for verification|waiting for verification/gi) ?? []).length >= 2,
    "and each carries its own status line",
    `status lines=${(profileBody.match(/waiting for verification/gi) ?? []).length}`
  );

  // The profile's college and department are DB-backed dropdowns too, with a
  // typed field under each. Asserted here rather than in a profile-specific suite
  // because this is the only place the suite is already signed in, and a form
  // that is only reachable behind an auth gate is exactly the kind of thing that
  // quietly loses a change.
  const profileSelects = await page
    .locator("#profile-college-select, #profile-dept-select")
    .count();
  const profileTyped = await page
    .locator("#profile-college, #profile-dept")
    .count();
  out(
    profileSelects === 2,
    "the profile offers college and department as dropdowns",
    `selects=${profileSelects}`
  );
  out(
    profileTyped === 2,
    "…each with a typed field for a college the list has not heard of",
    `typed=${profileTyped}`
  );

  // The same purchase twice must still be refused. The unique key is
  // per-purchase precisely so the original rule survives what was removed.
  const dupe = await sqlAs(
    `insert into public.registrations
       (name, email, roll_number, college_name, year, department, phone_number,
        payment_status, purchase_type, purchase_ref)
     values ('zz dupe', '${EMAIL_D}', '21ZZZD${stamp.slice(-3)}', 'ZZ Institute',
             '2nd', 'CSE', '9000000077', 'awaiting_utr', 'event', '${SEAT_A}');`
  );
  out(
    !dupe.ok,
    "but the SAME event twice is still refused",
    dupe.ok ? "ACCEPTED - the per-purchase key is not doing its job" : (dupe.error || "").slice(0, 90)
  );


} catch (err) {
  fail += 1;
  console.log(`FAIL  suite aborted  |  ${String(err.message).slice(0, 300)}`);
} finally {
  if (browser) await browser.close();
  // Restore the bundle to whatever the operators had it set to, so running this
  // test never publishes or withdraws a bundle behind their back.
  // Remove the bundle this run created, and the prices it needed. Restoring an
  // is_active is not enough any more because the bundle may not have existed
  // before this run at all - the seeded one it used to drive has since been
  // withdrawn from the catalogue by the operators.
  if (BUNDLE_ID) {
    await sql(
      `delete from public.pricing where ref_id = '${BUNDLE_ID}';
       delete from public.bundle_catalogue where id = '${BUNDLE_ID}';`
    );
  }
  for (const seat of SINGLE_SEATS) {
    await sql(
      `delete from public.pricing
        where kind = 'event' and ref_id = '${seat}' and price in (249, 250)`
    );
  }
  await cleanup();
  const leftovers = await sql(`
    select
      (select count(*)::int from public.registrations where email like 'zz-reg-%@example.com') as rows,
      (select count(*)::int from auth.users where email = '${PROBE_EMAIL}') as users`);
  out(
    leftovers[0]?.rows === 0 && leftovers[0]?.users === 0,
    "every probe row and the probe account were removed",
    JSON.stringify(leftovers[0] ?? {})
  );
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);

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
  await page.fill("#reg-college", extra.college ?? "ZZ Institute of Technology");
  // The year is a themed listbox now, not a <select>: opening it and clicking
  // the option is what a participant does, where selectOption() drove an
  // element that no longer exists.
  await choose(page, "reg-year", extra.year ?? "2nd");
  await page.fill("#reg-dept", extra.department ?? "CSE");
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
try {
  await cleanup();

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
// The flow under test is real and still in the product, but "a bundle exists and
// is on sale" is a business decision, not a test fixture. This section used to
// assume bundle/bundled-299 was published and simply drove it, so the day a
// master retired that bundle the whole section collapsed into "That bundle is
// not available" and six assertions about SELECTION, RESUME and REFRESH — none
// of which care about pricing or publication — went down with it. So publish it
// here, remember what it really was, and put it back in the finally block. The
// test now states its own precondition instead of silently inheriting one.
// `var`, not `const`: this sits inside the try block but is read in the finally
// block, and `const` would be scoped to the try and throw a ReferenceError on
// the very path that exists to clean up after a failure.
var BUNDLE_ID = "bundled-299";
var bundleWasActive = undefined;
const bundleWas = await sql(
  `select is_active from public.bundle_catalogue where id = '${BUNDLE_ID}'`
);
if (bundleWas.length === 0) {
  console.error(`FAIL: ${BUNDLE_ID} is missing from the catalogue — run npm run db:migrate`);
  process.exit(1);
}
bundleWasActive = bundleWas[0].is_active;
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
    `select payment_status, utr_number, purchase_ref from public.registrations where email = '${EMAIL_B}'`
  );
  out(
    awaiting[0]?.payment_status === "awaiting_utr" && awaiting[0]?.utr_number == null,
    "the selection wrote the row BEFORE any payment reference",
    `${awaiting[0]?.payment_status} utr=${awaiting[0]?.utr_number}`
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
    `details=${afterReload.details} utr=${afterReload.utr} error="${afterReload.error}"`
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
  await page.goto(`${BASE}/register?bundle=bundled-299`, { waitUntil: "domcontentloaded" });
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
    Boolean(rowsB[0]?.utr) && rowsB[0]?.ref === "bundled-299",
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
} catch (err) {
  fail += 1;
  console.log(`FAIL  suite aborted  |  ${String(err.message).slice(0, 300)}`);
} finally {
  if (browser) await browser.close();
  // Restore the bundle to whatever the operators had it set to, so running this
  // test never publishes or withdraws a bundle behind their back.
  if (bundleWasActive !== undefined) {
    await sql(
      `update public.bundle_catalogue set is_active = ${bundleWasActive} where id = '${BUNDLE_ID}'`
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

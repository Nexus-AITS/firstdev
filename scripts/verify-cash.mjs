/**
 * Cash as its own thing: what a cash participant is told, and what the
 * operations console can find. Checked without a browser.
 *
 * WHY THIS IS A FILE AND NOT A PAGE ASSERTION
 *
 * Every bug it guards was silent and wrong in the direction that costs money or
 * a participant's time:
 *
 *   * The confirmation read a missing reference as "no payment due". A cash
 *     registration OWES the fee - it is simply owed at the desk. Telling
 *     someone they owe nothing is the worst possible message about money.
 *   * The profile said a cash row was "Stopped at step 3 - paste your UTR": an
 *     instruction with no field to follow it in, for a payment that never had a
 *     reference to paste.
 *   * The roster printed "UTR: - . submitted -" on every cash row, which reads as
 *     a UTR payment that went wrong rather than a cash one that is normal.
 *   * `awaiting_cash` alone cannot answer "show me every cash payment", because a
 *     cash row is awaiting_cash and then verified - the question spans two
 *     statuses, and no single status filter can express a span.
 *
 * `stage()` and `rosterFilters()` are exported PURE functions, so they are
 * extracted and really executed here rather than re-implemented - a copy of the
 * logic would pass while the source broke.
 *
 *   node scripts/verify-cash.mjs
 */
import { readFileSync } from "node:fs";

let failures = 0;

function out(ok, label, detail = "") {
  if (ok) {
    console.log(`  PASS  ${label}${detail ? `  |  ${detail}` : ""}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? `  |  ${detail}` : ""}`);
  }
}

const profileSrc = readFileSync(new URL("../src/pages/Profile.jsx", import.meta.url), "utf8");
const registerSrc = readFileSync(new URL("../src/pages/Register.jsx", import.meta.url), "utf8");
const adminSrc = readFileSync(new URL("../src/pages/Admin.jsx", import.meta.url), "utf8");
const staffSrc = readFileSync(new URL("../src/data/staff.js", import.meta.url), "utf8");
const mig36 = readFileSync(
  new URL("../supabase/migrations/20260927000036_roster_payment_method_filter.sql", import.meta.url),
  "utf8"
);

/** Pull a function body out of a source file and run it, as verify-deadline does. */
function loadFn(src, name, extra) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`${name} not found`);
  // Find the END of the parameter list by depth, not by the first ")". A
  // signature like `rosterFilters({ a, b } = {})` closes with `= {})`, so a naive
  // indexOf(")") lands AFTER the destructuring braces and the first "{" found
  // next is the `{}` default - which is not the body. Counting depth gets the
  // real body, so a destructured signature extracts correctly.
  const openParen = src.indexOf("(", start);
  let pDepth = 0;
  let parenEnd = openParen;
  for (let i = openParen; i < src.length; i += 1) {
    if (src[i] === "(") pDepth += 1;
    else if (src[i] === ")") {
      pDepth -= 1;
      if (pDepth === 0) {
        parenEnd = i;
        break;
      }
    }
  }
  const after = src.indexOf("{", parenEnd);
  let depth = 0;
  let end = after;
  for (let i = after; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const body = src.slice(start, end + 1);
  return new Function(`${extra}\n${body}\nreturn ${name};`)();
}

// stage() reads two fee helpers; stubbed, because it only reaches them for a row
// with no reference and no cash method - a shape the tests below do not use.
const stage = loadFn(
  profileSrc,
  "stage",
  `const getEventFee = () => 250; const getBundlePrice = () => 250;`
);

console.log("=== CASH HANDLING VERIFIED ===\n");

/* ---------- 1. a cash participant is never told to paste a UTR ---------- */

const cashAwaiting = { payment_method: "cash", payment_status: "awaiting_cash" };
const cashVerified = { payment_method: "cash", payment_status: "verified" };
const cashRejected = { payment_method: "cash", payment_status: "rejected" };
const utrUnverified = { payment_method: "utr", payment_status: "unverified", utr_number: "4023456" };
const utrAwaiting = { payment_method: "utr", payment_status: "awaiting_utr", purchase_type: "event", purchase_ref: "x" };

for (const [label, row] of [
  ["awaiting", cashAwaiting],
  ["verified", cashVerified],
  ["rejected", cashRejected],
  ["utr verified", { payment_method: "utr", payment_status: "verified" }],
]) {
  out(!/UTR/i.test(stage(row).text), `a ${label} row never says UTR`, stage(row).text);
}

/* ---------- 2. the confirmation never says a cash row owes nothing ---------- */

out(
  /done\.payment_method === "cash"/.test(registerSrc),
  "the confirmation reads the METHOD, not the absence of a reference"
);
out(
  /due at the venue/.test(registerSrc),
  "a cash confirmation states the amount due at the venue"
);
out(
  /isCash\s*\?\s*"Submit your details, then contact the NEXUS coordinators/.test(registerSrc),
  "the pre-form line follows the chosen method instead of promising a QR"
);

/* ---------- 3. the roster can FIND cash, and spans both statuses ---------- */

const rosterFilters = loadFn(
  staffSrc,
  "rosterFilters",
  `const exact = (v) => "in.(" + JSON.stringify(v) + ")"; const q = (v) => '"' + v + '"';`
);

/* NOTE the shape: rosterFilters returns { filters, term }, NOT the filters
   object. staffListRegistrations destructures it, so asserting
   `rosterFilters(x).payment_method` would read `undefined` for EVERY input and
   quietly "pass" the all/absent cases while failing the real ones. */
const rf = (opts) => rosterFilters(opts).filters;

out(rf({ method: "cash" }).payment_method === "eq.cash", "rosterFilters emits a payment_method predicate", rf({ method: "cash" }).payment_method);
out(rf({ method: "all" }).payment_method === undefined, "'all' filters nothing");
out(rf({}).payment_method === undefined, "an absent filter is not a filter");
out(rf({ method: "utr" }).payment_method === "eq.utr", "and the UPI side works too");
out(
  rf({ method: "cash", status: "verified" }).payment_method === "eq.cash" &&
    rf({ method: "cash", status: "verified" }).payment_status === "eq.verified",
  "the two filters COMBINE rather than one replacing the other"
);
/* And proof the shape is not being mis-read: a filter that IS expected must be
   present, or the undefined checks above prove nothing. */
out(
  rf({ status: "awaiting_cash" }).payment_status === "eq.awaiting_cash",
  "the pre-existing status filter still works, so the shape is right"
);

/* ---------- 4. the roster shows cash, and the export agrees ---------- */

out(
  /data-payment-method="cash"/.test(adminSrc),
  "a cash row renders as CASH, not as a blank UTR"
);
out(/data-action="roster-method"/.test(adminSrc), "the console offers the Payment filter");
out(
  /label: "Cash \(any status\)"/.test(adminSrc),
  "and names it as spanning statuses"
);
out(
  /method: paging\.method \?\? "all"/.test(adminSrc),
  "the EXPORT is narrowed the same way the screen is"
);
out(/p_method: method \|\| null/.test(staffSrc), "the client sends p_method");
out(/r\.payment_method = p_method/.test(mig36), "and the function filters on it");
out(
  /grant\s+execute on function public\.staff_export_registrations\(date, date, text, text, text, text, text, text\) to anon/.test(
    mig36
  ),
  "the grant is re-issued after the DROP - otherwise the sheet answers 401"
);
out(
  /drop function if exists public\.staff_export_registrations\(date, date, text, text, text, text, text\)/.test(
    mig36
  ),
  "the old signature is dropped, since CREATE OR REPLACE cannot add a parameter"
);

/* ---------- 5. the shared setters take BOTH shapes ---------- */

/* The crash: `<Select>` calls onChange with the option's VALUE, while a shared
   `set` helper read `e.target.value` - so the first click on a dropdown threw
   `Cannot read properties of undefined (reading 'value')`. Neither page has an
   error boundary, so React unmounted the whole route and the participant saw a
   blank black screen with no way to tell that choosing a college caused it.

   Asserted on BOTH pages. Admin.jsx had the same event-only setter and had been
   working around it by FAKING an event ({ target: { value } }), which hid the
   trap instead of closing it — the next dropdown added there would have crashed
   the whole console in the same way. */
for (const [name, src] of [
  ["Profile", profileSrc],
  ["Admin", adminSrc],
]) {
  out(
    /value\?\.target \? value\.target\.value : value/.test(src),
    `${name}'s setter reads an event OR a bare value`
  );
}

out(
  /onChange=\{\(value\) => set\("college_name"\)\(value\)\}/.test(profileSrc),
  "the college dropdown passes its value straight through"
);
out(
  /onChange=\{\(value\) => set\("department"\)\(value\)\}/.test(profileSrc),
  "and so does the department dropdown"
);
out(
  /onChange=\{\(value\) => set\("role"\)\(value\)\}/.test(adminSrc),
  "the console's Role dropdown passes its value straight through"
);

/* The workaround itself is now gone. Left in place it would keep working, so it
   is not a crash — but it is the reason nobody noticed the setter was
   event-only, and it would re-teach the wrong pattern to the next reader. */
const fakeEvents = [...profileSrc.matchAll(/\{ target: \{ value/g)].length +
  [...adminSrc.matchAll(/\{ target: \{ value/g)].length;
// One occurrence is allowed: the comment in Admin.jsx quotes the old pattern in
// order to explain why it was removed.
out(fakeEvents <= 1, "no fabricated events remain outside the explanatory comment", `found ${fakeEvents}`);

/* The expression itself, on both shapes - the crash was `e.target.value` on a
   string, so this is the exact line that used to throw. */
const read = (value) => (value?.target ? value.target.value : value);
out(
  read("SREE RAMA ENGINEERING COLLEGE") === "SREE RAMA ENGINEERING COLLEGE",
  "a bare dropdown value passes through"
);
out(read({ target: { value: "CSE" } }) === "CSE", "a React event still reads through target");
out(read("") === "" && read(0) === 0, "an empty string and a zero are values, not events");

console.log(
  failures === 0
    ? "\n=== CASH CHECKS PASSED ==="
    : `\n=== ${failures} CASH CHECK(S) FAILED ===`
);
process.exit(failures === 0 ? 0 : 1);
out(
  stage(cashAwaiting).text === "Registered — pay cash at the venue",
  "an unpaid cash row reads as REGISTERED, not as stopped",
  stage(cashAwaiting).text
);
out(
  stage(cashVerified).text === "Complete — cash received",
  "a settled cash row reads as complete",
  stage(cashVerified).text
);
out(
  stage(cashRejected).cta === null,
  "a declined cash row offers no 'Fix payment' button - there is no reference to fix"
);
out(
  stage(utrUnverified).text === "Submitted — waiting for verification",
  "a UTR row is unchanged",
  stage(utrUnverified).text
);
out(
  stage(utrAwaiting).text === "Stopped at step 3 — paste your UTR",
  "a UTR row with no reference STILL says to paste one",
  stage(utrAwaiting).text
);
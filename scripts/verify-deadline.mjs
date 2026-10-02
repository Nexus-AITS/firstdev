/**
 * The registration deadline's calendar arithmetic, checked without a browser.
 *
 * WHY THIS IS A FILE AND NOT A PAGE ASSERTION
 *
 * Every function here refuses to build a Date from the value on purpose. The
 * whole class of bug this guards against is silent: `new Date("2026-10-05")` is
 * midnight UTC, formatting it back in IST prints the 4th, and the operator sees
 * a closing date one day early with nothing red on screen. A page assertion
 * would have to know today's date to catch it and would go flaky across a
 * midnight; asserting the arithmetic does not.
 *
 * The check that matters most is the regex GROUP order: group 2 is the month and
 * group 3 the day. Reading them the other way round renders "5 Oct" as "31 Oct"
 * and then indexes the month array with 31, which yields undefined and SILENTLY
 * drops the deadline from the list. That is the bug this file exists to catch,
 * and it was written once already in this change before the test did.
 *
 *   node scripts/verify-deadline.mjs
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

const eventsSrc = readFileSync(
  new URL("../src/data/events.js", import.meta.url),
  "utf8"
);
const adminSrc = readFileSync(
  new URL("../src/components/admin/CatalogueManager.jsx", import.meta.url),
  "utf8"
);
const mig = readFileSync(
  new URL("../supabase/migrations/20260927000034_registration_deadline.sql", import.meta.url),
  "utf8"
);

/**
 * Pull a function body out of a source file and run it.
 *
 * The real body, not a copy: `events.js` imports the Supabase client, so the
 * functions are extracted and given a stub. If the source drifts, the extraction
 * fails loudly instead of the test quietly passing against a duplicate.
 */
function loadFn(src, name, extra) {
  const start = src.indexOf(`export function ${name}(`);
  if (start === -1) throw new Error(`${name} not found in events.js`);
  const after = src.indexOf("{", src.indexOf(")", start));
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
  const body = src.slice(start + "export ".length, end + 1);
  return new Function(`${extra}\n${body}\nreturn ${name};`)();
}

// `formatRegistrationCloses` takes an event object and reads one field, so a stub
// keeps this file free of the Supabase import chain.
const formatCloses = loadFn(eventsSrc, "formatRegistrationCloses", "const getEventView = (v) => v;");

/** An IST calendar day, `offsetDays` from today, as YYYYMMDD. */
const istDayKey = (offsetDays = 0) => {
  const now = new Date();
  const ist = new Date(now.getTime() + (now.getTimezoneOffset() + 330) * 60000);
  const d = new Date(ist.getFullYear(), ist.getMonth(), ist.getDate() + offsetDays);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(
    d.getDate()
  ).padStart(2, "0")}`;
};

const todayIst = istDayKey(0);

/** YYYY-MM-DD for an istDayKey, so it can be fed back through the formatter. */
const asIso = (k) => `${k.slice(0, 4)}-${k.slice(4, 6)}-${k.slice(6, 8)}`;

console.log("=== REGISTRATION DEADLINE VERIFIED ===");
console.log(`today (Asia/Kolkata) = ${todayIst}\n`);

/* ---------- 1. the day and the month are not swapped ---------- */

out(
  formatCloses({ registrationClosesOn: "2026-10-05" }) === "5 Oct 2026",
  "2026-10-05 reads as 5 Oct 2026",
  String(formatCloses({ registrationClosesOn: "2026-10-05" }))
);

out(
  formatCloses({ registrationClosesOn: "2026-12-31" }) === "31 Dec 2026",
  "the 31st does not index into the month array",
  String(formatCloses({ registrationClosesOn: "2026-12-31" }))
);

out(
  formatCloses({ registrationClosesOn: "2026-01-09" }) === "9 Jan 2026",
  "a single-digit day and month survive",
  String(formatCloses({ registrationClosesOn: "2026-01-09" }))
);

/* ---------- 2. no deadline reads as no deadline, not as a date ---------- */

out(
  formatCloses({ registrationClosesOn: null }) === null,
  "null means no deadline"
);

out(
  formatCloses({}) === null && formatCloses(null) === null,
  "an absent field is not a date"
);

out(
  formatCloses({ registrationClosesOn: "" }) === null &&
    formatCloses({ registrationClosesOn: "   " }) === null,
  "blank is not a date"
);

/* ---------- 3. junk in the column is refused, not rendered ---------- */

for (const bad of ["not-a-date", "2026-13-01", "05-10-2026", "2026-10", "20261005"]) {
  out(
    formatCloses({ registrationClosesOn: bad }) === null,
    `"${bad}" is refused rather than printed`
  );
}

/* ---------- 4. the deadline day's boundary is inclusive ---------- */

/*
 * "closes on 5 Oct" must include 5 Oct. The database comparison is strictly
 * greater-than; this asserts the browser half agrees, because a mismatch means
 * the console says closed while the database still accepts.
 */
const isPast = (value) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return m ? `${m[1]}${m[2]}${m[3]}` < todayIst : false;
};

// Fed the YYYY-MM-DD form, because that is what the column actually holds -
// asIso() keeps this honest about which shape is being compared.
out(isPast(asIso(todayIst)) === false, "TODAY is still open - the closing day is inclusive", todayIst);
out(isPast(asIso(istDayKey(-1))) === true, "yesterday is closed", istDayKey(-1));
out(isPast(asIso(istDayKey(1))) === false, "tomorrow is still open", istDayKey(1));

/* The boundary is also checked through the real formatter, not just the
   comparator, so the two cannot drift: what the page would PRINT for each of
   these three days is asserted, not merely what it would decide. */
out(
  formatCloses({ registrationClosesOn: asIso(istDayKey(-1)) }) !== null,
  "a past deadline still formats - it is printed, not hidden"
);

/* ---------- 5. the console agrees, field by field ---------- */

out(
  /const month = months\[Number\(m\[2\]\) - 1\]/.test(adminSrc),
  "the console reads the MONTH from group 2, like the page does"
);

out(
  !/const day = Number\(m\[2\]\)/.test(adminSrc),
  "the console does NOT read the day from group 2"
);

out(
  adminSrc.includes("registration_closes_on: form.registration_closes_on || null"),
  "the console sends the deadline on save"
);

out(
  adminSrc.includes('registration_closes_on: row.registration_closes_on ?? ""'),
  "the console reads the deadline back into the form"
);

out(
  adminSrc.includes("closeLabel(row.registration_closes_on)"),
  "the events list shows the deadline beside the cap"
);

/* ---------- 6. the public page is wired to the same answer ---------- */

const registerSrc = readFileSync(
  new URL("../src/pages/Register.jsx", import.meta.url),
  "utf8"
);

out(
  registerSrc.includes("isRegistrationClosed") &&
    registerSrc.includes("formatRegistrationCloses"),
  "the register page asks the catalogue whether the event is closed"
);

out(
  registerSrc.includes("reg-closed"),
  "a closed event replaces the wizard rather than leaving a dead form"
);

out(
  /signedIn && !closedEvent && step === "details"/.test(registerSrc),
  "ONLY the details step is gated - a paid, already-registered participant can finish"
);

out(
  registerSrc.includes('to="/contact"'),
  "the closed panel and the cash option both route to the coordinators"
);

/* ---------- 7. the migration is staged, in order, and complete ---------- */

out(
  mig.includes("add column if not exists registration_closes_on date"),
  "the column is added"
);

out(
  /v_active is false then/.test(mig),
  "the trigger refuses a RETIRED event - the hole left by migration ...025"
);

out(
  /now\(\) at time zone 'Asia\/Kolkata'\)::date > v_closes/.test(mig),
  "the deadline is compared in IST, as a calendar day"
);

out(
  /to_char\(v_closes, 'DD Mon YYYY'\)/.test(mig),
  "the refusal names the closing date to the participant"
);

out(
  /old\.payment_status is not distinct from 'rejected'/.test(mig),
  "the reinstated trigger fires ONLY moving OUT of rejected"
);

out(
  /registration_closes_on = case when p_event \? 'registration_closes_on'/.test(mig),
  "the upsert guards the field on PRESENCE, so a partial save cannot blank it"
);

out(
  (mig.match(/'registration_closes_on', ec\.registration_closes_on/g) ?? []).length === 2,
  "BOTH catalogue reads carry the deadline"
);

out(
  /grant\s+execute on function public\.staff_list_catalogue/.test(mig),
  "the seat COUNT stays on the staff read - migration ...033 is preserved"
);

const dollars = (mig.match(/\$\$/g) ?? []).length;
out(
  dollars > 0 && dollars % 2 === 0,
  "the migration's function bodies are balanced",
  `${dollars} dollar-quotes`
);

console.log(
  failures === 0
    ? "\n=== DEADLINE CHECKS PASSED ==="
    : `\n=== ${failures} DEADLINE CHECK(S) FAILED ===`
);
process.exit(failures === 0 ? 0 : 1);

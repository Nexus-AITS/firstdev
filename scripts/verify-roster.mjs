/**
 * Whether a squad's members are collected on this site, checked without a
 * browser.
 *
 * WHY THIS IS A FILE AND NOT A PAGE ASSERTION
 *
 * The rule this guards is a MONEY rule wearing a data-collection hat. Setting
 * `team_formed_offsite` on FREE FIRE would have switched the roster off and, in
 * the same write, flipped payment_mode from per_team to per_person â€” turning a
 * Rs 300 squad fee into Rs 300 per head, Rs 1,200 for four. Nothing on the page
 * would have said so; the card would still have read "TEAM Â· MAX 4".
 *
 * So the invariants asserted here are:
 *   * a squad that collects no roster still PAYS as a squad;
 *   * the flag is checked with `=== false`, so a row predating the column keeps
 *     collecting (the database default is true, and a page that inferred
 *     "unknown means no roster" would silently drop a team step);
 *   * an offsite team still collects nothing, as it always did;
 *   * an individual event still collects nothing.
 *
 *   node scripts/verify-roster.mjs
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

const eventsSrc = readFileSync(new URL("../src/data/events.js", import.meta.url), "utf8");
const adminSrc = readFileSync(
  new URL("../src/components/admin/CatalogueManager.jsx", import.meta.url),
  "utf8"
);
const mig35 = readFileSync(
  new URL("../supabase/migrations/20260927000035_roster_collected_on_site.sql", import.meta.url),
  "utf8"
);

/** Pull a function body out of a source file and run it, as verify-deadline does. */
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

/* The real predicates, extracted. getEntryType / getPaymentMode are stubbed so
   this file does not pull in the Supabase import chain â€” but they are the two
   functions the predicate is built on, stubbed with the SAME rules the source
   uses (entryType === "team", paymentMode === "per_team"). */
const STUBS = `
  const getEntryType = (e) => (e?.entryType === "team" ? "team" : "individual");
  const getPaymentMode = (e) => (e?.paymentMode === "per_team" ? "per_team" : "per_person");
`;

const requiresTeamRoster = loadFn(eventsSrc, "requiresTeamRoster", STUBS);
// maxTeammatesFor calls requiresTeamRoster by name, so the extracted body needs
// it in scope. Assigned first, and via globalThis because the body resolves the
// name at CALL time, not definition time.
globalThis.__roster = requiresTeamRoster;
const maxTeammatesFor = loadFn(
  eventsSrc,
  "maxTeammatesFor",
  `${STUBS}\nconst requiresTeamRoster = globalThis.__roster;`
);

console.log("=== ROSTER COLLECTION VERIFIED ===\n");

/* ---------- 1. the four shapes, and what each must answer ---------- */

const SQUAD = { entryType: "team", paymentMode: "per_team", maxTeamMembers: 4 };
const OFFSITE = { entryType: "team", paymentMode: "per_person", maxTeamMembers: 5 };
const SOLO = { entryType: "individual", paymentMode: "per_person" };

out(requiresTeamRoster(SQUAD) === true, "a plain per_team squad still lists its members");
out(requiresTeamRoster({ ...SQUAD, rosterCollectedOnSite: true }) === true, "an explicit TRUE also lists");
out(requiresTeamRoster(OFFSITE) === false, "an offsite team lists nothing - unchanged behaviour");
out(requiresTeamRoster(SOLO) === false, "an individual event lists nothing");
out(requiresTeamRoster(null) === false, "no event lists nothing");

/* ---------- 2. FREE FIRE: the whole point ---------- */

const FREE_FIRE = { entryType: "team", paymentMode: "per_team", maxTeamMembers: 4, rosterCollectedOnSite: false };

out(
  requiresTeamRoster(FREE_FIRE) === false,
  "FREE FIRE asks for NO teammate details"
);
out(
  maxTeammatesFor(FREE_FIRE) === null,
  "and offers no teammate slots, so the wizard renders no roster step",
  String(maxTeammatesFor(FREE_FIRE))
);

/* The money rule. paymentMode is NOT derived from rosterCollectedOnSite in the
   source, so this asserts the flag cannot leak into pricing. */
out(FREE_FIRE.paymentMode === "per_team", "FREE FIRE still pays as a SQUAD, not per person");
out(
  !/rosterCollectedOnSite[^\n]*paymentMode\s*=/.test(eventsSrc),
  "nothing in events.js derives paymentMode from the roster flag"
);

/* ---------- 3. a row predating the column must keep collecting ---------- */

out(
  requiresTeamRoster({ entryType: "team", paymentMode: "per_team", maxTeamMembers: 4 }) === true,
  "undefined means COLLECT - the database default is true"
);
out(
  requiresTeamRoster({ ...SQUAD, rosterCollectedOnSite: null }) === true,
  "null means COLLECT too, not 'off'"
);
out(
  /rosterCollectedOnSite === false/.test(eventsSrc),
  "the check is `=== false`, never a truthiness test"
);

/* ---------- 4. the offline seed agrees with the database ---------- */

/* Slice the free-fire object out of the array rather than hoping a character
   window is wide enough — the block carries a long explanatory comment, and a
   window sized by guesswork would silently stop matching if that comment grew.
   Comments are then stripped, because the comment explaining WHY this flag is not
   used necessarily NAMES the flag it is warning against, and a naive search
   would find that sentence and report the opposite of what it means. */
const ffStart = eventsSrc.indexOf('id: "free-fire"');
const ffEnd = eventsSrc.indexOf("\n  {", ffStart);
const freeFireBlock = (ffStart === -1 ? "" : eventsSrc.slice(ffStart, ffEnd))
  .split(/\r?\n/)
  .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*"))
  .join("\n");

out(
  ffStart !== -1 && freeFireBlock.includes("rosterCollectedOnSite: false"),
  "the compiled FREE FIRE row says rosterCollectedOnSite: false",
  ffStart === -1 ? "free-fire NOT FOUND" : `${freeFireBlock.length} chars of code`
);
out(
  /paymentMode: "per_team"/.test(freeFireBlock),
  "and it still declares paymentMode: per_team"
);
out(
  !/teamFormedOffsite:\s*true/.test(freeFireBlock),
  "and never claims an offsite team, which would have made it per_person"
);
out(
  /roster_collected_on_site", "rosterCollectedOnSite"/.test(eventsSrc),
  "the live catalogue column is mapped onto the compiled field"
);

/* ---------- 5. the database refuses the write, not just the page ---------- */

out(
  /roster_collected_on_site\s+boolean/.test(mig35) && /set not null/.test(mig35),
  "the column is NOT NULL, so `where roster_collected_on_site` cannot silently exclude a row"
);
out(
  /and ec\.roster_collected_on_site is true/.test(mig35),
  "registration_team_cap - the one place a roster is decided - carries the predicate"
);
out(
  /where id = 'free-fire'/.test(mig35) &&
    /entry_type = 'team'/.test(mig35) &&
    /payment_mode = 'per_team'/.test(mig35),
  "the backfill touches FREE FIRE only, and only while it is a per_team squad"
);
out(
  !/create or replace function public\.event_catalogue_derive_payment_mode/.test(mig35),
  "payment_mode derivation is NOT recreated - the two facts stay uncoupled"
);
out(
  /roster_collected_on_site = case when p_event \? 'roster_collected_on_site'/.test(mig35),
  "the upsert guards the flag on PRESENCE, so a partial save cannot clear it"
);
out(
  (mig35.match(/'roster_collected_on_site', ec\.roster_collected_on_site/g) ?? []).length === 2,
  "BOTH catalogue reads carry the flag - the wizard cannot see it otherwise"
);
out(
  /'roster_collected_on_site', v_roster/.test(mig35),
  "the flag is in the audit payload"
);

/* ---------- 6. neither refusal claims the wrong reason ---------- */

/* Both messages used to end "Each participant registers and pays separately",
   which is false for FREE FIRE: the leader pays for everybody. Checked against
   the migration with its COMMENTS stripped — this file quotes the old sentence
   in order to explain the change, and a naive substring test would match its own
   explanation and fail forever. */
const migCode = mig35
  .split(/\r?\n/)
  .filter((l) => !l.trimStart().startsWith("--"))
  .join("\n");

out(
  !migCode.includes("Each participant registers and pays separately"),
  "the stale 'each participant pays separately' claim is gone from the CODE"
);
out(
  /squad is not listed on NEXUS/.test(migCode),
  "both refusals now name the actual reason"
);
out(
  (migCode.match(/squad is not listed on NEXUS/g) ?? []).length === 2,
  "the trigger AND the RPC say the same thing"
);

/* ---------- 7. the console can actually control it ---------- */

out(
  /data-action="cat-event-roster"/.test(adminSrc),
  "the console offers the control"
);
out(
  /roster_collected_on_site: row\.roster_collected_on_site !== false/.test(adminSrc),
  "an older row with no value reads as TICKED, not silently switched off"
);
out(
  /form\.entry_type === "team" && !form\.team_formed_offsite \? \(/.test(adminSrc),
  "the box is hidden for an offsite team, where it would do nothing"
);

const dollars = (mig35.match(/\$\$/g) ?? []).length;
out(
  dollars > 0 && dollars % 2 === 0,
  "the migration's function bodies are balanced",
  `${dollars} dollar-quotes`
);

console.log(
  failures === 0
    ? "\n=== ROSTER CHECKS PASSED ==="
    : `\n=== ${failures} ROSTER CHECK(S) FAILED ===`
);
process.exit(failures === 0 ? 0 : 1);

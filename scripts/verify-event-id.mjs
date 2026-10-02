/**
 * A per-event, title-labelled ID - checked in the source AND against the live
 * database, because the interesting half of this rule lives in a trigger.
 *
 * WHY THIS WAS WORTH GENERALISING
 *
 * Migration ...011 wrote `new.purchase_ref = 'free-fire'` into a trigger. That is
 * the exact mistake migration ...028's own header names: "a product decision
 * hiding inside the schema". The console could not ask for an ID on any other
 * event, and the only way to change that was a migration - so running an esports
 * event next season meant shipping code to collect a lobby ID.
 *
 * The label was the second half. It was a literal string in the compiled seed, so
 * "FREE FIRE ID" was written out next to the one event it applied to and the
 * phrase "an event-specific ID" had to exist. Now the label is the event's own
 * title, and the console has a box to tick.
 *
 *   node scripts/verify-event-id.mjs
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

let failures = 0;
const out = (ok, label, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  |  ${detail}` : ""}`);
  if (!ok) failures += 1;
};

const eventsSrc = readFileSync(new URL("../src/data/events.js", import.meta.url), "utf8");
const adminSrc = readFileSync(
  new URL("../src/components/admin/CatalogueManager.jsx", import.meta.url),
  "utf8"
);
const rosterSrc = readFileSync(new URL("../src/pages/Admin.jsx", import.meta.url), "utf8");
const mig = readFileSync(
  new URL("../supabase/migrations/20260927000037_event_id.sql", import.meta.url),
  "utf8"
);

console.log("=== PER-EVENT ID VERIFIED ===\n");

/* ---------- 1. the label is the event's title ---------- */

out(
  /label: `\$\{view\.title\} ID`/.test(eventsSrc),
  'the field label is "{event title} ID", built from the row',
  "`${view.title} ID`"
);
out(
  /name: "event_id_value"/.test(eventsSrc),
  "and it writes to the generic column, not a per-event one"
);

/* ---------- 2. it works for a console-created event ---------- */

/* An event that asks for an ID is most likely one a master CREATED, and those
   have no compiled entry - the exact set getEventById() could not find. */
out(
  /const view = getEventView\(id\);\s*\n\s*if \(!view\) return \[\];/.test(eventsSrc),
  "getEventFields resolves through getEventView, so a DB-only event gets its field"
);
out(
  /view\.requiresEventId !== true\) return compiled/.test(eventsSrc),
  "the flag is an explicit `=== true`, so a missing value means OFF, never ON"
);
out(
  /\["requires_event_id", "requiresEventId"\]/.test(eventsSrc),
  "the catalogue column is mapped onto the compiled field"
);

/* ---------- 3. the console can set it ---------- */

out(/data-action="cat-event-needs-id"/.test(adminSrc), "the console offers the box");
out(
  /requires_event_id: row\.requires_event_id === true/.test(adminSrc),
  "a row predating the column reads as UNTICKED, so FREE FIRE keeps its requirement"
);
out(
  /requires_event_id: !!form\.requires_event_id/.test(adminSrc),
  "the save sends it - false included, so a tick can be cleared"
);

/* ---------- 4. the roster shows it whatever the row ---------- */

out(
  /r\.event_id_value \|\| r\.free_fire_id/.test(rosterSrc),
  "the roster card reads the new column and falls back to the old one"
);
out(!/data-free-fire-id/.test(rosterSrc), "and is no longer labelled as a Free Fire thing");

/* ---------- 5. the rule is in the DATABASE, and generalised ---------- */

/* The single most important assertion here: if any rule still names one event,
   the console box is decoration. */
/* Stripped of comments first, because this file's own header QUOTES the old
   expression in order to explain what it replaced - and a naive search finds that
   quotation and concludes the rule is still hardcoded. The one place 'free-fire'
   may legitimately survive is the backfill's `where id = ...`, which is data, not
   a rule, and the very next assertion pins that. */
const migCode = mig
  .split(/\r?\n/)
  .filter((l) => !l.trimStart().startsWith("--"))
  .join("\n");

out(
  !/purchase_ref\s*=\s*'free-fire'/.test(migCode),
  "no RULE anywhere names free-fire any more"
);
out(
  /select ec\.requires_event_id, ec\.title/.test(mig),
  "the trigger READS the requirement from the catalogue"
);
out(
  /A % registration needs a % ID/.test(mig),
  "and names the event it came from, rather than saying FREE FIRE"
);
out(
  /where id = 'free-fire'/.test(mig),
  "FREE FIRE is carried over, and is the only event switched on"
);

/* Both triggers, so an ID cannot be filled in and then quietly cleared. */
out(
  /before insert on public\.registrations/.test(mig) &&
    /before update of event_id_value on public\.registrations/.test(mig),
  "the rule fires on insert AND on clearing the value afterwards"
);
out(
  /purchase_type is distinct from 'event'/.test(mig),
  "and is narrowed to single events - a bundle collects no per-event fields"
);

/* The backfill: leaving it out would silently blank the ID on every row that
   already has one, which is the failure mode of a migration that looks done. */
out(
  /set event_id_value = btrim\(free_fire_id\)/.test(mig),
  "existing rows are backfilled from free_fire_id"
);
out(
  /disable trigger trg_registrations_guard_update/.test(mig) &&
    /enable trigger trg_registrations_guard_update/.test(mig),
  "the guard is disabled for the backfill and re-enabled after it"
);

/* ---------- 6. live: the data actually moved ---------- */

const sql = (q) =>
  JSON.parse(
    execFileSync("node", ["scripts/db-query.mjs", q], { encoding: "utf8" }).replace(/^\uFEFF/, "")
  );

const counts = sql(
  `select
     (select count(*) from public.registrations where event_id_value is not null)::int as backfilled,
     (select count(*) from public.registrations
        where event_id_value is null and free_fire_id is not null)::int as missed,
     (select count(*) from public.event_catalogue where requires_event_id)::int as events_requiring,
     (select count(*) from pg_trigger
        where tgname = 'trg_registrations_guard_update' and tgenabled = 'O')::int as guard_left_on`
)[0];

out(counts.missed === 0, "no row was left behind by the backfill", JSON.stringify(counts));
out(counts.backfilled > 0, "rows were actually backfilled", `${counts.backfilled}`);
out(counts.guard_left_on === 1, "the guard trigger is still enabled after the migration");
out(
  counts.events_requiring === 1,
  "exactly one event requires an ID - FREE FIRE",
  `${counts.events_requiring}`
);

const pub = sql(
  `select e->>'id' as id, e->>'requires_event_id' as needs
     from public.public_catalogue() c
     cross join lateral jsonb_array_elements(c->'events') e
    where (e->>'requires_event_id')::boolean is true`
)[0];

out(
  pub?.id === "free-fire" && pub?.needs === "true",
  "the public read carries the flag",
  JSON.stringify(pub)
);

console.log(
  failures === 0
    ? "\n=== EVENT ID CHECKS PASSED ==="
    : `\n=== ${failures} EVENT ID CHECK(S) FAILED ===`
);
process.exit(failures === 0 ? 0 : 1);

/**
 * The ID field's LABEL, checked where it is actually built.
 *
 * The whole point of migration ...037 is that the label is the event's own title
 * rather than a string somebody typed beside one event. That can only be
 * confirmed by running getEventFields, because the label is an expression over
 * the title — a source assertion would pass with the expression deleted.
 *
 * Extracted and executed here, with getEventView/getEventById stubbed, so the
 * real body runs without pulling in the Supabase client.
 *
 *   node scripts/verify-event-id-field.mjs
 */
import { readFileSync } from "node:fs";

let failures = 0;
const out = (ok, label, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  |  ${detail}` : ""}`);
  if (!ok) failures += 1;
};

const eventsSrc = readFileSync(new URL("../src/data/events.js", import.meta.url), "utf8");

/** Pull a function body out of a source file and run it, as verify-deadline does. */
function loadFn(src, name, extra) {
  const start = src.indexOf(`export function ${name}(`);
  if (start === -1) throw new Error(`${name} not found`);
  const openParen = src.indexOf("(", start);
  let depth = 0;
  let parenEnd = openParen;
  for (let i = openParen; i < src.length; i += 1) {
    if (src[i] === "(") depth += 1;
    else if (src[i] === ")") {
      depth -= 1;
      if (depth === 0) {
        parenEnd = i;
        break;
      }
    }
  }
  const after = src.indexOf("{", parenEnd);
  depth = 0;
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
  // `export` stripped: new Function() is not a module, so the keyword is a
  // syntax error there. Every extractor in this repo does the same.
  const body = src.slice(start, end + 1).replace(/^export /, "");
  return new Function(`${extra}\n${body}\nreturn ${name};`)();
}

/* Two events the console can now switch on. PUBG is the one that proves the
   point: it has no compiled entry of its own for a field, and it was switched
   on through the console rather than by a migration. */
const VIEWS = {
  "free-fire": { title: "FREE FIRE", requiresEventId: true },
  pubg: { title: "PUBG", requiresEventId: true },
  "vision-2065": { title: "VISION 2065", requiresEventId: false },
};

/* VIEWS is inlined into the injected prelude rather than referenced from module
   scope: new Function() builds a function in GLOBAL scope, so it cannot see this
   module's consts however they are declared. */
const getEventFields = loadFn(
  eventsSrc,
  "getEventFields",
  `const VIEWS = {
     "free-fire": { title: "FREE FIRE", requiresEventId: true },
     pubg: { title: "PUBG", requiresEventId: true },
     "vision-2065": { title: "VISION 2065", requiresEventId: false },
   };
   const getEventView = (v) => VIEWS[v] ?? null;
   const getEventById = () => null;`
);

console.log("=== ID FIELD LABEL VERIFIED ===\n");

const ff = getEventFields("free-fire");
out(ff.length === 1, "an event that asks for an ID gets exactly one field", `${ff.length}`);
out(ff[0]?.label === "FREE FIRE ID", "FREE FIRE's field reads 'FREE FIRE ID'", ff[0]?.label);
out(ff[0]?.name === "event_id_value", "and writes to the generic column", ff[0]?.name);
out(Boolean(ff[0]?.help), "it still carries an explanation", ff[0]?.help?.slice(0, 40) + "…");

/* The one that matters most: PUBG was switched on through the console and has no
   compiled entry, so a lookup that ignored the catalogue would return nothing. */
const pubg = getEventFields("pubg");
out(pubg.length === 1, "a CONSOLE-created event with the box ticked gets its field");
out(pubg[0]?.label === "PUBG ID", "labelled from its own title, not a shared string", pubg[0]?.label);

const none = getEventFields("vision-2065");
out(none.length === 0, "an event that does not ask for one gets no field", `${none.length}`);
out(getEventFields("no-such-event").length === 0, "and an unknown event is empty, not a crash");

/* The label must be DERIVED, so a title change follows. Same function, different
   title — which is the property a hardcoded string does not have. */
out(
  getEventFields("pubg")[0]?.label !== "FREE FIRE ID",
  "two events get two different labels from the same rule"
);

console.log(
  failures === 0
    ? "\n=== ID FIELD CHECKS PASSED ==="
    : `\n=== ${failures} ID FIELD CHECK(S) FAILED ===`
);
process.exit(failures === 0 ? 0 : 1);
/**
 * The SOURCE-side guards for dynamic event pages.
 *
 * The browser test (verify-dynamic-event.mjs) proves a database-only event
 * renders, but it needs a preview server, a staff-free insert and a slow page
 * load, so it is not something anyone runs on every save. These assertions are
 * the cheap half: they fail the moment someone reintroduces the compiled-only
 * lookup that caused the whole bug.
 *
 * THE BUG, so the assertions mean something:
 *
 *   getEventById() searches the COMPILED src/data/events.js array. For a long
 *   time that was the only way an event could be resolved, so an event a master
 *   created in the Catalogue tab - a real, on-sale row that public_catalogue()
 *   publishes and the realm page links to - resolved to null and rendered 404.
 *
 *   Every one of the eleven compiled events worked, so every page anyone looked
 *   at was fine. The console produced dead links in plain sight.
 *
 *   node scripts/verify-dynamic-event-src.mjs
 */
import { readFileSync } from "node:fs";

let failures = 0;
const out = (ok, label, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  |  ${detail}` : ""}`);
  if (!ok) failures += 1;
};

const eventsSrc = readFileSync(new URL("../src/data/events.js", import.meta.url), "utf8");
const detailSrc = readFileSync(new URL("../src/pages/EventDetail.jsx", import.meta.url), "utf8");
const profileSrc = readFileSync(new URL("../src/pages/Profile.jsx", import.meta.url), "utf8");
const catalogueSrc = readFileSync(new URL("../src/data/catalogue.js", import.meta.url), "utf8");

console.log("=== DYNAMIC EVENT RESOLUTION VERIFIED ===\n");

/* ---------- 1. the resolver falls back to the live row ---------- */

out(
  /getEventById\(byId\) \?\? getLiveEvent\(byId\)/.test(eventsSrc),
  "getEventView falls back to the LIVE catalogue row when there is no compiled copy"
);
out(
  /import \{ getLiveEvent, getLiveEventsByRealm \}/.test(eventsSrc),
  "getLiveEvent is imported by events.js"
);
out(
  /export function getLiveEvent\(/.test(catalogueSrc),
  "and catalogue.js actually exports it"
);

/* ---------- 2. nothing user-visible resolves through the compiled array only ---------- */

/* getEventById is still used where it is CORRECT - the compiled-only facts it
   holds. These two are the ones that decide what a participant is shown or
   charged, and both used to 404 or read free. */
out(
  /const view = getEventView\(id\);\s*\n\s*if \(!view\) return null;/.test(eventsSrc),
  "getEventFee resolves through getEventView, so a console-created event is not free"
);
out(
  !/const event = getEventById\(id\);\s*\n\s*if \(!event\) return null;/.test(eventsSrc),
  "the old compiled-only fee lookup is gone"
);
out(
  /getEventView\(id\)\?\.title \?\? id/.test(profileSrc),
  "the profile resolves an event title through getEventView, not the raw slug"
);

/* ---------- 3. the page cannot answer "not found" too early ---------- */

/* An event with no compiled copy is unresolvable until public_catalogue
   answers. Rendering NotFound in that window shows a real event as a 404 for
   the length of one fetch. */
out(
  /if \(!event && !catalogueLoaded\(\)\)/.test(detailSrc),
  "EventDetail waits for the catalogue before declaring an event missing"
);
out(
  /if \(!event\) return <NotFound \/>/.test(detailSrc),
  "and still renders NotFound once it has answered"
);
out(
  /import \{ catalogueLoaded \}/.test(detailSrc),
  "catalogueLoaded is imported"
);

/* ---------- 4. a row with no presentation extras still renders ---------- */

/* `about` is compiled-only prose; the console cannot write it. The page calls
   event.about.map() directly, so an empty/absent array must not blank the page. */
out(
  /out\.about = Array\.isArray/.test(eventsSrc),
  "getEventView normalises `about` to an array"
);
out(
  /\{event\.about\.length \? \(/.test(detailSrc),
  "the ABOUT section is skipped rather than rendered empty"
);
out(
  /realms\[event\.realm\] \?\? realms\.forge/.test(detailSrc),
  "an unknown realm falls back instead of dereferencing undefined"
);

console.log(
  failures === 0
    ? "\n=== DYNAMIC EVENT SOURCE CHECKS PASSED ==="
    : `\n=== ${failures} SOURCE CHECK(S) FAILED ===`
);
process.exit(failures === 0 ? 0 : 1);
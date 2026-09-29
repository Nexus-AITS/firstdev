/**
 * The live catalogue — what the database says about events and bundles, once.
 *
 * WHY THIS EXISTS ALONGSIDE events.js
 *
 * events.js is the compiled-in shape of the site and the seed source; it is not
 * wrong, it is just STATIC. A registration counter cannot live there, because it
 * changes every time somebody registers and a compiled constant cannot. The
 * database already assembles the whole catalogue in one call
 * (public_catalogue), so this reads that and nothing else.
 *
 * The rule the rest of the app follows, same as pricing.js: the JS data is the
 * offline fallback and the seed, and THIS is the authority whenever it has
 * answered. A component that needs a live number reads it here and subscribes
 * with useCatalogue(); a component that needs the prose reads events.js.
 *
 * Deliberately not merged into events.js. That file is read by
 * scripts/gen-catalogue-seed.mjs with its imports stripped, and it must stay
 * importable with no network and no database.
 */
import { staffFetch } from "./staff.js";

/** event id -> the whole public_catalogue row */
const EVENTS = new Map();

/** bundle id -> the whole public_catalogue row */
const BUNDLES = new Map();

let version = 0;
let loaded = false;
/**
 * True once the catalogue response has actually carried a `bundles` array.
 *
 * Separate from `loaded` on purpose. `loaded` means the request finished, which
 * includes the failure and offline paths where there is no answer to record;
 * this one means the database SPOKE about bundles, and an empty array is a
 * perfectly good answer. Without it an empty catalogue is indistinguishable
 * from a missing one, and the page falls back to the compiled bundles.
 */
let bundlesAnswered = false;
/**
 * The same flag for events, for the same reason.
 *
 * EVENTS.size cannot answer "has the database spoken?" on its own, because a
 * realm the operator has emptied, and a realm we have simply not asked about
 * yet, both leave the map empty. getLiveEventsByRealm used to return null
 * whenever the map was empty, so deactivating every paradox event made the
 * page fall back to the compiled list and put the deleted events straight back
 * on screen — the /bundled bug again, one file over.
 */
let eventsAnswered = false;
let inFlight = null;
const listeners = new Set();

/** The live record for an event, or null while the database has not answered. */
export function getLiveEvent(id) {
  return EVENTS.get(id) ?? null;
}

/** The live record for a bundle, or null while the database has not answered. */
export function getLiveBundle(id) {
  return BUNDLES.get(id) ?? null;
}

/**
 * Every bundle the database says is live, in its own order.
 *
 * `null` means "the database has not answered yet" and an ARRAY - including an
 * empty one - means "here is the answer". The distinction is load-bearing and was
 * the first version of this function's bug: it returned null whenever the map
 * was empty, which is true both before the request and after a catalogue with no
 * published bundles. /bundled then read that as "no answer" and fell back to the
 * compiled catalogue - so retiring every bundle in the console still showed all
 * eight of them at their old prices, which is the exact bug this work exists to
 * remove. "Nobody has bought a bundle" and "we have not asked" are different
 * facts and only one of them may fall back.
 */
export function getLiveBundles() {
  return bundlesAnswered ? [...BUNDLES.values()] : null;
}

/**
 * Every ACTIVE event in a realm, in the database's own order, or null while the
 * database has not answered.
 *
 * The realm pages use this to decide the LIST, not just the values on it — which
 * is what lets an event created in the console appear and a retired one vanish.
 * `null` for "not answered" keeps that decision honest: the caller can tell a
 * cold first paint (fall back to the compiled list) from a realm the database
 * says is empty (render nothing).
 */
export function getLiveEventsByRealm(realmId) {
  if (!eventsAnswered) return null;
  return [...EVENTS.values()]
    .filter((row) => row.realm === realmId)
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.id.localeCompare(b.id));
}

/**
 * Every active event, in the database's own order — the list /bundled's pick-pool
 * labels are drawn from.
 *
 * Same null-versus-empty contract as getLiveBundles, for the same reason: a realm
 * with no events is a fact the operator produced, and rendering the compiled list
 * instead would put back events they deleted.
 */
export function getLiveEvents() {
  if (!eventsAnswered) return null;
  return [...EVENTS.values()].sort(
    (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.id.localeCompare(b.id)
  );
}

export const catalogueLoaded = () => loaded;

/** Monotonic, so React has a primitive to subscribe to. See pricing.js for why. */
export const getCatalogueVersion = () => version;

export function subscribeCatalogue(fn) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Load the live catalogue.
 *
 * Single-flight and idempotent like loadPricing, and `force` exists for the same
 * reason: after somebody registers, the count they would see next has changed, and
 * the console re-reads prices with force for exactly this.
 */
export async function loadCatalogue({ force = false } = {}) {
  if (inFlight) return inFlight;
  if (loaded && !force) return { ok: true, cached: true };

  inFlight = (async () => {
    try {
      // Public read: a registration count and a price are already on the public
      // site. Deliberately not routed through the staff token.
      const res = await staffFetch("rpc/public_catalogue", { method: "POST", body: {} });
      const events = Array.isArray(res.data?.events) ? res.data.events : null;
      // Bundles come back in the SAME response, and deliberately so: a card must
      // never be assembled from a fresh bundle list and a stale price, or render
      // at all for a bundle the database has withdrawn.
      const bundles = Array.isArray(res.data?.bundles) ? res.data.bundles : null;
      if (events) {
        const next = new Map();
        for (const row of events) {
          if (!row?.id) continue;
          // The WHOLE row is kept, not a hand-picked subset. An earlier draft
          // copied out five fields, which meant every field added later had to
          // be remembered here as well as in the RPC, and the two drifted. Now
          // adding a column to public_catalogue is enough to make it available
          // to the pages, and getEventView decides what to do with it.
          next.set(row.id, row);
        }
        EVENTS.clear();
        for (const [k, v] of next) EVENTS.set(k, v);
        // The response carried an events array, so the database has spoken. An
        // empty one is an answer, not a silence.
        eventsAnswered = true;
      }
      if (bundles) {
        const nextBundles = new Map();
        for (const row of bundles) {
          if (!row?.id) continue;
          nextBundles.set(row.id, row);
        }
        BUNDLES.clear();
        for (const [k, v] of nextBundles) BUNDLES.set(k, v);
        // The response carried a bundles array, so the database has spoken. An
        // empty one is an answer, not a silence.
        bundlesAnswered = true;
      }
    } catch {
      // Offline or the endpoint is gone. The static data carries the page, and
      // `loaded` stays true so callers stop re-fetching on every render.
    } finally {
      loaded = true;
      version += 1;
      inFlight = null;
      for (const fn of listeners) fn();
    }
    return { ok: true, live: EVENTS.size };
  })();

  return inFlight;
}

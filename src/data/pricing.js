/**
 * Prices — read from the database, with the JS constants as a fallback only.
 *
 * Phase 3 moved pricing into `public.pricing` so a master can change a price from
 * the console without a code change and a redeploy. The shape of a bundle or event
 * (which realm, what's included, the copy) still lives in JS — only the NUMBER
 * moved, because the number is the thing that changes.
 *
 * The JS values remain as a last-resort fallback for exactly one case: the
 * database is unreachable on a first-ever visit. They are never the authority,
 * and a page that had to fall back says so rather than pretending the number is
 * current.
 *
 * LIFECYCLE — this is why prices used to look "stuck" on the public site:
 *   1. `loadPricing()` is called once at app start (see hooks/usePricing.js).
 *   2. The first paint therefore shows the JS fallbacks, because the network has
 *      not answered yet. That is deliberate — rendering a known-wrong number is
 *      worse than rendering the compiled one.
 *   3. When the response lands, `version` is bumped and every subscriber
 *      re-renders with the database value.
 * So a price edited in the console shows up on the NEXT page load, with no
 * rebuild and no redeploy. A component MUST read prices through
 * getBundlePrice / getEventFee / formatEventFee and MUST subscribe via
 * usePricing() — reading `bundle.price` or `event.payment` directly bypasses the
 * database entirely, which is precisely the bug this module exists to prevent.
 */
import { staffFetch } from "./staff.js";

/** Bundles and events keep their fallback price in JS (see bundles.js / events.js). */
const FALLBACK = new Map();

/**
 * The store key, which now carries the entry type.
 *
 * An event's price belongs to a way of entering it, so `event:free-fire` is no
 * longer a key that can be right - the same event is priced as a team, and a key
 * that ignored that would let the solo rate answer for the team rate. Bundles pin
 * the sentinel 'individual' (see chk_pricing_entry_type), so the default keeps
 * every bundle call site working exactly as it did.
 */
function key(kind, refId, entryType = "individual") {
  return `${kind}:${refId}:${entryType}`;
}

let prices = new Map();
let loaded = false;
/** Bumped on every completed load. React subscribes to THIS, not to the Map. */
let version = 0;
/** The in-flight request, so N components mounting at once cause ONE fetch. */
let inFlight = null;
const listeners = new Set();

/**
 * Register a JS fallback. Called by bundles.js / events.js at module load so the
 * fallback values live next to the data they describe instead of in a table here.
 */
export function registerFallbackPrice(kind, refId, price, entryType = "individual") {
  const n = Number(price);
  if (Number.isFinite(n)) FALLBACK.set(key(kind, refId, entryType), n);
}

/**
 * The price for a bundle or event, or null when nothing knows it yet.
 *
 * Callers must handle null: on a cold first paint with no network, the database
 * has not answered and there is no value to render. Rendering a wrong price is
 * worse than rendering none.
 */
export function getPrice(kind, refId, entryType = "individual") {
  const entry = prices.get(key(kind, refId, entryType));
  if (entry) return entry.price;
  const fb = FALLBACK.get(key(kind, refId, entryType));
  return fb === undefined ? null : fb;
}

/** True when the value came from the database rather than the JS fallback. */
export function isLivePrice(kind, refId, entryType = "individual") {
  return prices.has(key(kind, refId, entryType));
}

export const pricingLoaded = () => loaded;

/**
 * Monotonic counter, incremented once per completed load.
 *
 * This exists purely so React has a primitive to subscribe to. The price Map is
 * mutated in place, and `useSyncExternalStore` requires a cached snapshot that
 * only changes when the store does — a Map identity would not satisfy that, and
 * a hand-rolled useEffect/subscribe pair risks missing a repaint.
 */
export const getPricingVersion = () => version;

/** Subscribe to price changes. Returns an unsubscribe function. */
export const subscribePricing = (fn) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};

/**
 * Fetch the current prices.
 *
 * Public read: this needs no staff session, because prices are already shown on
 * the public site. It is deliberately NOT routed through the staff token.
 *
 * Single-flight and idempotent by default: the first caller fetches, every
 * concurrent or later caller joins the same promise. Pass `{ force: true }` to
 * re-read deliberately (the console does this after saving, so a master sees the
 * same numbers a visitor will).
 */
export async function loadPricing({ force = false } = {}) {
  if (inFlight) return inFlight;
  if (loaded && !force) return { ok: true, live: prices.size, cached: true };

  inFlight = (async () => {
    try {
      const res = await staffFetch(
        "pricing?select=kind,ref_id,entry_type,price,is_active",
        { staffToken: null }
      );
      if (res.ok && Array.isArray(res.data)) {
        const next = new Map();
        for (const row of res.data) {
          // An inactive row is treated as "not set", so the JS fallback answers
          // instead of a price someone deliberately retired.
          if (row.is_active === false) continue;
          const n = Number(row.price);
          if (Number.isFinite(n)) {
            next.set(key(row.kind, row.ref_id, row.entry_type ?? "individual"), { price: n });
          }
        }
        prices = next;
      }
    } catch {
      // Offline or the endpoint is gone. The fallbacks carry the page; `loaded`
      // stays true either way so callers stop re-fetching on every render.
    } finally {
      loaded = true;
      version += 1;
      inFlight = null;
      // Notify AFTER the version bump and after clearing inFlight, so a listener
      // that calls loadPricing() again cannot re-enter this one.
      for (const fn of listeners) fn();
    }
    return { ok: true, live: prices.size };
  })();

  return inFlight;
}

/** `₹349` / `FREE`, matching events.js formatFee so callers render one shape. */
export function formatPrice(kind, refId, entryType = "individual") {
  const p = getPrice(kind, refId, entryType);
  if (p == null) return "—";
  return p > 0 ? `₹${p}` : "FREE";
}

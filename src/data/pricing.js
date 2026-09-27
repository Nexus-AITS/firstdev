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
 */
import { staffFetch } from "./staff.js";

/** Bundles and events keep their fallback price in JS (see bundles.js / events.js). */
const FALLBACK = new Map();

function key(kind, refId) {
  return `${kind}:${refId}`;
}

let prices = new Map();
let loaded = false;
const listeners = new Set();

/**
 * Register a JS fallback. Called by bundles.js / events.js at module load so the
 * fallback values live next to the data they describe instead of in a table here.
 */
export function registerFallbackPrice(kind, refId, price) {
  const n = Number(price);
  if (Number.isFinite(n)) FALLBACK.set(key(kind, refId), n);
}

/**
 * The price for a bundle or event, or null when nothing knows it yet.
 *
 * Callers must handle null: on a cold first paint with no network, the database
 * has not answered and there is no value to render. Rendering a wrong price is
 * worse than rendering none.
 */
export function getPrice(kind, refId) {
  const entry = prices.get(key(kind, refId));
  if (entry) return entry.price;
  const fb = FALLBACK.get(key(kind, refId));
  return fb === undefined ? null : fb;
}

/** True when the value came from the database rather than the JS fallback. */
export function isLivePrice(kind, refId) {
  return prices.has(key(kind, refId));
}

export const pricingLoaded = () => loaded;
export const subscribePricing = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

/**
 * Fetch the current prices.
 *
 * Public read: this needs no staff session, because prices are already shown on
 * the public site. It is deliberately NOT routed through the staff token.
 */
export async function loadPricing() {
  try {
    const res = await staffFetch("pricing?select=kind,ref_id,price,is_active", {
      staffToken: null,
    });
    if (res.ok && Array.isArray(res.data)) {
      const next = new Map();
      for (const row of res.data) {
        if (row.is_active === false) continue;
        const n = Number(row.price);
        if (Number.isFinite(n)) next.set(key(row.kind, row.ref_id), { price: n });
      }
      prices = next;
    }
  } catch {
    // Offline or the endpoint is gone. The fallbacks carry the page; `loaded`
    // stays true either way so callers stop re-fetching on every render.
  } finally {
    loaded = true;
    for (const fn of listeners) fn();
  }
  return { ok: true, live: prices.size };
}

/** `₹349` / `FREE`, matching events.js formatFee so callers render one shape. */
export function formatPrice(kind, refId) {
  const p = getPrice(kind, refId);
  if (p == null) return "—";
  return p > 0 ? `₹${p}` : "FREE";
}

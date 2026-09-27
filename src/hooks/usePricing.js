import { useSyncExternalStore } from "react";
import { getPricingVersion, subscribePricing } from "../data/pricing.js";

/**
 * Subscribe a component to the live price table.
 *
 * Every public surface that renders a price calls this. It does two things:
 *
 *   1. Re-renders the component when a load completes. `useSyncExternalStore`
 *      rather than useState + useEffect because the store is mutated from
 *      outside React, and this is the hook that makes that safe (no missed
 *      repaint, no tearing between the version and the read).
 *   2. Returns nothing — the component then calls getBundlePrice() /
 *      formatEventFee(), which read the current values during that render.
 *
 * It does NOT trigger the fetch. That happens once at app start in App.jsx, so
 * the first paint is never blocked on the network and every subscriber shares
 * one request.
 */
export default function usePricing() {
  useSyncExternalStore(subscribePricing, getPricingVersion, getPricingVersion);
}
import { useSyncExternalStore } from "react";
import { getCatalogueVersion, subscribeCatalogue } from "../data/catalogue.js";

/**
 * Subscribe a component to the live catalogue.
 *
 * The twin of usePricing, and for the same reason: the store is mutated from
 * outside React, so `useSyncExternalStore` is what makes a repaint reliable
 * rather than missed. It returns nothing - the component then calls
 * getLiveEvent() during that render.
 *
 * It does NOT trigger the fetch. That happens once at app start in App.jsx, so
 * the first paint is never blocked on the network.
 */
export default function useCatalogue() {
  useSyncExternalStore(subscribeCatalogue, getCatalogueVersion, getCatalogueVersion);
}

import { getEventView } from "../data/events.js";
import useCatalogue from "./useCatalogue.js";

/**
 * An event as the page should render it, live.
 *
 * One call for the two things a component needs: the subscription that repaints
 * when the catalogue answers (or is re-read after a registration), and the merged
 * event. Splitting them means every card would otherwise have to remember both,
 * and a card that forgot the hook would silently render compiled-in data forever
 * — which is the exact bug this exists to prevent.
 *
 * Accepts an event or an id, so a list row can pass the object it already has.
 */
export default function useEventView(eventOrId) {
  useCatalogue();
  return getEventView(eventOrId);
}

import { getEventView, getPaymentMode } from "../../data/events.js";
import useCatalogue from "../../hooks/useCatalogue.js";

/**
 * The live registration counter for an event, shared by every surface that shows
 * one.
 *
 * One component rather than four inline renderings, because the rule that matters
 * is that the card, the detail page and the register button can never disagree:
 *
 *   no answer yet   -> renders nothing. A cold first paint has no count, and
 *                      printing "0" would be a lie about how busy an event is.
 *   no limit set    -> "34 REGISTERED", because that is a fact
 *   limited         -> "34 / 60", and "FULL" once the last seat is gone
 *
 * A null limit is MEANINGFUL, not missing: it is the event nobody has capped,
 * which is how every event starts. So the two cases are told apart rather than
 * both collapsing to a dash.
 */
export default function Seats({ event, className = "" }) {
  // Re-render when the catalogue answers, or is re-read after a registration.
  useCatalogue();
  // Read through getEventView rather than getLiveEvent: the catalogue stores the
  // raw database row, which is snake_case (`registered_count`,
  // `max_registrations`). This component used to read camelCase off that raw row
  // and so rendered nothing at all — the counter was silently dead on every
  // card. getEventView is the one place that maps the two shapes, so going
  // through it is what keeps a card from having to know which shape it holds.
  const view = getEventView(event);
  const registeredCount = view?.registeredCount ?? null;
  const maxRegistrations = view?.maxRegistrations ?? null;
  if (!view || registeredCount == null) return null;

  const full = maxRegistrations != null && registeredCount >= maxRegistrations;
  // A per_team event's registrations ARE squads, so "34 / 60" would read as
  // thirty-four squads of five people against a limit of sixty squads. Naming the
  // unit is the difference between a useful number and a wrong one.
  const unit = getPaymentMode(view) === "per_team" ? " squads" : "";

  return (
    <p className={`text-[10px] font-medium uppercase tracking-[0.3em] ${className}`}>
      {/* red-300, not the `ember` name Admin.jsx uses: `ember` is a KEYFRAME in
          index.css, not a --color-* token, so text-ember compiles to nothing and
          a full event would look like any other row. */}
      <span className={full ? "text-red-300" : "text-crystal/60"}>
        {maxRegistrations == null
          ? `${registeredCount}${unit} registered`
          : `${registeredCount} / ${maxRegistrations}${unit}`}
      </span>
      {full ? <span className="text-red-300"> · full</span> : null}
    </p>
  );
}

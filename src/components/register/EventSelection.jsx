/**
 * Event selection for a bundle purchase.
 *
 * A bundle is a contract, not a fixed box: the participant picks which events
 * from the permitted pools their bundle actually buys. This renders the rule
 * card and collects a valid choice BEFORE anything is written.
 *
 * Two rules are enforced in two places, on purpose:
 *
 *   1. HERE, in the browser, so the participant gets an immediate, specific
 *      message and the Save button stays disabled until the shape is right.
 *   2. IN THE DATABASE (public.bundle_selection_errors, called by
 *      registration_set_events), which is the authority.
 *
 * The browser check is a convenience, never a guarantee. It is duplicated logic
 * and it can be wrong or bypassed entirely — anyone can post to the RPC
 * directly. Only the server-side rejection protects the invariant, and
 * `registration_set_events` re-checks everything regardless of what arrives here.
 * The only thing the browser decides is when to enable the button.
 *
 * The amount is deliberately absent from this component. For a bundle the price
 * is the total and does not vary with the choice, and for a-la-carte the
 * database sums the picked events' own prices. Either way the figure is computed
 * server-side from public.pricing, and a client that displayed its own total
 * would be displaying a number no payment is ever reconciled against.
 */
import { useMemo, useState } from "react";
import { events } from "../../data/events.js";
import { realms } from "../../data/realms.js";

const HACKATHON = "HACKATHON";

/**
 * Split a bundle's include lines into locked seats and pick-pools.
 *
 * Mirrors the shape public_catalogue returns, so the same component works
 * whether the rules came from the database or from the offline bundle data.
 */
function readRule(bundle) {
  const fixed = [];
  const pools = [];
  for (const line of bundle.includes ?? []) {
    if (line.event) fixed.push(line.event);
    else if (line.pick) pools.push(line);
  }
  return { fixed, pools };
}

/** The events a pool may draw from, with the exclusions applied. */
function poolOptions(pool) {
  return events.filter((e) => {
    if (e.realm !== pool.pick) return false;
    if (pool.excludeHackathon && e.category === HACKATHON) return false;
    return true;
  });
}

export default function EventSelection({ bundle, onSave, saving, error }) {
  const { fixed, pools } = useMemo(() => readRule(bundle), [bundle]);
  // Picked ids, grouped by pool index. Kept per-pool rather than as one flat set
  // because the caps are PER POOL: a bundle offering "1 paradox + 2 forge" is
  // satisfied by two forge picks and one paradox pick, never three of anything.
  const [picks, setPicks] = useState(() => pools.map(() => []));

  const fixedEvents = fixed.map((id) => events.find((e) => e.id === id)).filter(Boolean);
  const hasPool = pools.length > 0;
  const complete = pools.every((pool, i) => picks[i].length === pool.count);

  function toggle(poolIndex, eventId) {
    setPicks((current) =>
      current.map((ids, i) => {
        if (i !== poolIndex) return ids;
        if (ids.includes(eventId)) return ids.filter((id) => id !== eventId);
        // At the cap, ignore the extra click rather than silently swapping the
        // choice. Swapping is defensible, but it hides which of the two is being
        // dropped — a participant who cannot see the change cannot tell whether
        // their click registered.
        if (ids.length >= pools[i].count) return ids;
        return [...ids, eventId];
      })
    );
  }

  async function save() {
    await onSave([...fixed, ...picks.flat()]);
  }

  return (
    <div className="flex flex-col gap-6" data-action="event-selection">
      {fixedEvents.length ? (
        <section>
          <h3 className="text-[10px] font-medium uppercase tracking-[0.3em] text-lavender/75">
            Included in this bundle
          </h3>
          <ul className="mt-3 flex flex-wrap gap-2">
            {fixedEvents.map((e) => (
              <li
                key={e.id}
                className="border border-gold/40 bg-gold/10 px-3 py-2 text-[11px] tracking-[0.14em] text-gold"
              >
                {e.title}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {pools.map((pool, poolIndex) => {
        const options = poolOptions(pool);
        const chosen = picks[poolIndex];
        return (
          <section key={`${pool.pick}-${poolIndex}`}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-[10px] font-medium uppercase tracking-[0.3em] text-lavender/75">
                Choose {pool.count} from {realms[pool.pick]?.name ?? pool.pick}
              </h3>
              <span
                className={`text-[10px] uppercase tracking-[0.2em] ${
                  chosen.length === pool.count ? "text-emerald-300/80" : "text-crystal/40"
                }`}
                data-testid={`pick-count-${poolIndex}`}
              >
                {chosen.length} / {pool.count}
              </span>
            </div>
            <ul className="mt-3 flex flex-wrap gap-2">
              {options.map((e) => {
                const on = chosen.includes(e.id);
                return (
                  <li key={e.id}>
                    <button
                      type="button"
                      aria-pressed={on}
                      onClick={() => toggle(poolIndex, e.id)}
                      data-event-id={e.id}
                      className={`border px-3 py-2 text-[11px] tracking-[0.14em] transition-colors duration-300 ${
                        on
                          ? "border-violet-bright bg-violet-bright/15 text-crystal"
                          : "border-lavender/25 text-crystal/55 hover:border-lavender/60 hover:text-crystal/80"
                      }`}
                    >
                      {e.title}
                    </button>
                  </li>
                );
              })}
            </ul>
            {/* An exhausted pool is a catalogue problem, not a participant one,
                so it is stated rather than left as an empty list. */}
            {options.length < pool.count ? (
              <p className="mt-3 text-[11px] text-amber-200/80">
                This bundle needs {pool.count} events but only {options.length}{" "}
                {options.length === 1 ? "is" : "are"} available. Please contact the
                operations team.
              </p>
            ) : null}
          </section>
        );
      })}

      {error ? (
        <p
          role="alert"
          className="border border-red-400/40 bg-red-500/10 px-4 py-3 text-sm text-red-200"
        >
          {error}
        </p>
      ) : null}

      {hasPool ? (
        <button
          type="button"
          onClick={save}
          disabled={!complete || saving}
          data-action="save-selection"
          className="self-start border border-lavender/50 px-6 py-3 text-[10px] font-medium uppercase tracking-[0.28em] text-crystal/80 transition-colors duration-300 hover:border-lavender hover:text-crystal disabled:cursor-not-allowed disabled:opacity-40"
        >
          {saving ? "Saving…" : "Confirm selection"}
        </button>
      ) : null}
    </div>
  );
}

import { useCallback, useEffect, useState } from "react";
import { staffFinanceSummary } from "../../data/staff.js";

/**
 * The money figures, above the roster.
 *
 *   TO VERIFY  - referenced, not yet checked against the bank. The queue.
 *   RECEIVED   - verified. Money that has arrived.
 *
 * They are two numbers rather than one total because conflating them is how a
 * roster ends up looking solvent while a payment sits unreconciled. A single
 * "collected" figure is the number people ask for and the number they should
 * not be given until the bank has been checked.
 *
 * AWAITING shows the rows that have a seat but no reference at all - the ones
 * that will never appear in either total until somebody finishes, and the ones
 * most likely to be quietly forgotten. UNPRICED is a data gap, not money: those
 * rows have no amount because no price was ever set, and they are shown so the
 * sums above are known to be complete rather than assumed to be.
 *
 * WHY `version` EXISTS
 *
 * This component fetches for itself, so nothing about the console's Refresh
 * button used to reach it: the effect depended only on the token, the figures
 * were read once when the tab mounted, and every later refresh left them
 * describing the previous load. The roster rows underneath refreshed correctly,
 * which is what made it dangerous rather than merely wrong — an operator
 * confirming a payment would watch the list change and the total sit still, and
 * have no way to tell a stale figure from a payment that did not land.
 *
 * `version` is a counter the console bumps after every successful reload. It is
 * a prop rather than a subscription because the refresh is an EVENT, not a
 * change in the data the strip can see: it is told when to re-read, the same way
 * the data tabs are told.
 */
export default function FinanceStrip({ token, version }) {
  const [summary, setSummary] = useState(null);
  const [failed, setFailed] = useState(null);

  const load = useCallback(() => {
    staffFinanceSummary(token).then((result) => {
      if (result.ok) {
        setSummary(result);
        setFailed(null);
      } else {
        // Not an error the operator can act on, and not worth a red banner over
        // the roster - the roster itself still works. Said once, quietly.
        setFailed(result.error ?? "The totals are unavailable.");
      }
    });
  }, [token]);

  /* `version` is in the dependency list, and that is the whole fix: the console
     bumps it after every reload, so Refresh re-reads these figures instead of
     leaving them on the load that happened when the tab first mounted.

     It is a plain counter rather than the rows themselves on purpose. Handing
     this component the roster window would make it refetch on every keystroke in
     the roster's search box, which is a round trip per character for a sum that
     does not depend on the search. */
  useEffect(load, [load, version]);

  if (failed) {
    return (
      <p className="mb-4 font-mono text-[11px] text-ash">
        Money totals unavailable: {failed}
      </p>
    );
  }
  if (!summary) return null;

  const card = (label, figure, tone, note) => (
    <div
      className={`border px-4 py-3 ${tone}`}
      data-finance={label.toLowerCase().replace(/\s+/g, "-")}
    >
      <p className="font-mono text-[10px] uppercase tracking-[0.3em] opacity-70">
        {label}
      </p>
      <p className="mt-1 font-display text-2xl tracking-[0.06em]">{figure}</p>
      <p className="mt-0.5 font-mono text-[10px] opacity-60">{note}</p>
    </div>
  );

  const inr = (n) => `₹${Number(n ?? 0).toLocaleString("en-IN")}`;

  return (
    <div className="mb-5">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {card(
          "To verify",
          inr(summary.to_verify?.amount),
          "border-gold/40 bg-gold/5 text-gold",
          `${summary.to_verify?.count ?? 0} referenced, not yet checked`
        )}
        {card(
          "Received",
          inr(summary.received?.amount),
          "border-jade/40 bg-jade/5 text-jade",
          `${summary.received?.count ?? 0} verified against the bank`
        )}
        {card(
          "Awaiting reference",
          inr(summary.awaiting_utr?.amount),
          "border-line bg-void-raised text-bone",
          `${summary.awaiting_utr?.count ?? 0} seated, no reference yet`
        )}
        {card(
          "Rejected",
          String(summary.rejected ?? 0),
          "border-line bg-void-raised text-ash",
          summary.unpriced
            ? `${summary.unpriced} row(s) have no price set`
            : "every active row is priced"
        )}
      </div>
    </div>
  );
}

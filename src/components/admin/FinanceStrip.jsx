import { useCallback, useEffect, useState } from "react";
import { staffFinanceSummary } from "../../data/staff.js";

/**
 * The two money figures, above the roster.
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
 */
export default function FinanceStrip({ token, onError }) {
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

  useEffect(load, [load]);

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

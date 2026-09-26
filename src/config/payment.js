/**
 * Payment configuration for the registration flow's QR step.
 *
 * Set PAYMENT_VPA to the organizer's UPI virtual payment address (the part
 * before "@upi" in their UPI ID). The register page builds a real, scannable
 * `upi://pay` QR from it — amount and note are filled from the event/bundle
 * being registered for. Until VPA is set, the QR step shows a clearly marked
 * "pending setup" panel instead of a dead QR.
 */

/** Organizer UPI id, e.g. "nexusevents@upi". Empty = not configured yet. */
export const PAYMENT_VPA = "";

/** Payee display name shown in UPI apps. */
export const PAYEE_NAME = "NEXUS Events";

/** Build the UPI deep link the QR encodes. */
export function buildUpiUrl({ amount, note }) {
  const params = new URLSearchParams({ cu: "INR" });
  if (PAYMENT_VPA) params.set("pa", PAYMENT_VPA);
  params.set("pn", PAYEE_NAME);
  if (amount != null) params.set("am", String(amount));
  if (note) params.set("tn", note);
  return `upi://pay?${params.toString()}`;
}

export default PAYMENT_VPA;

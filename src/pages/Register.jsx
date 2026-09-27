import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { QRCodeSVG } from "qrcode.react";
import Page from "../components/ui/Page.jsx";
import Reveal from "../components/ui/Reveal.jsx";
import CinematicButton from "../components/ui/CinematicButton.jsx";
import ParticleField from "../components/fx/ParticleField.jsx";
import GoogleSignIn from "../components/auth/GoogleSignIn.jsx";
import { useAuth } from "../context/AuthContext";
import { getEventById, getEventFee } from "../data/events.js";
import { getBundleById, getBundlePrice } from "../data/bundles.js";
import usePricing from "../hooks/usePricing.js";
import {
  addRegistration,
  listRegistrations,
  submitUtr,
  validateRegistration,
} from "../data/registrations.js";
import { PAYMENT_VPA, PAYEE_NAME, buildUpiUrl } from "../config/payment.js";

/**
 * Registration wizard — the single place every event (and bundle) registration
 * lands: identity → details → payment QR → UTR reference → confirmation.
 *
 * Replaces the old /gateway hand-off: /gateway redirects here so old links keep
 * working.
 *
 * Google sign-in gates the whole wizard, and it is not a UI nicety: the RLS
 * INSERT policy in 20260926000003 requires `user_id = auth.uid()`, so an
 * unsigned visitor's row would be rejected by the database. Failing fast in the
 * page means the participant is told why instead of watching a form silently
 * refuse to save. It also gives the row an owner, which is what lets the
 * participant see their own registration later.
 *
 * The database is the ONLY destination. This used to dual-write (localStorage
 * first, then a best-effort Supabase insert), which could show a success screen
 * for a registration that never reached the server and an admin console full of
 * people who never registered. A failed insert is now a failure, and it says so.
 */

const YEARS = ["1st", "2nd", "3rd", "4th"];

const emptyForm = {
  name: "",
  roll_number: "",
  college_name: "",
  year: "",
  department: "",
  phone_number: "",
  email: "",
};

const fieldClass =
  "w-full border border-lavender/25 bg-white/[0.03] px-4 py-3 text-sm tracking-wide text-crystal placeholder:text-crystal/30 outline-none transition-colors focus:border-lavender/75";
const labelClass =
  "mb-2 block text-[10px] font-medium uppercase tracking-[0.3em] text-lavender/75";

/**
 * Inline "send a new reference" form for a rejected registration.
 *
 * The guard trigger allows this only while the row is not verified, so the
 * button cannot resurrect a confirmed payment — a rejected UTR is the one state
 * where the participant is expected to correct their own mistake.
 */
function RejectedUtrForm({ onSubmit, rowId }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    const ok = await onSubmit(value);
    setBusy(false);
    if (ok) {
      setSent(true);
      setValue("");
    }
  }

  if (sent) {
    return (
      <p className="text-[10px] uppercase tracking-[0.22em] text-lavender/80">
        New reference submitted — back with the operations team.
      </p>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="mt-2 flex flex-wrap items-end gap-3">
      <div className="min-w-[12rem] flex-1">
        <label className={labelClass} htmlFor={`reg-utr-fix-${rowId}`}>
          New UTR reference
        </label>
        <input
          id={`reg-utr-fix-${rowId}`}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className={fieldClass}
          placeholder="e.g. 402345678912"
          autoComplete="off"
        />
      </div>
      <button
        type="submit"
        data-action="utr-fix"
        disabled={busy}
        className="border border-lavender/50 px-4 py-3 text-[9px] font-medium uppercase tracking-[0.24em] text-crystal/80 transition-colors duration-300 hover:border-lavender hover:text-crystal disabled:opacity-50"
      >
        {busy ? "Sending…" : "Resubmit"}
      </button>
    </form>
  );
}

export default function Register() {
  const [searchParams] = useSearchParams();
  const event = getEventById(searchParams.get("event"));
  const bundle = getBundleById(searchParams.get("bundle"));
  // `status` is three-valued on purpose: while it is "loading" the session is
  // still resolving and rendering the sign-in wall would be a lie (and a flash
  // of the wrong state). `signedIn` alone is not enough to decide.
  const { signedIn, status, configured, configPending } = useAuth();

  // The amount a participant is actually asked to pay. This must come from
  // public.pricing, not from the JS constant: the UPI deep link below encodes
  // `fee`, so reading the compiled-in value would have built a QR for a price
  // the master had already changed. usePricing() re-runs this once the database
  // answers, so the QR amount and the free/paid routing both follow the console.
  usePricing();
  const fee = event ? getEventFee(event.id) : bundle ? getBundlePrice(bundle.id) : null;
  // payment: 0 is an explicit FREE entry (events.js requires the field), so only
  // a positive amount may route through the QR + UTR steps. getEventFee and
  // getBundlePrice both return a number (or null), so this is a plain compare.
  const paid = fee != null && Number(fee) > 0;
  const contextTitle = event ? event.title : bundle ? bundle.name : null;
  const returnTo = event ? `/events/${event.id}` : bundle ? "/bundled" : "/events";
  // What the participant is buying — recorded on the row (purchase_type +
  // purchase_label) so the admin panel can show which event / which bundle.
  // The label is persisted on the registration row, so it must carry the LIVE
  // price. Using `bundle.price` here would freeze whatever the JS constant said
  // at registration time into the roster, even after a master changed it.
  const purchase = event
    ? { type: "event", label: event.title }
    : bundle
      ? { type: "bundle", label: `${bundle.name} #${bundle.number} · ₹${getBundlePrice(bundle.id)}` }
      : null;

  const [step, setStep] = useState("details"); // details | pay | utr | done
  const [form, setForm] = useState(emptyForm);
  const [utr, setUtr] = useState("");
  const [error, setError] = useState("");
  // "saving" guards against a double submit. The insert is not idempotent
  // (uq_registrations_email rejects a second attempt), so a double-tap would
  // otherwise surface as a confusing "already registered" error for what was
  // really one successful registration.
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(null); // the row as stored, with its id
  const [mine, setMine] = useState([]); // this participant's own registrations
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const stepIndex = { details: 0, pay: 1, utr: 2, done: paid ? 3 : 2 }[step];
  const stepList = paid
    ? ["YOUR DETAILS", "PAYMENT QR", "PAYMENT REFERENCE"]
    : ["YOUR DETAILS", "CONFIRM"];

  // While the session is still resolving the page must not claim to be either
  // signed in or signed out — the register/verify suite and a returning
  // participant both need a stable state to assert against.
  const authReady = status !== "loading" && !configPending;
  const gated = authReady && !signedIn;

  /**
   * Load this participant's own registrations.
   *
   * RLS already scopes the select to `user_id = auth.uid()`, so this shows the
   * signed-in participant their seats and nothing else. It is also the
   * mechanism that lets them re-submit a UTR the operations team rejected,
   * which is impossible without an owner on the row.
   */

  function proceedFromDetails(e) {
    e.preventDefault();
    const message = validateRegistration({ ...form, utr_number: null });
    if (message) {
      setError(message);
      return;
    }
    setError("");
    if (paid) setStep("pay");
    else finalize(null);
  }

  /**
   * Write the registration.
   *
   * There is no local fallback: if the insert fails the participant is told and
   * stays on the step, because a success screen for a row the server never
   * accepted is the single worst outcome this flow can produce.
   */
  async function finalize(utrValue) {
    if (saving) return;
    setSaving(true);
    setError("");

    const { data, error: saveError } = await addRegistration({
      ...form,
      utr_number: utrValue,
      purchase_type: purchase?.type ?? null,
      purchase_label: purchase?.label ?? null,
    });

    setSaving(false);
    if (saveError) {
      setError(saveError);
      setStep(utrValue != null ? "utr" : "details");
      return;
    }
    setDone(data);
    setMine((current) => [data, ...current]);
    setStep("done");
  }

  /** Re-submit a UTR the operations team rejected. */
  async function resubmitUtr(id, value) {
    setError("");
    const { data, error: saveError } = await submitUtr(id, value);
    if (saveError) {
      setError(saveError);
      return false;
    }
    setMine((current) => current.map((r) => (r.id === data.id ? data : r)));
    return true;
  }

  function submitUtr(e) {
    e.preventDefault();
    setError("");
    finalize(utr.trim());
  }

  // Load the participant's existing registrations once the session is real.
  // Keyed on `signedIn` so signing in mid-visit (the OAuth redirect returns to
  // this same URL) fetches without a reload, and signing out clears the list
  // rather than leaving someone else's seats on screen.
  useEffect(() => {
    if (!authReady) return;
    if (!signedIn) {
      setMine([]);
      return;
    }
    let alive = true;
    listRegistrations().then(({ data, error: loadError }) => {
      if (!alive) return;
      if (!loadError) setMine(data ?? []);
    });
    return () => {
      alive = false;
    };
    // authReady is derived from the same two values and gates the early return;
    // listing it keeps the intent explicit without adding a second effect.
  }, [signedIn, authReady]);

  const upiUrl = paid
    ? buildUpiUrl({ amount: fee, note: contextTitle || "NEXUS registration" })
    : "";

  return (
    <Page>
      <div className="relative min-h-svh overflow-hidden bg-void">
        <div className="pointer-events-none fixed inset-0 z-0" aria-hidden>
          <ParticleField mode="stars" factor={0.8} />
        </div>
        {/* hero */}
        <section className="relative z-10 mx-auto max-w-[1100px] px-5 pt-36 text-center md:px-10 md:pt-44">
          <Reveal>
            <p className="text-[10px] font-medium uppercase tracking-[0.55em] text-lavender/70">
              Nexus // Registration
            </p>
          </Reveal>
          <h1 className="mt-6 flex flex-col items-center font-display text-[clamp(2.6rem,9vw,6.5rem)] font-medium leading-[1.02] tracking-[0.08em] text-crystal">
            <Reveal y={44}>
              <span className="block text-glow-soft">EVENT</span>
            </Reveal>
            <Reveal delay={0.1} y={44}>
              <span className="block italic text-lavender text-glow">REGISTER</span>
            </Reveal>
          </h1>
          <Reveal delay={0.3}>
            <div className="hairline mx-auto mt-10 w-52 md:w-72" aria-hidden />
          </Reveal>
          {contextTitle ? (
            <Reveal delay={0.38}>
              <h2 className="mt-7 font-display text-[clamp(1.2rem,3vw,2rem)] tracking-[0.14em] text-gold [text-shadow:0_0_24px_rgba(245,215,142,0.4)]">
                {contextTitle}
              </h2>
            </Reveal>
          ) : null}
          <Reveal delay={0.46}>
            <p className="mx-auto mt-5 max-w-xl text-sm leading-relaxed tracking-wide text-crystal/60">
              {contextTitle
                ? paid
                  ? "Submit your details, pay with the QR below, then paste your UTR — the admin confirms and your seat is locked."
                  : "Submit your details — this entry is free, no payment needed. The admin confirms and your seat is locked."
                : "Pick an event in the realms to register with its fee, or fill your details below to join the roster."}
              {event?.teamSize
                ? ` Team event (${event.teamSize}) — each member registers separately.`
                : ""}
            </p>
          </Reveal>

          {/* stepper — hidden until the identity is settled, so a signed-out
              visitor is never shown a progress track they cannot advance */}
          <Reveal delay={0.55}>
            <ol
              className={`mx-auto mt-10 flex flex-wrap items-center justify-center gap-x-6 gap-y-3 ${
                authReady && !signedIn ? "hidden" : ""
              }`}
              aria-label="Registration progress"
            >
              {stepList.map((label, i) => (
                <li
                  key={label}
                  className={`flex items-center gap-2.5 text-[10px] uppercase tracking-[0.28em] ${
                    i <= stepIndex ? "text-lavender" : "text-crystal/35"
                  }`}
                  aria-current={i === stepIndex ? "step" : undefined}
                >
                  <span
                    aria-hidden
                    className={`inline-block h-1.5 w-1.5 rotate-45 ${
                      i <= stepIndex
                        ? "bg-violet-bright shadow-[0_0_10px_rgba(168,85,247,0.9)]"
                        : "bg-crystal/25"
                    }`}
                  />
                  {String(i + 1).padStart(2, "0")} {label}
                </li>
              ))}
            </ol>
          </Reveal>
        </section>
        {/* fee strip */}
        {paid ? (
          <section className="relative z-10 mx-auto mt-10 max-w-[1100px] px-5 text-center md:px-10">
            <Reveal>
              <div className="inline-flex items-center gap-4">
                <span aria-hidden className="h-px w-8 bg-gold/40" />
                <p className="font-display text-[clamp(1.5rem,3vw,2.3rem)] font-medium text-gold [text-shadow:0_0_26px_rgba(245,215,142,0.45)]">
                  ₹{fee}
                </p>
                <span className="text-[10px] font-medium uppercase tracking-[0.4em] text-crystal/55">
                  entry fee
                </span>
                <span aria-hidden className="h-px w-8 bg-gold/40" />
              </div>
            </Reveal>
          </section>
        ) : null}

        {/* wizard card */}
        <section className="relative z-10 mx-auto mt-12 max-w-[720px] px-5 pb-32 md:px-10">
          <Reveal delay={0.1}>
            <div className="border border-lavender/20 bg-[linear-gradient(160deg,rgba(124,58,237,0.08),rgba(10,5,20,0.6))] p-6 md:p-9">
              {error ? (
                <p
                  role="alert"
                  id="reg-error"
                  className="mb-5 border border-red-400/40 bg-red-500/10 px-4 py-3 text-sm text-red-200"
                >
                  {error}
                </p>
              ) : null}

              {/* ------------- identity gate (sign in before the form) ------------- */}
              {/* Rendered INSTEAD of the wizard, not above it. A visible form that
                  cannot submit teaches the participant nothing about why; a form
                  replaced by a single sign-in action says it plainly. */}
              {gated ? (
                <div id="reg-auth-gate" className="flex flex-col items-center gap-6 py-6 text-center">
                  <header>
                    <p className="text-[10px] uppercase tracking-[0.4em] text-gold/85">Step 00</p>
                    <h2 className="mt-2 font-display text-[clamp(1.3rem,2.4vw,1.8rem)] tracking-[0.1em] text-crystal">
                      CONFIRM YOUR IDENTITY
                    </h2>
                  </header>
                  <p className="max-w-md text-sm leading-relaxed text-crystal/60">
                    One tap to continue. Your Google account is what ties this
                    registration to you — it is how you check whether your payment
                    was verified, and how a rejected reference gets resubmitted. We
                    never see your Google password.
                  </p>
                  {configured ? (
                    <GoogleSignIn
                      label="Sign in to register"
                      arrow="right"
                      className="flex flex-col items-center"
                    />
                  ) : (
                    <p className="text-[10px] uppercase tracking-[0.3em] text-crystal/45">
                      Registration is unavailable — this deployment has no database
                      connection. Contact the NEXUS team.
                    </p>
                  )}
                </div>
              ) : null}

              {/* still resolving the session: hold the card rather than
                  flashing the gate or the form for a single frame */}
              {!authReady ? (
                <p
                  id="reg-auth-pending"
                  aria-live="polite"
                  className="py-10 text-center text-[10px] uppercase tracking-[0.4em] text-crystal/40"
                >
                  Checking your session…
                </p>
              ) : null}

              {/* ---------------- step 1: details ---------------- */}
              {signedIn && step === "details" ? (
                <form
                  id="reg-step-details"
                  onSubmit={proceedFromDetails}
                  noValidate
                  className="flex flex-col gap-5"
                >
                  <header>
                    <p className="text-[10px] uppercase tracking-[0.4em] text-gold/85">Step 01</p>
                    <h2 className="mt-2 font-display text-[clamp(1.3rem,2.4vw,1.8rem)] tracking-[0.1em] text-crystal">
                      YOUR DETAILS
                    </h2>
                  </header>

                  <div>
                    <label className={labelClass} htmlFor="reg-name">Full name</label>
                    <input id="reg-name" name="name" autoComplete="name" required value={form.name} onChange={set("name")} className={fieldClass} placeholder="e.g. Aarav Sharma" />
                  </div>
                  <div className="grid gap-5 sm:grid-cols-2">
                    <div>
                      <label className={labelClass} htmlFor="reg-roll">Roll number</label>
                      <input id="reg-roll" name="roll_number" required value={form.roll_number} onChange={set("roll_number")} className={fieldClass} placeholder="21B81A0501" />
                    </div>
                    <div>
                      <label className={labelClass} htmlFor="reg-college">College</label>
                      <input id="reg-college" name="college_name" required value={form.college_name} onChange={set("college_name")} className={fieldClass} placeholder="AITS Tirupati" />
                    </div>
                  </div>
                  <div className="grid gap-5 sm:grid-cols-2">
                    <div>
                      <label className={labelClass} htmlFor="reg-year">Year</label>
                      <select id="reg-year" name="year" required value={form.year} onChange={set("year")} className={fieldClass}>
                        <option value="" disabled>Select year</option>
                        {YEARS.map((y) => (
                          <option key={y} value={y}>{y}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className={labelClass} htmlFor="reg-dept">Department</label>
                      <input id="reg-dept" name="department" required value={form.department} onChange={set("department")} className={fieldClass} placeholder="CSE" />
                    </div>
                  </div>
                  <div className="grid gap-5 sm:grid-cols-2">
                    <div>
                      <label className={labelClass} htmlFor="reg-phone">Phone</label>
                      <input id="reg-phone" name="phone_number" type="tel" autoComplete="tel" required value={form.phone_number} onChange={set("phone_number")} className={fieldClass} placeholder="+91 90000 00000" />
                    </div>
                    <div>
                      <label className={labelClass} htmlFor="reg-email">Email</label>
                      <input id="reg-email" name="email" type="email" autoComplete="email" required value={form.email} onChange={set("email")} className={fieldClass} placeholder="you@example.com" />
                    </div>
                  </div>

                  <div className="mt-2 flex flex-wrap items-center justify-between gap-5">
                    <Link
                      to={returnTo}
                      className="text-[10px] uppercase tracking-[0.35em] text-crystal/40 transition-colors hover:text-lavender"
                    >
                      ← Back
                    </Link>
                    <CinematicButton type="submit" id="reg-details-next">
                      {paid ? "Continue to payment" : "Confirm registration"}
                    </CinematicButton>
                  </div>
                </form>
              ) : null}
              {/* ---------------- step 2: payment QR ---------------- */}
              {signedIn && step === "pay" ? (
                <div id="reg-step-pay" className="flex flex-col gap-6 text-center">
                  <header>
                    <p className="text-[10px] uppercase tracking-[0.4em] text-gold/85">Step 02</p>
                    <h2 className="mt-2 font-display text-[clamp(1.3rem,2.4vw,1.8rem)] tracking-[0.1em] text-crystal">
                      PAYMENT QR
                    </h2>
                    <p className="mt-3 text-sm leading-relaxed text-crystal/55">
                      Scan with any UPI app and pay{" "}
                      <span className="text-gold">₹{fee}</span>
                      {contextTitle ? ` for ${contextTitle}` : ""}. Keep the
                      transaction reference — you will paste it next.
                    </p>
                  </header>

                  <div
                    id="reg-qr"
                    className="mx-auto w-fit border border-lavender/25 bg-white p-4"
                  >
                    {PAYMENT_VPA ? (
                      <QRCodeSVG
                        value={upiUrl}
                        size={196}
                        level="M"
                        bgColor="#ffffff"
                        fgColor="#0a0514"
                        aria-label="UPI payment QR code"
                      />
                    ) : (
                      <div
                        id="reg-qr-pending"
                        className="flex h-[196px] w-[196px] flex-col items-center justify-center gap-2 bg-void px-4 text-center"
                      >
                        <span className="text-[10px] uppercase tracking-[0.3em] text-lavender">
                          QR pending setup
                        </span>
                        <span className="text-[10px] leading-relaxed text-crystal/50">
                          Set PAYMENT_VPA in src/config/payment.js to render the
                          live UPI QR.
                        </span>
                      </div>
                    )}
                  </div>

                  <ul className="mx-auto flex max-w-md flex-col gap-1.5 text-[11px] leading-relaxed text-crystal/50">
                    <li>UPI id: <span className="text-crystal/80">{PAYMENT_VPA || "— not configured —"}</span></li>
                    <li>Payee: <span className="text-crystal/80">{PAYEE_NAME}</span></li>
                    <li>Amount: <span className="text-gold">₹{fee}</span> exactly</li>
                  </ul>

                  <div className="flex flex-wrap items-center justify-between gap-5">
                    <button
                      type="button"
                      id="reg-pay-back"
                      onClick={() => setStep("details")}
                      className="text-[10px] uppercase tracking-[0.35em] text-crystal/40 transition-colors hover:text-lavender"
                    >
                      ← Edit details
                    </button>
                    <CinematicButton type="button" id="reg-pay-next" onClick={() => setStep("utr")}>
                      I have paid — continue
                    </CinematicButton>
                  </div>
                </div>
              ) : null}

              {/* ---------------- step 3: UTR reference ---------------- */}
              {signedIn && step === "utr" ? (
                <form id="reg-step-utr" onSubmit={submitUtr} noValidate className="flex flex-col gap-5">
                  <header>
                    <p className="text-[10px] uppercase tracking-[0.4em] text-gold/85">Step 03</p>
                    <h2 className="mt-2 font-display text-[clamp(1.3rem,2.4vw,1.8rem)] tracking-[0.1em] text-crystal">
                      PAYMENT REFERENCE
                    </h2>
                    <p className="mt-3 text-sm leading-relaxed text-crystal/55">
                      Paste the UTR / UPI reference number from your payment
                      app (6–30 letters, digits or dashes). The admin verifies
                      it against the bank statement and confirms your seat.
                    </p>
                  </header>

                  <div>
                    <label className={labelClass} htmlFor="reg-utr">UTR / transaction reference</label>
                    <input
                      id="reg-utr"
                      name="utr_number"
                      required
                      value={utr}
                      onChange={(e) => setUtr(e.target.value)}
                      className={fieldClass}
                      placeholder="e.g. 402345678912"
                      autoComplete="off"
                    />
                    <p className="mt-2 text-[10px] uppercase tracking-[0.2em] text-crystal/35">
                      6–30 characters · A–Z a–z 0–9 -
                    </p>
                  </div>

                  <div className="mt-1 flex flex-wrap items-center justify-between gap-5">
                    <button
                      type="button"
                      id="reg-utr-back"
                      onClick={() => setStep("pay")}
                      className="text-[10px] uppercase tracking-[0.35em] text-crystal/40 transition-colors hover:text-lavender"
                    >
                      ← Back to QR
                    </button>
                    <CinematicButton type="submit" id="reg-utr-submit">
                      Submit registration
                    </CinematicButton>
                  </div>
                </form>
              ) : null}
              {/* ---------------- done ---------------- */}
              {signedIn && step === "done" && done ? (
                <div id="reg-success" className="flex flex-col items-center gap-4 text-center">
                  <span
                    aria-hidden
                    className="flex h-14 w-14 rotate-45 items-center justify-center border border-lavender/60 bg-violet-bright/15 shadow-[0_0_30px_rgba(168,85,247,0.5)]"
                  >
                    <span className="-rotate-45 text-xl text-lavender">✓</span>
                  </span>
                  <h2 className="font-display text-[clamp(1.3rem,2.4vw,1.8rem)] tracking-[0.12em] text-crystal">
                    REGISTRATION RECEIVED
                  </h2>
                  <p className="max-w-md text-sm leading-relaxed text-crystal/60">
                    {done.name} · {done.email} ·{" "}
                    {done.utr_number ? `UTR ${done.utr_number}` : "no payment due"}
                    . Your entry is waiting for admin verification — watch your
                    email for confirmation.
                  </p>
                  <p
                    id="reg-sync"
                    data-synced="true"
                    data-reference={done.id}
                    className="text-[10px] uppercase tracking-[0.3em] text-crystal/40"
                  >
                    Saved to the NEXUS roster · reference {String(done.id).slice(0, 8)}
                  </p>
                  <div className="mt-3 flex flex-wrap items-center justify-center gap-4">
                    <CinematicButton to={returnTo}>Back to the event</CinematicButton>
                    <Link
                      to="/events"
                      className="text-[10px] uppercase tracking-[0.35em] text-crystal/40 transition-colors hover:text-lavender"
                    >
                      Browse more realms
                    </Link>
                  </div>
                </div>
              ) : null}

              {/* ------- this participant's existing registrations ------- */}
              {/* RLS scopes this select to the signed-in user, so it is the
                  participant's own view and nothing else. It is the only place
                  the app can show "your payment is verified" or let a rejected
                  UTR be resubmitted — neither is possible without ownership. */}
              {signedIn && mine.length > 0 ? (
                <div id="reg-mine" className="mt-10 border-t border-white/10 pt-8">
                  <h3 className="text-[10px] font-medium uppercase tracking-[0.4em] text-lavender/70">
                    Your registrations
                  </h3>
                  <ul className="mt-4 flex flex-col gap-3">
                    {mine.map((r) => (
                      <li
                        key={r.id}
                        className="flex flex-col gap-1.5 border border-white/10 bg-white/[0.02] px-4 py-3"
                      >
                        <div className="flex flex-wrap items-baseline justify-between gap-3">
                          <span className="text-sm tracking-wide text-crystal/85">
                            {r.purchase_label ?? "NEXUS registration"}
                          </span>
                          <span
                            className={`text-[9px] font-medium uppercase tracking-[0.22em] ${
                              r.payment_status === "verified"
                                ? "text-gold"
                                : r.payment_status === "rejected"
                                  ? "text-rose-300/85"
                                  : "text-crystal/50"
                            }`}
                          >
                            {r.payment_status === "verified"
                              ? "Payment verified"
                              : r.payment_status === "rejected"
                                ? "Reference rejected"
                                : "Awaiting verification"}
                          </span>
                        </div>
                        <p className="text-[10px] tracking-[0.14em] text-crystal/40">
                          {r.college_name} · {r.roll_number}
                          {r.utr_number ? ` · UTR ${r.utr_number}` : ""}
                        </p>
                        {r.payment_status === "rejected" ? (
                          <RejectedUtrForm
                            rowId={r.id}
                            onSubmit={(v) => resubmitUtr(r.id, v)}
                          />
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          </Reveal>
        </section>

      </div>
    </Page>
  );
}

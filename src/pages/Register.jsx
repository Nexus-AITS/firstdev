import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { QRCodeSVG } from "qrcode.react";
import Page from "../components/ui/Page.jsx";
import Reveal from "../components/ui/Reveal.jsx";
import CinematicButton from "../components/ui/CinematicButton.jsx";
import Select from "../components/ui/Select.jsx";
import ParticleField from "../components/fx/ParticleField.jsx";
import GoogleSignIn from "../components/auth/GoogleSignIn.jsx";
import { useAuth } from "../context/AuthContext";
import { getEventFee, getEventFields, getEntryType, getPaymentMode, getEventView, requiresTeamRoster, maxTeammatesFor, isRegistrationClosed, formatRegistrationCloses } from "../data/events.js";
import { getBundleById, getBundlePrice } from "../data/bundles.js";
import { loadCatalogue, getCatalogueVersion, catalogueLoaded } from "../data/catalogue.js";
import useEventView from "../hooks/useEventView.js";
import usePricing from "../hooks/usePricing.js";
import { getPricingVersion, pricingLoaded } from "../data/pricing.js";
import {
  addRegistration,
  listRegistrations,
  listRegistrationEvents,
  loadTeam,
  setRegistrationTeam,
  submitUtr,
  validateEventFields,
  validateRegistration,
  validateTeam,
} from "../data/registrations.js";
import { loadMyProfile } from "../data/profiles.js";
import { PAYMENT_VPA, PAYEE_NAME, buildUpiUrl } from "../config/payment.js";
import EventSelection from "../components/register/EventSelection.jsx";
import TeamRoster from "../components/register/TeamRoster.jsx";
import { loadLookups, setRegistrationEvents } from "../data/staff.js";

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

/* Bounded wait for a save.
   A `fetch` that never resolves - a dropped connection, a proxy that holds the
   socket - leaves an `await` pending forever. Without this, the participant sits
   on the team step with a disabled button and no message at all, which reads as
   a broken page rather than a network problem, and reloading is the only way out.

   It also cannot say "it failed": the write may well have landed on the server.
   So the message tells the participant to go BACK and try again rather than
   promising their team was not saved - and the resume path below re-reads the
   row, so a team that did save is still there. */
const SAVE_TIMEOUT_MS = 20000;
function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export default function Register() {
  const [searchParams] = useSearchParams();
  // The live view, so a price, cap or payment mode edited in the console is what
  // the person registering is actually shown and charged.
  const event = useEventView(searchParams.get("event"));
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
  // The two store versions, read here so the resume effect below can list them
  // as dependencies. See the comment on that effect: without them it reuses a
  // closure built before the catalogue answered, and reads a paid registration
  // as a free one.
  const catalogueVersion = getCatalogueVersion();
  const pricingVersion = getPricingVersion();
  const fee = event ? getEventFee(event.id) : bundle ? getBundlePrice(bundle.id) : null;
  // payment: 0 is an explicit FREE entry (events.js requires the field), so only
  // a positive amount may route through the QR + UTR steps. getEventFee and
  // getBundlePrice both return a number (or null), so this is a plain compare.
  const paid = fee != null && Number(fee) > 0;
  const contextTitle = event ? event.title : bundle ? bundle.name : null;
  /* Has this event's registration closed? (migration ...034)
     A single-event purchase is the case that can be answered from the catalogue
     alone - the deadline is per event. A BUNDLE is not: it may seat several
     events, each with its own last day, and the pool is chosen further down the
     wizard, so the bundle deliberately reports closed=false here and lets the
     database refuse a specific event at selection time. Guessing would be worse
     than saying nothing.

     This is a COURTESY, never the authority. The trigger
     trg_event_registration_cap re-checks on the insert whatever this page
     concluded, so a stale "open" here costs a participant one round trip and a
     stale "closed" is impossible - the database is what actually decides. */
  const closedEvent = event ? isRegistrationClosed(event.id) : false;
  const closesOn = event ? formatRegistrationCloses(event.id) : null;
  const returnTo = event ? `/events/${event.id}` : bundle ? "/bundled" : "/events";
  // What the participant is buying — recorded on the row (purchase_type +
  // purchase_label) so the admin panel can show which event / which bundle.
  // The label is persisted on the registration row, so it must carry the LIVE
  // price. Using `bundle.price` here would freeze whatever the JS constant said
  // at registration time into the roster, even after a master changed it.
  const purchase = event
    ? { type: "event", label: event.title, ref: event.id }
    : bundle
      ? { type: "bundle", label: `${bundle.name} #${bundle.number} · ₹${getBundlePrice(bundle.id)}`, ref: bundle.id }
      : null;

  // A bundle with pick-pools needs the participant's choice BEFORE the payment
  // QR, because the QR encodes the amount. The amount is the database's number
  // either way (a bundle price is the total regardless of the choice), but the
  // selection still has to be recorded against the registration row, and the row
  // does not exist until `finalize` writes it. So the order is:
  //   details -> select (only when a bundle has pools) -> pay -> utr
  // A plain single-event registration has nothing to choose and skips it.
  const needsSelection = Boolean(bundle?.includes?.some((line) => line.pick));

  /* Does this purchase collect a TEAM ROSTER?
     A per_team event is one leader paying for a squad, and a squad the database
     cannot name is a squad the operations team cannot call at the venue. So the
     leader lists their teammates, up to the event's own cap.

     Read from the catalogue rather than from `entryType === "team"` on purpose:
     the hackathon is a team event whose team is formed on another site, and
     asking its leader for teammate details here would collect data nobody on
     this project will ever use. requiresTeamRoster() is the single definition,
     so the wizard, the card and the console cannot disagree about which events
     collect one. */
  const teamCap = event ? Number(event.maxTeamMembers ?? 0) : 0;
  const needsTeam = requiresTeamRoster(event);

  /* Cash or UTR, and therefore whether a reference is asked for at all.
     A cash registration is finished at the confirmation step: there is no QR to
     scan and nothing to paste, because the money moves at the desk. The same
     Confirm/Reject pipeline still applies, so the operations team marks it
     verified when they take the cash - there is no second verification system
     to maintain. The amount is identical either way.

     Chosen on the DETAILS step rather than on a step of its own, so the step
     count cannot change after the participant has already seen the progress
     track. `paid` gates it: a free entry has no method to choose. */
  const [payMethod, setPayMethod] = useState("utr");
  const needsUtr = paid && payMethod === "utr";
  const isCash = paid && payMethod === "cash";
  // The event-specific inputs this purchase has to collect (FREE FIRE's in-game
  // ID today). Read from the catalogue, so the form follows the data and a new
  // event field needs no change here.
  const declaredFields = getEventFields(purchase?.ref);
  const [extra, setExtra] = useState({});
  const setExtraField = (name) => (e) => setExtra((current) => ({ ...current, [name]: e.target.value }));
  const [step, setStep] = useState("details"); // details | select | pay | utr | done
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
  // The amount the DATABASE charged for the selection. Rendered in place of the
  // locally-read fee once a selection has been saved, because that is the figure
  // the payment is reconciled against. Null until then.
  const [confirmedAmount, setConfirmedAmount] = useState(null);

  /* The team the leader is bringing. `members` holds one object per teammate and
     is the source of truth for the form; the database only ever sees the whole
     array at once, in one save. There is deliberately no "has the roster been
     saved" flag: resume asks `loadTeam` instead, which is the database's own
     answer, and a flag that could disagree with the row is the thing this
     codebase keeps having to undo. */
  const [teamName, setTeamName] = useState("");
  const [members, setMembers] = useState([]);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  /* ---------------- resume + prefill ---------------- */

  // The profile page links back here as /register?event=…&resume=<row id>. The
  // row — not the URL — is what says how far the participant got.
  const resumeId = searchParams.get("resume");
  // Guards the adoption against running twice (the load effect can re-fire when
  // `mine` changes underneath it). A ref, not a plain object: a fresh object
  // every render would forget the guard immediately.
  const resumedRef = useRef(null);

  /* Colleges and departments, for the form dropdowns.
   *
   * Fetched once on mount and NOT awaited by anything that renders: the form
   * renders for a signed-out visitor, so waiting on this would put a placeholder
   * where the details form used to be. The typed field below each dropdown is
   * what a participant uses in the meantime, and it is also how they report a
   * college the list has not heard of. An empty list is a degraded state, not a
   * broken page, and is worded that way where it renders. */
  const [lookups, setLookups] = useState({ colleges: [], departments: [] });
  useEffect(() => {
    let alive = true;
    loadLookups().then((result) => {
      if (alive && result.ok) {
        setLookups({ colleges: result.colleges, departments: result.departments });
      }
    });
    return () => {
      alive = false;
    };
  }, []);

  /**
   * The participant's own row for this email AND this purchase, or null.
   *
   * `mine` is already RLS-scoped to the signed-in user, so this can only ever
   * match a row the caller owns. That is what makes adopting it safe: it is not
   * "does this email exist in the database", it is "is this one of mine".
   *
   * The purchase is part of the key, and it has to be. This matched on email
   * ALONE, so once a person could hold more than one row - migration ...023
   * allows a bundle AND a separate event - it returned whichever row came first
   * regardless of what was being bought, and `finalize` then attached the new
   * reference to it. Buying a bundle and then an event produced ONE row: the
   * bundle, carrying the event's UTR. The second purchase was not refused, it was
   * absorbed, which is worse.
   *
   * A NULL purchase means there is nothing to be specific about - someone joining
   * the roster from the plain /register form - so it falls back to any row for
   * that address, which is the pre-...023 behaviour and the right one there.
   */
  function findMine(email, purchaseRef = null) {
    const key = String(email ?? "").trim().toLowerCase();
    if (!key) return null;
    const owned = mine.filter(
      (r) => String(r.email ?? "").trim().toLowerCase() === key
    );
    if (!purchaseRef) return owned[0] ?? null;
    return owned.find((r) => (r.purchase_ref ?? null) === purchaseRef) ?? null;
  }

  /**
   * Continue an existing registration instead of starting a second one.
   *
   * This is the fix for the dead end: a participant who refreshed (or whose
   * earlier attempt had already written the row) used to be sent back to step
   * 01 with an empty form, and once they re-submitted they hit
   * uq_registrations_email — "This email is already registered" — on every
   * attempt after. The row existed, the payment had been made, and there was no
   * path to the confirmation screen at all.
   *
   * Where they resume is read from the ROW:
   *   reference already submitted  → the confirmation
   *   bundle with a choice already → the QR (the selection is recorded)
   *   bundle without a choice      → the selection step
   *   otherwise                    → the QR
   */
  async function adopt(row) {
    if (!row) return;
    setForm({
      name: row.name ?? "",
      roll_number: row.roll_number ?? "",
      college_name: row.college_name ?? "",
      year: row.year ?? "",
      department: row.department ?? "",
      phone_number: row.phone_number ?? "",
      email: row.email ?? "",
    });
    // Whatever the row already holds for the event's own fields, so a resumed
    // FREE FIRE registration shows the ID they gave rather than an empty input
    // that looks like they still owe one.
    const carried = {};
    for (const field of declaredFields) {
      if (row[field.name] != null) carried[field.name] = row[field.name];
    }
    setExtra(carried);
    setDone(row);
    setConfirmedAmount(null);

    /* The ids in the URL, read ONCE at the top of the decision rather than
       half way down it. They are the only values that cannot be stale on a cold
       reload, because they came from the address bar and nothing has had a chance
       to change them. */
    const bundleId = searchParams.get("bundle");
    const eventId = searchParams.get("event");

    /* The method the ROW records, not the one the form happens to be showing.
       A cash registration resumed into a form defaulting to "utr" would show a
       reference field for a payment that is never made by reference, and a
       participant who pasted something into it would be told the row was
       already registered. The row is the record; the form follows it. */
    const rowIsCash = row.payment_method === "cash";
    if (rowIsCash) setPayMethod("cash");

    /* The roster, when this purchase has one. Carried into the form rather than
       assumed, so a leader who refreshes at the payment step sees their team
       still listed instead of an empty form that looks like they never entered
       it. `registration_team` is the database's own shape, and the leader is
       NOT a member row anywhere - they are this registration - so nothing is
       prepended here. getEventView merges the live catalogue over the compiled
       event, which is what carries the cap. */
    if (eventId && requiresTeamRoster(getEventView(eventId))) {
      const { data: team } = await loadTeam(row.id);
      if (team) {
        setTeamName(team.team_name ?? "");
        setMembers(
          (team.members ?? []).map((m) => ({
            name: m.name ?? "",
            email: m.email ?? "",
            roll_number: m.roll_number ?? "",
            college_name: m.college ?? "",
            year: m.year ?? "",
            department: m.department ?? "",
            phone_number: m.phone_number ?? "",
          }))
        );
      }
    }

    /* Which step this row is waiting on, read from the STORES at the moment of
     * the decision rather than from `paid` and `needsSelection` out of this
     * function's closure.
     *
     * That closure is the bug. `paid` is derived from a price that arrives over
     * the network, and on a cold reload of a ?resume= URL this ran before it had:
     * getBundleById found no bundle, `fee` was null, `paid` was false, and a
     * participant who had already paid was dropped straight onto the
     * CONFIRM screen for a registration whose UTR was never submitted. The row
     * says plainly what is outstanding - a purchase_amount and no utr_number -
     * and the page contradicted it.
     *
     * A previous attempt fixed this by re-running the effect once the stores
     * had loaded. That is not enough on its own, because the re-run is only a
     * re-run if something re-renders this component, and a `?resume=` landing
     * can reach the decision without one. So the values are fetched HERE, from
     * the ids in the URL, which never change and so are always current.
     */
    const liveBundle = bundleId ? getBundleById(bundleId) : null;
    const paidNow = liveBundle
      ? Number(getBundlePrice(bundleId) ?? 0) > 0
      : eventId
        ? Number(getEventFee(eventId) ?? 0) > 0
        : false;
    const needsNow = Boolean(liveBundle?.includes?.some((line) => line.pick));
    /* A cash row has no reference to submit and never will, so "utr_number is
       null" must NOT send a cash registration back to the reference step - that
       is the bug this branch exists to prevent. It is finished at the desk. */
    const owesReference = paidNow && !rowIsCash;

    /* Three ways to be finished: a reference is already on the row, the entry
       was free, or the money is being paid in cash. All three land on CONFIRM.
       The cash case is the new one, and testing `utr_number` alone would send a
       cash registration back to a reference field it can never fill in. */
    if (row.utr_number || !owesReference) {
      setStep("done");
      return;
    }
    if (needsNow) {
      const { data: chosen } = await listRegistrationEvents(row.id);
      setStep((chosen ?? []).length > 0 ? "utr" : "select");
      return;
    }
    setStep("utr");
  }

  /* The stepper is built from the same list the progress bar renders, and the
     index is looked up in THAT list rather than from a fixed map. The map would
     have to know that a bundle-with-pools inserts an extra step, and it would
     drift the moment another conditional step is added — the progress bar would
     highlight the wrong entry while the wizard itself advanced correctly.

     Every flow ends on CONFIRM — paid or free.
   *
   * It used to exist only on the free path, which put the paid wizard in a
   * state it had no entry for: `findIndex("done")` returned -1, Math.max
   * clamped it to 0, and the progress track rewound to "01 YOUR DETAILS" on
   * the confirmation screen. So at the exact moment the participant submitted
   * their registration, the tracker said they were back at step one — which
   * reads as "my submission did nothing". The stepper and the wizard have to
   * agree about what the last step IS. */
  // The QR and the reference are ONE step. They were two, and a paid bundle
  // read as five: details, choose events, QR, reference, confirm. The QR is not
  // a decision - it is the instruction for the thing on the same screen. A
  // participant scanning it has not finished anything yet, and making them
  // click "I have paid" before they had even been asked for the reference had
  // them promise payment before they could read the amount. So the QR now sits
  // above the UTR field on the PAYMENT REFERENCE step, and a bundle reads as
  // four: details, choose events, payment reference, confirm.
  const stepList = [
    { id: "details", label: "YOUR DETAILS" },
    ...(needsSelection ? [{ id: "select", label: "CHOOSE EVENTS" }] : []),
    /* The roster comes AFTER the selection and BEFORE payment. After, because
       the team belongs to the events the participant just chose - a bundle that
       seats two team events is two squads, and the cap is the tightest of them.
       Before, because the operations team needs the roster to exist before the
       money arrives, and a leader who reaches the QR and only then learns they
       must list teammates has already committed to paying. */
    ...(needsTeam ? [{ id: "team", label: "YOUR TEAM" }] : []),
    /* Only a UTR payment asks for a reference. A cash registration goes straight
       from here to CONFIRM, so it reads as a shorter flow rather than as a
       payment screen with the reference field mysteriously missing. */
    ...(needsUtr ? [{ id: "utr", label: "PAYMENT REFERENCE" }] : []),
    { id: "done", label: "CONFIRM" },
  ];
  const stepIndex = Math.max(0, stepList.findIndex((s) => s.id === step));

  /* The screen's own number, derived from where it sits in stepList rather than
     typed into the markup. It used to be written in as "Step 01"/"Step 02"/
     "Step 03", which is correct for only one shape of flow: a bundle with a
     selection step and one without cannot both be right, and a flow that gained
     or lost a step silently kept the old numbers. */
  const stepNumber = `Step ${String(stepIndex + 1).padStart(2, "0")}`;

  /* Back goes to whatever the list says came before, so removing or adding a
     conditional step cannot leave a "back" that lands somewhere impossible. */
  function stepBack() {
    const prev = stepList[stepIndex - 1];
    if (prev) setStep(prev.id);
  }

  // While the session is still resolving the page must not claim to be either
  // signed in or signed out — the register/verify suite and a returning
  // participant both need a stable state to assert against.
  const authReady = status !== "loading" && !configPending;
  const gated = authReady && !signedIn;

  /**
   * Prefill the details form from the profile.
   *
   * Only when the form is untouched: a prefill that overwrites what somebody is
   * halfway through typing is worse than no prefill at all. This is the payoff
   * of the profile page — details entered once, never retyped for the next
   * event.
   *
   * Declared here, BELOW `authReady`, on purpose. A dependency array is
   * evaluated during render, so listing `authReady` above its own declaration is
   * a temporal-dead-zone ReferenceError that blanks the whole route — and no
   * build or type check catches it. It was written that way first.
   */
  useEffect(() => {
    if (!authReady || !signedIn) return;
    let alive = true;
    loadMyProfile().then(({ data }) => {
      if (!alive || !data) return;
      setForm((current) => {
        const untouched = Object.keys(emptyForm).every(
          (key) => String(current[key] ?? "").trim() === ""
        );
        if (!untouched) return current;
        return {
          name: data.full_name ?? "",
          roll_number: data.roll_number ?? "",
          college_name: data.college_name ?? "",
          year: data.year ?? "",
          department: data.department ?? "",
          phone_number: data.phone_number ?? "",
          email: data.email ?? "",
        };
      });
    });
    return () => {
      alive = false;
    };
  }, [authReady, signedIn, catalogueVersion, pricingVersion]);

  function proceedFromDetails(e) {
    e.preventDefault();
    const message = validateRegistration({ ...form, utr_number: null });
    if (message) {
      setError(message);
      return;
    }
    // A Free Fire ID is not a nicety: it is what the player is checked against
    // at the match. Same rule as the database trigger, checked here so the
    // message arrives in the participant's language instead of as a 400.
    const fieldMessage = validateEventFields(purchase?.ref, extra);
    if (fieldMessage) {
      setError(fieldMessage);
      return;
    }
    setError("");
    /* The order out of here follows stepList exactly, so the screen the
       participant is sent to is always the one the progress track is about to
       highlight. Routing by hand against a list that can change shape is how a
       flow ends up pointing at a step that is not in it - which renders no
       screen at all, with no error. */
    const after = stepList[stepIndex + 1];
    if (after && after.id !== "done") setStep(after.id);
    else if (needsUtr) setStep("utr");
    else finalize(null);
  }

  /**
   * Record the participant's event choice.
   *
   * The registration row is written FIRST (so there is an id to attach the
   * selection to) and the selection second. If the selection is refused the row
   * survives without one, which is the recoverable state: the participant can
   * retry the choice, and the operations team can still see the registration.
   * The reverse order is not possible — the selection is keyed on the row.
   *
   * The amount comes back from the database and is what the QR is then built
   * from, so the number on the QR and the number in the roster cannot drift.
   */
  async function saveSelection(chosenIds) {
    setSaving(true);
    setError("");

    // The row may already exist — a refresh between the selection and the QR is
    // all it takes — and inserting again would collide with
    // uq_registrations_email, stranding the participant on this step with an
    // error they cannot resolve. `mine` only contains rows RLS lets them see,
    // so "is one of mine with this email" is the safe test.
    // Matched on the purchase as well as the email, so a participant who already
    // has a bundle row and is now buying a single event gets a NEW row rather
    // than having the bundle's row adopted and overwritten.
    let row = findMine(form.email, purchase?.ref ?? null);
    let created = false;

    if (!row) {
      const { data: newRow, error: createError } = await addRegistration({
        ...form,
        utr_number: null,
        purchase_type: purchase?.type ?? null,
        purchase_label: purchase?.label ?? null,
        purchase_ref: purchase?.ref ?? null,
        eventFields: extra,
      });
      if (createError) {
        setSaving(false);
        setError(createError);
        return;
      }
      row = newRow;
      created = true;
      setMine((current) => [row, ...current]);
    }

    const result = await setRegistrationEvents({
      registrationId: row.id,
      bundleId: bundle?.id ?? null,
      eventIds: chosenIds,
    });
    setSaving(false);

    /* The event they just took a seat in is now one more than it was a moment
       ago, and every card on the site shows that number. Re-read the catalogue
       so a participant who goes back to the events list sees their own
       registration counted, rather than a number frozen at page load.
       Deliberately not awaited: the QR step must not wait on a refresh, and the
       store notifies its subscribers when the response lands. */
    if (result.ok) loadCatalogue({ force: true });

    if (!result.ok) {
      setError(result.error);
      return;
    }
    setConfirmedAmount(result.amount);
    setDone(row);
    // The refreshed row keeps `mine` honest when we adopted an older one —
    // `created` is what stops us prepending the same registration twice.
    if (!created) setMine((current) => current.map((r) => (r.id === row.id ? row : r)));
    setStep(nextAfterSelect());
  }

  /* Where a bundle's selection sends the participant next.
     Split out so the selection step and the team step below agree about it
     without each re-deriving the rule. After choosing events, the next thing is
     the roster if this purchase collects one, otherwise the reference - and
     neither if the entry is free. */
  function nextAfterSelect() {
    if (needsTeam) return "team";
    if (needsUtr) return "utr";
    return "done";
  }

  /**
   * Ensure a registration row exists, so a team can be attached to it.
   *
   * The same helper in spirit as the selection step's "write the row FIRST"
   * logic, and for the same reason: registration_members hangs off the row by
   * foreign key, so a single-event team registration that skipped this would
   * have nothing to attach the roster to. A refresh between the details step and
   * here is all it takes, so the lookup happens before every attempt rather than
   * once on mount.
   */
  async function ensureRow() {
    let row = findMine(form.email, purchase?.ref ?? null);
    if (row) return { row, created: false };

    const { data: newRow, error: createError } = await addRegistration({
      ...form,
      utr_number: null,
      payment_method: payMethod,
      purchase_type: purchase?.type ?? null,
      purchase_label: purchase?.label ?? null,
      purchase_ref: purchase?.ref ?? null,
      team_name: teamName.trim() || null,
      eventFields: extra,
    });
    if (createError) return { row: null, created: false, error: createError };
    setMine((current) => [newRow, ...current]);
    return { row: newRow, created: true };
  }

  /**
   * Save the leader's team, then move on.
   *
   * Validated here for the message and by the database for the truth, exactly
   * as the event selection is. The important detail is what is NOT sent: no
   * count, no cap, no team size. Those are read server-side from the event the
   * participant bought, so a form that lied about how many people are allowed
   * could not get a larger team written.
   */
  async function saveTeam(e) {
    if (e) e.preventDefault();
    if (saving) return;

    const problem = validateTeam(teamName, members);
    if (problem) {
      setError(problem);
      return;
    }
    /* The cap is checked here too, so the leader is told before a round trip -
     * but it is NOT trusted: the trigger on registration_members refuses an
     * over-cap roster whatever this form believes. */
    const allowed = maxTeammatesFor(event);
    if (allowed != null && members.length > allowed) {
      setError(
        `This event allows ${teamCap} people including you, so you can add ${allowed}.`
      );
      return;
    }

    setSaving(true);
    setError("");

    let row;
    let rowError = null;
    try {
      ({ row, error: rowError } = await withTimeout(
        ensureRow(),
        SAVE_TIMEOUT_MS,
        "That took too long. Go back and try again — if your team was saved it will still be here."
      ));
    } catch (err) {
      setSaving(false);
      setError(err?.message ?? "That team could not be saved. Please try again.");
      return;
    }
    if (!row) {
      setSaving(false);
      // The database's own sentence — "a Free Fire ID is required", a unique
      // collision — is more useful than anything invented here.
      setError(rowError ?? "That team could not be saved. Please try again.");
      return;
    }

    let result;
    try {
      result = await withTimeout(
        setRegistrationTeam({ registrationId: row.id, teamName, members }),
        SAVE_TIMEOUT_MS,
        "That took too long. Go back and try again — if your team was saved it will still be here."
      );
    } catch (err) {
      setSaving(false);
      setError(err?.message ?? "That team could not be saved. Please try again.");
      return;
    }
    setSaving(false);

    /* The RETURN SHAPE, which was the actual bug here and not anything to do with
       the network, the guard, or the form.

       setRegistrationTeam resolves `{ data, error }` — the convention every
       function in registrations.js uses. This branch was testing `result.ok`,
       which is the convention staff.js uses. `ok` is therefore ALWAYS undefined
       here, so `!result.ok` was true on every single call: the team saved, the
       roster was written, the row was created, and the wizard then reported a
       failure and stayed put.

       So the test is on `error`, which is what this function actually sets. */
    if (result?.error) {
      setError(String(result.error));
      return;
    }

    setDone(row);
    /* The next step is read from stepList - the SAME list the progress track is
       rendered from - rather than recomputed here. Recomputing it is how a flow
       ends up pointing at a step that is not in its own stepper, which renders
       no screen at all and reports no error. stepList cannot disagree with
       itself. */
    const next = stepList[stepIndex + 1]?.id ?? "done";
    setStep(next);

    /* A cash or free entry has nothing left after the roster, so the row is
       written here rather than leaving the participant on a step that would
       render nothing. A UTR entry still owes a reference, so it waits — and the
       row just written is passed along, because finalize would otherwise look
       for it in `mine` and not find the one this very function created. */
    if (!needsUtr) finalize(null, row);
  }

  /**
   * Write the registration, or attach the UTR to the one that already exists.
   *
   * There is no local fallback: if the write fails the participant is told and
   * stays on the step, because a success screen for a row the server never
   * accepted is the single worst outcome this flow can produce.
   *
   * The two-entry shape is not redundancy. A bundle-with-pools flow creates the
   * row at the selection step, because the selection is keyed on the row and
   * cannot be written first. By the time the UTR is submitted that row already
   * exists, so this must SUBMIT THE REFERENCE to it. Inserting again would
   * collide with uq_registrations_email — the participant would pay, paste a
   * valid UTR, and be told they had "already registered".
   *
   * The same trap used to be reachable WITHOUT a bundle: refresh at the UTR
   * step, retype the details, and `done` was gone while the row was not. So the
   * existence check happens BEFORE every insert, not only on the selection
   * path.
   */
  async function finalize(utrValue, knownRow) {
    if (saving) return;
    setSaving(true);
    setError("");

    // A selection already wrote the row; only the reference is outstanding.
    if (done?.id && utrValue != null) {
      const { data, error: saveError } = await submitUtr(done.id, utrValue);
      setSaving(false);
      if (saveError) {
        setError(saveError);
        return;
      }
      setDone(data);
      setMine((current) => current.map((r) => (r.id === data.id ? data : r)));
      setStep("done");
      return;
    }

    /* Already registered under this email and it is MINE (RLS says so): continue
     * that registration rather than failing to create a duplicate.
     * The purchase is part of the match. Matching on email alone meant a second,
     * DIFFERENT purchase was adopted onto the first row and its reference written
     * there - so a bundle followed by an event left one row, showing the bundle,
     * carrying the event's UTR. A person may now hold several rows, and each
     * purchase gets its own.
     *
     * `knownRow` is the one just created by a step above - the team step, which
     * has to write the registration before it can attach a roster to it. Passing
     * it in is what stops the insert being attempted a second time: the row was
     * added with setMine a moment earlier, and React state is not readable from
     * inside the same tick, so findMine would NOT see it and would collide on
     * uq_registrations_purchase - telling a leader who had just typed their
     * whole team that they were "already registered". */
    const existing = knownRow ?? findMine(form.email, purchase?.ref ?? null);
    if (existing) {
      setDone(existing);
      // Verified seats are settled: nothing to submit, nothing to ask the
      // participant for. Saying "already registered" in red would be wrong —
      // the registration is exactly what they came back for.
      if (existing.payment_status === "verified" || utrValue == null) {
        setSaving(false);
        setStep("done");
        return;
      }
      const { data, error: saveError } = await submitUtr(existing.id, utrValue);
      setSaving(false);
      if (saveError) {
        setError(saveError);
        return;
      }
      setDone(data);
      setMine((current) => current.map((r) => (r.id === data.id ? data : r)));
      setStep("done");
      return;
    }

    const { data, error: saveError } = await addRegistration({
      ...form,
      utr_number: utrValue,
      // A cash registration never carries a reference, whatever was typed into
      // the field. addRegistration enforces that pairing, so the two cannot be
      // sent together and rejected - the participant is never shown an error
      // for a combination they could not have chosen deliberately.
      payment_method: isCash ? "cash" : "utr",
      purchase_type: purchase?.type ?? null,
      purchase_label: purchase?.label ?? null,
      purchase_ref: purchase?.ref ?? null,
      team_name: teamName.trim() || null,
      eventFields: extra,
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

  /**
   * The UTR form's submit handler.
   *
   * Named `handleUtrSubmit` rather than `submitUtr` on purpose. `submitUtr` is
   * IMPORTED from the data layer, and a local function declaration of the same
   * name shadows that import for this entire component — so `finalize` and
   * `resubmitUtr`, which both call the data function, would silently call THIS
   * one instead. It takes an event, so passing it a row id made it throw on
   * `e.preventDefault()`: the button did nothing, no error was shown, and the
   * UTR was never written. Shadowing by name is easy to miss in review because
   * both call sites read as correct.
   */
  function handleUtrSubmit(e) {
    e.preventDefault();
    setError("");
    // Enforced here rather than by the input's `required` attribute: the form
    // carries `noValidate`, so native constraint validation never runs and a
    // `required` field can be submitted empty. The details step validates the
    // same way, through validateRegistration, so this keeps one approach rather
    // than two that disagree.
    const value = utr.trim();
    if (!value) {
      setError("Enter the UTR / UPI reference from your payment app before submitting.");
      return;
    }
    if (!/^[A-Za-z0-9-]{6,30}$/.test(value)) {
      setError("The UTR must be 6–30 letters, digits or dashes.");
      return;
    }
    finalize(value);
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
    listRegistrations().then(async ({ data, error: loadError }) => {
      if (!alive || loadError) return;
      const rows = data ?? [];
      setMine(rows);

      // ?resume=<id> — the profile page's "continue". Adopted from the ROW so
      // the step it lands on is the step they actually stopped at, and only
      // once (this effect re-runs if `mine` changes underneath it).
      if (!resumeId || resumedRef.current === resumeId) return;
      const target = rows.find((r) => r.id === resumeId);
      if (!target) return;
      // `adopt` reads the catalogue and the price table itself at the moment it
      // decides, so it does not matter here whether either has answered yet.
      // See the note on adopt() for why that used to send a paid registration
      // straight to the confirmation screen.
      resumedRef.current = resumeId;
      await adopt(target);
    });
    return () => {
      alive = false;
    };
    // authReady is derived from the same two values and gates the early return;
    // listing it keeps the intent explicit without adding a second effect.
  }, [signedIn, authReady, resumeId]);

  // The QR must encode the amount the DATABASE charged. Once a selection has
  // been saved that figure exists; before it, fall back to the price the
  // pricing store reports (which is also server-sourced, just read earlier).
  const payable = confirmedAmount ?? fee;
  const upiUrl = paid
    ? buildUpiUrl({ amount: payable, note: contextTitle || "NEXUS registration" })
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
              {/* Driven by entryType and paymentMode, not by the free-text
                  teamSize. The two modes make DIFFERENT promises about money and
                  this is the line a participant reads before paying:
                    per_team   — one leader pays for the whole squad;
                    per_person — everyone pays their own fee and any team is
                                 formed afterwards, off this site.
                  A participant who is told only "team event, up to 5" cannot tell
                  whether they owe 300 or 1500. */}
              {getEntryType(event) === "team"
                ? getPaymentMode(event) === "per_team"
                  ? ` Squad event — you register and pay once for the whole squad of up to ${event.maxTeamMembers} people. On the next screen, add your teammates' details; they do not register separately.`
                  : ` Team event — up to ${event.maxTeamMembers} per team, and each member registers and pays separately. You will be able to form your team once your payment is approved.`
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
              {stepList.map((s, i) => (
                <li
                  key={s.id}
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
                  {String(i + 1).padStart(2, "0")} {s.label}
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

              {/* ------------- registration closed (the last day has passed) ------------- */}
              {/* INSTEAD of the wizard, on the same reasoning as the sign-in gate
                  above: a form that cannot be completed teaches nothing about
                  why. This names the date, and points at the event page and the
                  contact channels, because "closed" with no next step is the one
                  answer that strands a participant who arrived on the wrong day. */}
              {signedIn && closedEvent ? (
                <div id="reg-closed" className="flex flex-col items-center gap-6 py-6 text-center">
                  <header>
                    <p className="text-[10px] uppercase tracking-[0.4em] text-gold/85">
                      {contextTitle}
                    </p>
                    <h2 className="mt-2 font-display text-[clamp(1.3rem,2.4vw,1.8rem)] tracking-[0.1em] text-crystal">
                      REGISTRATION IS CLOSED
                    </h2>
                  </header>
                  <p className="max-w-md text-sm leading-relaxed text-crystal/60">
                    {closesOn
                      ? `Sign-ups for this event closed on ${closesOn}.`
                      : "Sign-ups for this event are closed."}{" "}
                    The event itself may still be running — this only means new
                    registrations are no longer being taken.
                  </p>
                  <div className="flex flex-wrap items-center justify-center gap-6">
                    <Link
                      to={returnTo}
                      className="border border-lavender/50 px-6 py-3 text-[10px] uppercase tracking-[0.28em] text-crystal/80 transition-colors duration-300 hover:border-lavender hover:text-crystal"
                    >
                      Back to the event
                    </Link>
                    <Link
                      to="/contact"
                      className="text-[10px] uppercase tracking-[0.35em] text-crystal/40 transition-colors hover:text-lavender"
                    >
                      Contact the coordinators →
                    </Link>
                  </div>
                </div>
              ) : null}

              {/* ---------------- step 1: details ---------------- */}
              {/* ONLY this step is gated on the deadline, and deliberately. It is
                  the step that creates a NEW registration, which is what the
                  deadline governs. The later steps - select, team, utr - belong to
                  somebody who ALREADY holds a row, and their seat was taken while
                  registration was still open. Gating those too would strand
                  somebody who registered on the 4th and paid on the 6th, which is
                  the exact failure this feature must not cause. */}
              {signedIn && !closedEvent && step === "details" ? (
                <form
                  id="reg-step-details"
                  onSubmit={proceedFromDetails}
                  noValidate
                  className="flex flex-col gap-5"
                >
                  <header>
                    <p className="text-[10px] uppercase tracking-[0.4em] text-gold/85">{stepNumber}</p>
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
                      {/* From the database, not a text box. "AITS Tirupati",
                          "AITS Tirupati " and "aits tirupati" were three
                          spellings of one college and a pivot by college_name
                          split them three ways. A dropdown cannot produce a
                          fourth spelling, and the operations team adds to the
                          list from the console - so a new college does not need
                          a developer and a deploy.
                          The textbox below it is NOT a fallback: a participant
                          with a college the list has not heard of must be able
                          to say so rather than be forced into a wrong one. */}
                      {lookups.colleges.length ? (
                        <Select
                          id="reg-college"
                          name="college_name"
                          tone="site"
                          required
                          value={form.college_name}
                          onChange={(value) => setForm((f) => ({ ...f, college_name: value }))}
                          options={lookups.colleges.map((c) => ({ value: c.name, label: c.name }))}
                          placeholder="Select college"
                          className={fieldClass}
                        />
                      ) : (
                        <p className="font-mono text-[10px] text-crystal/40">
                          The college list is loading. You can type it below.
                        </p>
                      )}
                      <input
                        id="reg-college-other"
                        value={form.college_name}
                        onChange={set("college_name")}
                        className={`${fieldClass} mt-2`}
                        placeholder="Or type your college"
                        aria-label="College, typed"
                      />
                    </div>
                  </div>
                  <div className="grid gap-5 sm:grid-cols-2">
                    <div>
                      <label className={labelClass} htmlFor="reg-year">Year</label>
                      <Select
                        id="reg-year"
                        name="year"
                        tone="site"
                        required
                        value={form.year}
                        onChange={(value) => setForm((f) => ({ ...f, year: value }))}
                        options={YEARS.map((y) => ({ value: y, label: y }))}
                        placeholder="Select year"
                        className={fieldClass}
                      />
                    </div>
                    <div>
                      <label className={labelClass} htmlFor="reg-dept">Department</label>
                      {/* Same reasoning as the college, and the same escape
                          hatch: a department the list has not heard of is
                          information, not an error. */}
                      {lookups.departments.length ? (
                        <Select
                          id="reg-dept"
                          name="department"
                          tone="site"
                          required
                          value={form.department}
                          onChange={(value) => setForm((f) => ({ ...f, department: value }))}
                          options={lookups.departments.map((d) => ({ value: d.name, label: d.name }))}
                          placeholder="Select department"
                          className={fieldClass}
                        />
                      ) : (
                        <p className="font-mono text-[10px] text-crystal/40">
                          The department list is loading. You can type it below.
                        </p>
                      )}
                      <input
                        id="reg-dept-other"
                        value={form.department}
                        onChange={set("department")}
                        className={`${fieldClass} mt-2`}
                        placeholder="Or type your department"
                        aria-label="Department, typed"
                      />
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

                  {/* ---- event-specific inputs (FREE FIRE's in-game ID) ----
                      Rendered from the catalogue, so an event that needs a
                      rating or a handle gets it without a component change.
                      `required` on the input is belt-and-braces: this form
                      carries noValidate, so the real gate is
                      validateEventFields (and the database trigger). */}
                  {declaredFields.map((field) => (
                    <div key={field.name}>
                      <label className={labelClass} htmlFor={`reg-${field.name}`}>
                        {field.label}
                      </label>
                      <input
                        id={`reg-${field.name}`}
                        name={field.name}
                        data-event-field={field.name}
                        required
                        maxLength={field.maxLength ?? 32}
                        value={extra[field.name] ?? ""}
                        onChange={setExtraField(field.name)}
                        className={fieldClass}
                        placeholder={field.placeholder ?? ""}
                        autoComplete="off"
                      />
                      {field.help ? (
                        <p className="mt-2 text-[10px] leading-relaxed tracking-[0.14em] text-crystal/40">
                          {field.help}
                        </p>
                      ) : null}
                    </div>
                  ))}

                  {/* CASH OR UPI, chosen here rather than on a step of its own.
                      Two reasons it is not its own step: the progress track would
                      change length after the participant had already read it, and
                      a screen with two buttons and nothing else is a worse place
                      to make the decision than the form the money belongs to.

                      Cash skips the QR and the reference entirely, so a cash
                      registration ends on CONFIRM having paid nothing yet - the
                      operations team marks it verified when they take the money
                      at the desk. The AMOUNT is identical either way, so the
                      choice is only about how the money arrives. */}
                  {paid ? (
                    <fieldset id="reg-paymethod" className="flex flex-col gap-3">
                      <legend className={labelClass}>How would you like to pay?</legend>

                      {/* CASH IS A HEADING, NOT A THIRD OPTION.
                          Registering on the day is not a different product - it is
                          a cash payment the desk settles - so it does not belong
                          beside "Pay by UPI now" as an equal-weight radio. It is
                          stated as what it actually is: an instruction to contact
                          the coordinators first. The radio itself stays, and stays
                          keyboard-reachable, so the flow and the roster states
                          (awaiting_cash) are unchanged - this is presentation only.

                          The heading is a real <h3> because it is a heading: a
                          participant scanning the page should be able to reach it
                          with a screen reader's heading navigation and find the
                          instruction that differs from the default path. */}
                      <div className="border border-gold/40 bg-gold/[0.07] px-5 py-5">
                        <h3 className="font-display text-[clamp(1.25rem,3.2vw,1.9rem)] font-medium leading-tight tracking-[0.08em] text-gold [text-shadow:0_0_26px_rgba(245,215,142,0.35)]">
                          Contact the coordinators for cash
                        </h3>
                        <p className="mt-3 text-sm leading-relaxed tracking-wide text-crystal/70">
                          Registering by cash is arranged with the NEXUS
                          coordinators, not at the desk on the day. Reach them on the{" "}
                          <Link
                            to="/contact"
                            className="text-gold underline underline-offset-4 transition-colors hover:text-lavender"
                          >
                            contact page
                          </Link>{" "}
                          and they will confirm your seat and take the fee at the
                          venue.
                        </p>
                        <label
                          htmlFor="reg-pay-cash"
                          className={`mt-4 inline-flex cursor-pointer items-center gap-3 border px-4 py-2.5 transition-colors ${
                            payMethod === "cash"
                              ? "border-gold bg-gold/20 text-gold"
                              : "border-gold/40 text-crystal/70 hover:border-gold"
                          }`}
                        >
                          <input
                            id="reg-pay-cash"
                            data-action="reg-pay-cash"
                            type="radio"
                            name="payment_method"
                            checked={payMethod === "cash"}
                            onChange={() => setPayMethod("cash")}
                          />
                          <span className="text-[11px] uppercase tracking-[0.24em]">
                            {payMethod === "cash" ? "Selected" : "Choose cash"}
                          </span>
                        </label>
                      </div>

                      {/* The UPI path, which is the default and stays quiet - it
                          needs no instruction, because it is the obvious one. */}
                      {[
                        {
                          id: "utr",
                          label: "Pay by UPI now",
                          help: "Scan the QR on the next screen and paste your UTR reference.",
                        },
                      ].map((option) => (
                        <label
                          key={option.id}
                          htmlFor={`reg-pay-${option.id}`}
                          className={`flex cursor-pointer items-start gap-3 border px-4 py-3 transition-colors ${
                            payMethod === option.id
                              ? "border-lavender/70 bg-violet-bright/10"
                              : "border-lavender/20 hover:border-lavender/50"
                          }`}
                        >
                          <input
                            id={`reg-pay-${option.id}`}
                            data-action={`reg-pay-${option.id}`}
                            type="radio"
                            name="payment_method"
                            className="mt-1"
                            checked={payMethod === option.id}
                            onChange={() => setPayMethod(option.id)}
                          />
                          <span>
                            <span className="block text-sm tracking-wide text-crystal">
                              {option.label}
                            </span>
                            <span className="mt-1 block text-[11px] text-crystal/45">
                              {option.help}
                            </span>
                          </span>
                        </label>
                      ))}
                    </fieldset>
                  ) : null}

                  <div className="mt-2 flex flex-wrap items-center justify-between gap-5">
                    <Link
                      to={returnTo}
                      className="text-[10px] uppercase tracking-[0.35em] text-crystal/40 transition-colors hover:text-lavender"
                    >
                      ← Back
                    </Link>
                    <CinematicButton type="submit" id="reg-details-next">
                      {paid && !needsUtr
                        ? "Confirm registration"
                        : paid
                          ? "Continue to payment"
                          : "Confirm registration"}
                    </CinematicButton>
                  </div>
                </form>
              ) : null}
              {/* --------------- step 2 (conditional): choose events --------------- */}
              {signedIn && step === "select" && bundle ? (
                <div id="reg-step-select" className="flex flex-col gap-6">
                  <header>
                    <p className="text-[10px] uppercase tracking-[0.4em] text-gold/85">
                      {stepNumber}
                    </p>
                    <h2 className="mt-2 font-display text-[clamp(1.3rem,2.4vw,1.8rem)] tracking-[0.1em] text-crystal">
                      CHOOSE YOUR EVENTS
                    </h2>
                    <p className="mt-3 text-sm leading-relaxed text-crystal/60">
                      This bundle covers the events you pick below. The ₹
                      {payable} you pay is the bundle total and does not change
                      with your choice.
                    </p>
                  </header>
                  <EventSelection
                    bundle={bundle}
                    onSave={saveSelection}
                    saving={saving}
                    error={error}
                  />

                  {/* Back exists on the selection step because the step above it
                      does. Payment goes back here (that is the step the list says
                      came before), and without a way onward the participant who
                      mistyped their roll number, or picked the wrong events, was
                      stuck: no edit, no restart. The choice is already recorded
                      on the row, so going back does not lose it. */}
                  <button
                    type="button"
                    id="reg-select-back"
                    onClick={stepBack}
                    className="self-start text-[10px] uppercase tracking-[0.35em] text-crystal/40 transition-colors hover:text-lavender"
                  >
                    ← Back
                  </button>
                </div>
              ) : null}

              {/* --------------- step 3 (conditional): the team --------------- */}
              {signedIn && step === "team" && needsTeam ? (
                <form id="reg-step-team" onSubmit={saveTeam} noValidate className="flex flex-col gap-6">
                  <header>
                    <p className="text-[10px] uppercase tracking-[0.4em] text-gold/85">{stepNumber}</p>
                    <h2 className="mt-2 font-display text-[clamp(1.3rem,2.4vw,1.8rem)] tracking-[0.1em] text-crystal">
                      YOUR TEAM
                    </h2>
                  </header>
                  <p className="text-sm leading-relaxed text-crystal/60">
                    You are paying for the whole squad, so tell us who is in it.
                    Your own seat is already recorded — this is everybody else, up
                    to {teamCap} people in total.
                  </p>

                  <TeamRoster
                    cap={teamCap}
                    teamName={teamName}
                    members={members}
                    lookups={lookups}
                    error={error}
                    onChange={(next) => {
                      setTeamName(next.teamName);
                      setMembers(next.members);
                    }}
                  />

                  <div className="flex flex-wrap items-center gap-5">
                    {/* An explicit onClick, NOT relying on the browser routing a
                        submit button through the form's submit event. The DOM
                        here is correct — the button is inside the form, and the
                        form has an onSubmit — but "the handler never visibly
                        runs" is the hardest class of bug to diagnose precisely
                        because nothing is wrong in either place you look.
                        Calling the function directly removes that whole
                        dependency, and the form is kept for Enter-key submits.
                        `type="button"` so the click is not ALSO submitted. */}
                    <button
                      type="button"
                      onClick={() => saveTeam()}
                      data-action="save-team"
                      disabled={saving}
                      className="border border-lavender/60 px-6 py-3 text-[10px] font-medium uppercase tracking-[0.28em] text-crystal transition-colors duration-300 hover:border-lavender disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {saving ? "Saving…" : needsUtr ? "Save team and continue" : "Save team"}
                    </button>
                    <button
                      type="button"
                      id="reg-team-back"
                      onClick={stepBack}
                      className="text-[10px] uppercase tracking-[0.35em] text-crystal/40 transition-colors hover:text-lavender"
                    >
                      ← Back
                    </button>
                  </div>
                </form>
              ) : null}

              {/* ------------- payment: the QR and the reference are one step ------------- */}
              {signedIn && step === "utr" ? (
                <form id="reg-step-utr" onSubmit={handleUtrSubmit} noValidate className="flex flex-col gap-5">
                  <header>
                    <p className="text-[10px] uppercase tracking-[0.4em] text-gold/85">{stepNumber}</p>
                    <h2 className="mt-2 font-display text-[clamp(1.3rem,2.4vw,1.8rem)] tracking-[0.1em] text-crystal">
                      PAYMENT REFERENCE
                    </h2>
                    <p className="mt-3 text-sm leading-relaxed text-crystal/55">
                      Scan with any UPI app and pay{" "}
                      <span className="text-gold">₹{payable}</span>
                      {contextTitle ? ` for ${contextTitle}` : ""}, then paste the
                      transaction reference below. The admin verifies it against
                      the bank statement and confirms your seat.
                    </p>
                  </header>

                  {/* The QR sits here rather than on a step of its own. It is the
                      instruction for the field directly beneath it, and a
                      participant who has scanned it has not finished anything yet
                      — so there is nothing to "continue" past. */}
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
                    <li>Amount: <span className="text-gold">₹{payable}</span> exactly</li>
                  </ul>

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
                      onClick={stepBack}
                      className="text-[10px] uppercase tracking-[0.35em] text-crystal/40 transition-colors hover:text-lavender"
                    >
                      ← Back
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
                    .{" "}
                    {/* The panel is the same one an adopted registration lands
                        on, so it has to be true for a row in ANY state — it used
                        to promise "waiting for admin verification" even for a
                        seat that was already verified. */}
                    {done.payment_status === "verified"
                      ? "Payment verified — your seat is confirmed."
                      : done.payment_status === "rejected"
                        ? "The reference could not be matched — send a new one below."
                        : "Your entry is waiting for admin verification — watch your email for confirmation."}
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
                        {/* Told plainly, because there is nothing the participant
                            can do about it from here. The events are locked and
                            the database will refuse a change; the only route is
                            to ask the operations team, so this says who to ask
                            rather than leaving them to discover the refusal by
                            trying. */}
                        {r.selection_frozen ? (
                          <p
                            className="text-[10px] uppercase tracking-[0.2em] text-gold/85"
                            data-selection-frozen="true"
                          >
                            Event selection final — contact the operations team to change it
                          </p>
                        ) : null}
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

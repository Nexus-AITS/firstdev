import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import Page from "../components/ui/Page.jsx";
import Reveal from "../components/ui/Reveal.jsx";
import CinematicButton from "../components/ui/CinematicButton.jsx";
import Select from "../components/ui/Select.jsx";
import ParticleField from "../components/fx/ParticleField.jsx";
import GoogleSignIn from "../components/auth/GoogleSignIn.jsx";
import { useAuth } from "../context/AuthContext";
import { getEventById, getEventFee } from "../data/events.js";
import { getBundlePrice } from "../data/bundles.js";
import { loadMyProfile, saveMyProfile } from "../data/profiles.js";
import { listMyRegistrationsDetailed } from "../data/registrations.js";
import { loadLookups } from "../data/staff.js";

/**
 * Participant profile — the page that answers "where was I?".
 *
 * Three jobs, in the order a returning participant needs them:
 *
 *   1. IDENTITY — what the social login stored (avatar, name, email, provider,
 *      subject id, when they last signed in). Read-only: those columns describe
 *      somebody the database has already verified, and the browser has no write
 *      path to them.
 *
 *   2. DETAILS — the registration essentials (roll, college, year, department,
 *      phone). Editable, and the reason the wizard never asks twice: whatever is
 *      saved here prefill /register. Locked once a payment reference has been
 *      submitted, because from that point the row is evidence of what somebody
 *      paid for and the guard trigger on public.registrations refuses changes to
 *      it — the UI says so rather than letting the participant discover the
 *      refusal in a failed request.
 *
 *   3. REGISTRATIONS — every event and bundle, with the step each one stopped
 *      at and a CONTINUE link that opens the wizard at that step. The link
 *      carries ?resume=<row id>, and the wizard reads the ROW (not the link) to
 *      decide where to land.
 *
 * The UTR is never optional anywhere in this flow: the wizard validates it
 * before it will submit, so a registration cannot reach the operations team
 * without a reference to verify.
 */

const YEARS = ["1st", "2nd", "3rd", "4th"];

const emptyDetails = {
  full_name: "",
  roll_number: "",
  college_name: "",
  year: "",
  department: "",
  phone_number: "",
};

const fieldClass =
  "w-full border border-lavender/25 bg-white/[0.03] px-4 py-3 text-sm tracking-wide text-crystal placeholder:text-crystal/30 outline-none transition-colors focus:border-lavender/75";
const labelClass =
  "mb-2 block text-[10px] font-medium uppercase tracking-[0.3em] text-lavender/75";

/** Title for a catalogue id, or the id itself when the catalogue has moved on. */
function eventTitle(id) {
  return getEventById(id)?.title ?? id;
}

/**
 * Where this registration stopped, and what to do about it.
 *
 * Derived from the ROW — payment status, whether a reference was submitted,
 * whether a bundle has a selection — because those are the things the wizard
 * branches on. A label or a timestamp would be a guess.
 */
function stage(row) {
  const events = row.events ?? [];
  if (row.payment_status === "verified") {
    return { text: "Complete — payment verified", cta: null };
  }
  if (row.payment_status === "rejected") {
    return { text: "Reference rejected — resend your UTR", cta: "Fix payment" };
  }
  if (row.utr_number) {
    return { text: "Submitted — waiting for verification", cta: null };
  }
  if (row.purchase_type === "bundle" && events.length === 0) {
    return { text: "Stopped at step 2 — choose your events", cta: "Continue" };
  }
  const ref = row.purchase_ref;
  const fee = row.purchase_type === "event" ? getEventFee(ref) : ref ? getBundlePrice(ref) : null;
  if (!fee) {
    // Nothing due: the registration is in, the operations team confirms it.
    return { text: "Registered — awaiting confirmation", cta: null };
  }
  return { text: "Stopped at step 3 — paste your UTR", cta: "Continue" };
}

/** The wizard URL that resumes exactly this registration. */
function resumeHref(row) {
  const params = new URLSearchParams();
  if (row.purchase_ref) {
    if (row.purchase_type === "event") params.set("event", row.purchase_ref);
    else if (row.purchase_type === "bundle") params.set("bundle", row.purchase_ref);
  }
  params.set("resume", row.id);
  return `/register?${params.toString()}`;
}

export default function Profile() {
  const { signedIn, status, configured, configPending, name, email, avatarUrl } = useAuth();

  const authReady = status !== "loading" && !configPending;
  const gated = authReady && !signedIn;

  const [profile, setProfile] = useState(null);
  const [details, setDetails] = useState(emptyDetails);
  const [rows, setRows] = useState([]);

  /* Colleges and departments for the dropdowns, the same public list the
   * registration form uses. Fetched once on mount and deliberately not awaited by
   * anything that renders: the profile is the page a returning participant lands
   * on, and a spinner there is worse than a text field that fills in a moment
   * later. An empty list simply omits the dropdowns and leaves the typed fields,
   * so the page is never blocked on this read. */
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const set = (key) => (e) => setDetails((d) => ({ ...d, [key]: e.target.value }));

  // Both reads are scoped by RLS to the signed-in user, so this screen can only
  // ever show one participant's data — there is no "whose profile is this"
  // question to get wrong.
  useEffect(() => {
    if (!authReady || !signedIn) {
      setRows([]);
      setProfile(null);
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    setError("");
    Promise.all([loadMyProfile(), listMyRegistrationsDetailed()]).then(([p, r]) => {
      if (!alive) return;
      if (p.data) {
        setProfile(p.data);
        setDetails({
          full_name: p.data.full_name ?? "",
          roll_number: p.data.roll_number ?? "",
          college_name: p.data.college_name ?? "",
          year: p.data.year ?? "",
          department: p.data.department ?? "",
          phone_number: p.data.phone_number ?? "",
        });
      } else if (p.error) {
        setError(p.error);
      }
      if (r.error) setError(r.error);
      setRows(r.data ?? []);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [authReady, signedIn]);

  /**
   * Locked once a reference has been submitted for ANY registration.
   *
   * "Until payment is done in step 3 and the UTR is submitted" — after that the
   * personal details are part of the record the operations team verifies
   * against, so they stop being editable here. A rejected reference re-opens the
   * form: that is the state where the participant is expected to correct
   * something.
   */
  const locked = rows.some(
    (r) => r.payment_status === "unverified" || r.payment_status === "verified"
  );

  async function handleSave(e) {
    e.preventDefault();
    if (busy) return;
    if (!details.full_name.trim()) {
      setError("Enter your name before saving.");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    const { data, error: saveError } = await saveMyProfile(details);
    setBusy(false);
    if (saveError) {
      setError(saveError);
      return;
    }
    setProfile(data);
    setNotice("Saved — your next registration starts prefilled.");
  }

  return (
    <Page>
      <div className="relative min-h-svh overflow-hidden bg-void">
        <div className="pointer-events-none fixed inset-0 z-0" aria-hidden>
          <ParticleField mode="stars" factor={0.8} />
        </div>

        <section className="relative z-10 mx-auto max-w-[900px] px-5 pt-36 pb-32 md:px-10 md:pt-44">
          <Reveal>
            <p className="text-[10px] font-medium uppercase tracking-[0.55em] text-lavender/70">
              Nexus // Profile
            </p>
            <h1 className="mt-6 font-display text-[clamp(2.2rem,7vw,4.5rem)] font-medium leading-[1.05] tracking-[0.08em] text-crystal">
              YOUR <span className="italic text-lavender text-glow">ACCOUNT</span>
            </h1>
            <div className="hairline mx-auto mt-8 w-52 md:w-72" aria-hidden />
          </Reveal>

          <div className="mt-10 border border-lavender/20 bg-[linear-gradient(160deg,rgba(124,58,237,0.08),rgba(10,5,20,0.6))] p-6 md:p-9">
            {error ? (
              <p
                role="alert"
                id="profile-error"
                className="mb-5 border border-red-400/40 bg-red-500/10 px-4 py-3 text-sm text-red-200"
              >
                {error}
              </p>
            ) : null}
            {notice ? (
              <p
                id="profile-notice"
                className="mb-5 border border-emerald-400/40 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200"
              >
                {notice}
              </p>
            ) : null}

            {/* ------------- identity gate (signed out) ------------- */}
            {gated ? (
              <div id="profile-gate" className="flex flex-col items-center gap-6 py-6 text-center">
                <header>
                  <p className="text-[10px] uppercase tracking-[0.4em] text-gold/85">Step 00</p>
                  <h2 className="mt-2 font-display text-[clamp(1.3rem,2.4vw,1.8rem)] tracking-[0.1em] text-crystal">
                    SIGN IN TO SEE YOUR ACCOUNT
                  </h2>
                </header>
                <p className="max-w-md text-sm leading-relaxed text-crystal/60">
                  Your profile, your registrations and exactly where each one stopped live behind
                  your Google sign-in — the same identity that owns them in the database.
                </p>
                {configured ? (
                  <GoogleSignIn
                    label="Sign in"
                    arrow="right"
                    className="flex flex-col items-center"
                  />
                ) : (
                  <p className="text-[10px] uppercase tracking-[0.3em] text-crystal/45">
                    Registration is unavailable — this deployment has no database connection.
                  </p>
                )}
              </div>
            ) : null}

            {!authReady ? (
              <p
                id="profile-pending"
                aria-live="polite"
                className="py-10 text-center text-[10px] uppercase tracking-[0.3em] text-crystal/45"
              >
                Checking your session…
              </p>
            ) : null}

            {signedIn && loading ? (
              <p
                id="profile-loading"
                aria-live="polite"
                className="py-10 text-center text-[10px] uppercase tracking-[0.3em] text-crystal/45"
              >
                Loading your account…
              </p>
            ) : null}
          </div>

          {signedIn && !loading ? (
            <>
              {/* ---------------- identity (read-only) ---------------- */}
              <Reveal delay={0.05}>
                <section
                  id="profile-identity"
                  className="mt-8 border border-white/10 bg-white/[0.02] p-6 md:p-8"
                >
                  <h2 className="text-[10px] font-medium uppercase tracking-[0.4em] text-lavender/70">
                    Identity
                  </h2>
                  <div className="mt-5 flex items-center gap-4">
                    <span className="relative block h-14 w-14 shrink-0 overflow-hidden rounded-full border border-lavender/40 bg-[radial-gradient(circle_at_50%_35%,rgba(124,58,237,0.55),rgba(10,5,18,0.92))]">
                      {avatarUrl ? (
                        <img
                          src={avatarUrl}
                          alt=""
                          referrerPolicy="no-referrer"
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <span className="flex h-full w-full items-center justify-center font-display text-lg text-crystal">
                          {(name || email || "?").trim().charAt(0).toUpperCase()}
                        </span>
                      )}
                    </span>
                    <div className="min-w-0">
                      <p className="truncate font-display text-xl tracking-[0.08em] text-crystal">
                        {profile?.full_name || name}
                      </p>
                      <p className="truncate text-sm text-crystal/55">{profile?.email || email}</p>
                    </div>
                  </div>

                  <dl className="mt-5 grid gap-x-8 gap-y-3 text-[11px] tracking-[0.14em] sm:grid-cols-2">
                    <div className="flex justify-between gap-4 border-b border-white/5 pb-2">
                      <dt className="uppercase text-crystal/40">Signed in with</dt>
                      <dd className="capitalize text-crystal/80" data-profile-provider="true">
                        {profile?.auth_provider ?? "—"}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-4 border-b border-white/5 pb-2">
                      <dt className="uppercase text-crystal/40">Account id</dt>
                      <dd className="text-crystal/80">
                        {profile?.provider_id ? `${String(profile.provider_id).slice(0, 12)}…` : "—"}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-4 border-b border-white/5 pb-2">
                      <dt className="uppercase text-crystal/40">Last sign-in</dt>
                      <dd className="text-crystal/80">
                        {profile?.last_sign_in_at
                          ? new Date(profile.last_sign_in_at).toLocaleString("en-IN", {
                              dateStyle: "medium",
                              timeStyle: "short",
                            })
                          : "—"}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-4 border-b border-white/5 pb-2">
                      <dt className="uppercase text-crystal/40">Registrations</dt>
                      <dd className="text-crystal/80">{rows.length}</dd>
                    </div>
                  </dl>

                  <p className="mt-4 text-[10px] leading-relaxed tracking-[0.14em] text-crystal/35">
                    Name, avatar and provider come from your Google account and cannot be edited
                    here — they are what identifies you to the operations team.
                  </p>
                </section>
              </Reveal>

              {/* ------- details (editable until the UTR goes in) ------- */}
              <Reveal delay={0.1}>
                <section
                  id="profile-details"
                  className="mt-8 border border-white/10 bg-white/[0.02] p-6 md:p-8"
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-3">
                    <h2 className="text-[10px] font-medium uppercase tracking-[0.4em] text-lavender/70">
                      Registration details
                    </h2>
                    <span
                      id="profile-lock"
                      data-locked={locked ? "true" : "false"}
                      className={`text-[9px] uppercase tracking-[0.22em] ${
                        locked ? "text-gold/85" : "text-crystal/45"
                      }`}
                    >
                      {locked ? "Locked — payment submitted" : "Editable"}
                    </span>
                  </div>

                  <p className="mt-3 text-sm leading-relaxed text-crystal/55">
                    These prefill the registration form, so you enter them once.{" "}
                    {locked
                      ? "Your details are locked while a payment reference is with the operations team — contact them to change anything."
                      : "Change them any time before you submit a payment reference."}
                  </p>

                  <form onSubmit={handleSave} noValidate className="mt-6 flex flex-col gap-5">
                    <div>
                      <label className={labelClass} htmlFor="profile-name">
                        Full name
                      </label>
                      <input
                        id="profile-name"
                        name="full_name"
                        autoComplete="name"
                        required
                        disabled={locked}
                        value={details.full_name}
                        onChange={set("full_name")}
                        className={`${fieldClass} disabled:opacity-50`}
                        placeholder="e.g. Aarav Sharma"
                      />
                    </div>

                    <div className="grid gap-5 sm:grid-cols-2">
                      <div>
                        <label className={labelClass} htmlFor="profile-roll">
                          Roll number
                        </label>
                        <input
                          id="profile-roll"
                          name="roll_number"
                          disabled={locked}
                          value={details.roll_number}
                          onChange={set("roll_number")}
                          className={`${fieldClass} disabled:opacity-50`}
                          placeholder="21B81A0501"
                        />
                      </div>
                      <div>
                        <label className={labelClass} htmlFor="profile-college">
                          College
                        </label>
                        {/* Same DB-backed list as the registration form, and for
                            the same reason: a free text box here produced the
                            spelling variants that split one college three ways in
                            a pivot. The typed field underneath is not a fallback -
                            a participant whose college the list has not heard of
                            must be able to say so rather than pick a wrong one. */}
                        {lookups.colleges.length ? (
                          <Select
                            id="profile-college-select"
                            name="college_name"
                            tone="site"
                            disabled={locked}
                            value={details.college_name}
                            onChange={(value) => set("college_name")(value)}
                            options={lookups.colleges.map((c) => ({ value: c.name, label: c.name }))}
                            placeholder="Select college"
                            className={`${fieldClass} disabled:opacity-50`}
                          />
                        ) : null}
                        <input
                          id="profile-college"
                          name="college_name"
                          disabled={locked}
                          value={details.college_name}
                          onChange={set("college_name")}
                          className={`${fieldClass} mt-2 disabled:opacity-50`}
                          placeholder="Or type your college"
                        />
                      </div>
                    </div>

                    <div className="grid gap-5 sm:grid-cols-2">
                      <div>
                        <label className={labelClass} htmlFor="profile-year">
                          Year
                        </label>
                        <Select
                          id="profile-year"
                          name="year"
                          tone="site"
                          required
                          disabled={locked}
                          value={details.year}
                          onChange={(value) => setDetails((d) => ({ ...d, year: value }))}
                          options={YEARS.map((y) => ({ value: y, label: y }))}
                          placeholder="Select year"
                          className={`${fieldClass} disabled:opacity-50`}
                        />
                      </div>
                      <div>
                        <label className={labelClass} htmlFor="profile-dept">
                          Department
                        </label>
                        {lookups.departments.length ? (
                          <Select
                            id="profile-dept-select"
                            name="department"
                            tone="site"
                            disabled={locked}
                            value={details.department}
                            onChange={(value) => set("department")(value)}
                            options={lookups.departments.map((d) => ({ value: d.name, label: d.name }))}
                            placeholder="Select department"
                            className={`${fieldClass} disabled:opacity-50`}
                          />
                        ) : null}
                        <input
                          id="profile-dept"
                          name="department"
                          disabled={locked}
                          value={details.department}
                          onChange={set("department")}
                          className={`${fieldClass} mt-2 disabled:opacity-50`}
                          placeholder="Or type your department"
                        />
                      </div>
                    </div>

                    <div>
                      <label className={labelClass} htmlFor="profile-phone">
                        Phone
                      </label>
                      <input
                        id="profile-phone"
                        name="phone_number"
                        type="tel"
                        autoComplete="tel"
                        disabled={locked}
                        value={details.phone_number}
                        onChange={set("phone_number")}
                        className={`${fieldClass} disabled:opacity-50`}
                        placeholder="+91 90000 00000"
                      />
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-4">
                      <Link
                        to="/register"
                        className="text-[10px] uppercase tracking-[0.35em] text-crystal/40 transition-colors hover:text-lavender"
                      >
                        → Start a new registration
                      </Link>
                      <CinematicButton type="submit" id="profile-save" disabled={locked || busy}>
                        {busy ? "Saving…" : "Save details"}
                      </CinematicButton>
                    </div>
                  </form>
                </section>
              </Reveal>

              {/* ---------------- registrations: where you stopped ---------------- */}
              <Reveal delay={0.15}>
                <section
                  id="profile-registrations"
                  className="mt-8 border border-white/10 bg-white/[0.02] p-6 md:p-8"
                >
                  <h2 className="text-[10px] font-medium uppercase tracking-[0.4em] text-lavender/70">
                    Events &amp; bundles
                  </h2>
                  <p className="mt-3 text-sm leading-relaxed text-crystal/55">
                    Every registration on this account, and the step each one stopped at. CONTINUE
                    opens the wizard exactly there.
                  </p>

                  {rows.length === 0 ? (
                    <p className="mt-5 text-sm text-crystal/55" id="profile-empty">
                      Nothing registered yet. Pick a realm and your progress will appear here.
                    </p>
                  ) : (
                    <ul className="mt-5 flex flex-col gap-4">
                      {rows.map((row) => {
                        const s = stage(row);
                        const events = (row.events ?? []).map(eventTitle);
                        return (
                          <li
                            key={row.id}
                            data-registration-id={row.id}
                            data-stage={row.payment_status}
                            className="border border-white/10 bg-white/[0.02] px-4 py-4"
                          >
                            <div className="flex flex-wrap items-baseline justify-between gap-3">
                              <span className="text-sm tracking-wide text-crystal/85">
                                {row.purchase_label ?? "NEXUS registration"}
                              </span>
                              <span
                                className={`text-[9px] font-medium uppercase tracking-[0.22em] ${
                                  row.payment_status === "verified"
                                    ? "text-gold"
                                    : row.payment_status === "rejected"
                                      ? "text-rose-300/85"
                                      : "text-crystal/50"
                                }`}
                              >
                                {row.payment_status === "verified"
                                  ? "Payment verified"
                                  : row.payment_status === "rejected"
                                    ? "Reference rejected"
                                    : row.payment_status === "unverified"
                                      ? "Awaiting verification"
                                      : "Awaiting reference"}
                              </span>
                            </div>

                            <p className="mt-2 text-[10px] tracking-[0.14em] text-crystal/40">
                              {row.college_name} · {row.roll_number}
                              {row.year ? ` · ${row.year} year` : ""}
                              {row.utr_number ? ` · UTR ${row.utr_number}` : ""}
                            </p>

                            {/* The in-game ID is the one thing a FREE FIRE
                                participant must be able to see again: it is what
                                they are checked against at the match. */}
                            {row.free_fire_id ? (
                              <p
                                className="mt-2 text-[10px] tracking-[0.18em] text-gold/85"
                                data-free-fire-id="true"
                              >
                                Free Fire ID: {row.free_fire_id}
                              </p>
                            ) : null}

                            <p className="mt-2 text-[11px] tracking-[0.12em] text-crystal/55">
                              {events.length > 0
                                ? `Events: ${events.join(", ")}`
                                : "No events chosen yet"}
                            </p>

                            <p
                              className="mt-2 text-[10px] uppercase tracking-[0.2em] text-lavender/75"
                              data-stage-text="true"
                            >
                              {s.text}
                            </p>

                            {row.selection_frozen ? (
                              <p className="mt-2 text-[10px] uppercase tracking-[0.2em] text-gold/85">
                                Event selection final — contact the operations team to change it
                              </p>
                            ) : null}

                            {row.payment_status === "rejected" ? (
                              <p className="mt-2 text-[11px] leading-relaxed text-crystal/50">
                                Open the registration to paste a corrected UTR — it must be 6–30
                                letters, digits or dashes, and it cannot be left empty.
                              </p>
                            ) : null}

                            {s.cta ? (
                              <div className="mt-3">
                                <Link
                                  to={resumeHref(row)}
                                  data-resume={row.id}
                                  className="inline-block border border-lavender/50 px-5 py-2.5 text-[10px] font-medium uppercase tracking-[0.28em] text-crystal/85 transition-colors hover:border-lavender hover:text-crystal"
                                >
                                  {s.cta} →
                                </Link>
                              </div>
                            ) : null}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </section>
              </Reveal>
            </>
          ) : null}
        </section>
      </div>
    </Page>
  );
}

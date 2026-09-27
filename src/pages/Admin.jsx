/**
 * NEXUS operations console.
 *
 * Access model, in one place so the reasoning is not scattered:
 *
 *  1. There is NO social login here. The participant Google session lives in a
 *     different store and a different table, and cannot reach this page. A
 *     signed-in participant who types /nexus-admin gets the staff login form
 *     like anyone else.
 *  2. A session lasts 60 minutes, enforced by the database
 *     (public.staff_sessions.expires_at). The countdown below is a courtesy for
 *     the operator; if it disagrees with the server, the server wins and they
 *     are bounced back to the login form.
 *  3. Three roles, decided by the database. The page hides what a role cannot
 *     use, but hiding is only a courtesy — every restriction is also an RLS
 *     policy, so removing a button changes nothing an attacker could do.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ROLE_META,
  can,
  staffCreate,
  staffDeleteRegistration,
  staffListAudit,
  staffListPricing,
  staffListRegistrations,
  staffListStaff,
  staffLogin,
  staffLogout,
  staffResume,
  staffRevokeSessions,
  staffSetPrice,
  staffSetStatus,
  staffUpdate,
} from "../data/staff.js";
import { bundles } from "../data/bundles.js";
import { events } from "../data/events.js";
import { loadPricing, subscribePricing } from "../data/pricing.js";

const SESSION_MINUTES = 60;

const TABS = [
  { id: "roster", label: "Roster", action: "read" },
  { id: "audit", label: "Audit log", action: "view_audit" },
  { id: "staff", label: "Staff", action: "manage_staff" },
  { id: "pricing", label: "Pricing", action: "edit_pricing" },
];

/* ============================== login ============================== */

function StaffLogin({ onSignedIn }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    const result = await staffLogin(username, password);
    setBusy(false);
    if (!result.ok) {
      // The server's message is deliberately identical for a bad username and a
      // bad password, so this text never reveals which one was wrong.
      setError(result.error);
      setPassword("");
      return;
    }
    onSignedIn(result.session);
  }

  return (
    <main className="flex min-h-[100vh] flex-1 items-center justify-center px-4 py-24">
      <div className="w-full max-w-md">
        <p className="font-mono text-[11px] uppercase tracking-[0.42em] text-violet-bright">
          NEXUS Operations
        </p>
        <h1 className="mt-3 text-3xl font-bold tracking-tight text-bone">Staff sign in</h1>
        <p className="mt-3 text-sm leading-relaxed text-ash">
          This console is for the NEXUS operations team. Participant Google accounts cannot access
          it. Sessions expire automatically after {SESSION_MINUTES} minutes.
        </p>

        {/* The admin-* ids are the contract that scripts/verify.mjs asserts
            against. They are named for the PAGE, not for the credential type:
            the credentials below are staff ones, deliberately not a social
            login, which is why they are username + password. */}
        <form id="admin-signin" onSubmit={submit} className="mt-8 space-y-4">
          <div>
            <label
              htmlFor="staff-username"
              className="block font-mono text-[11px] uppercase tracking-[0.3em] text-ash"
            >
              Username
            </label>
            <input
              id="staff-username"
              name="username"
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              required
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="mt-2 w-full border border-line bg-void-raised px-3 py-2.5 font-mono text-sm text-bone outline-none transition focus:border-violet-bright"
            />
          </div>

          <div>
            <label
              htmlFor="staff-password"
              className="block font-mono text-[11px] uppercase tracking-[0.3em] text-ash"
            >
              Password
            </label>
            <input
              id="staff-password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-2 w-full border border-line bg-void-raised px-3 py-2.5 font-mono text-sm text-bone outline-none transition focus:border-violet-bright"
            />
          </div>

          {error ? (
            <p
              id="admin-signin-error"
              role="alert"
              className="border border-ember/50 bg-ember/10 px-3 py-2 text-sm text-ember"
            >
              {error}
            </p>
          ) : null}

          <button
            id="admin-signin-submit"
            type="submit"
            disabled={busy}
            className="w-full border border-violet-bright bg-violet/20 px-4 py-2.5 font-mono text-xs uppercase tracking-[0.3em] text-violet-bright transition hover:bg-violet/30 disabled:opacity-50"
          >
            {busy ? "Checking…" : "Sign in"}
          </button>
        </form>
      </div>
    </main>
  );
}

/* ============================== shared bits ============================== */

const STATUS_STYLES = {
  verified: "text-jade border-jade/50 bg-jade/10",
  awaiting_utr: "text-amber border-amber/50 bg-amber/10",
  unverified: "text-ash border-line bg-void-raised",
  rejected: "text-ember border-ember/50 bg-ember/10",
};

function StatusPill({ status }) {
  return (
    <span
      className={`inline-block whitespace-nowrap border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.2em] ${
        STATUS_STYLES[status] ?? STATUS_STYLES.unverified
      }`}
    >
      {status?.replace(/_/g, " ") ?? "unknown"}
    </span>
  );
}

/** `2026-09-27T06:11:21.853734+00:00` -> `27 Sep 2026, 06:11` */
function when(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });
}

function Banner({ kind = "error", children }) {
  if (!children) return null;
  const tone = kind === "ok" ? "border-jade/50 bg-jade/10 text-jade" : "border-ember/50 bg-ember/10 text-ember";
  return (
    <p role="status" className={`border px-3 py-2 text-sm ${tone}`}>
      {children}
    </p>
  );
}

function ActionButton({ label, onClick, disabled, danger = false }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`border px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.2em] transition disabled:opacity-40 ${
        danger
          ? "border-ember/50 text-ember hover:bg-ember/15"
          : "border-violet-bright/60 text-violet-bright hover:bg-violet/20"
      }`}
    >
      {label}
    </button>
  );
}

/* ============================== roster ============================== */

function RosterTab({ session, rows, reload }) {
  const role = session.role;
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [notice, setNotice] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (status !== "all" && r.payment_status !== status) return false;
      if (!q) return true;
      return [r.name, r.email, r.roll_number, r.college_name, r.utr_number]
        .filter(Boolean)
        .some((field) => String(field).toLowerCase().includes(q));
    });
  }, [rows, query, status]);

  async function act(id, run, message) {
    setBusyId(id);
    setNotice(null);
    const result = await run();
    setBusyId(null);
    if (result.ok) {
      setNotice({ kind: "ok", text: message });
      reload();
    } else {
      // The server's own error is not shown verbatim: it can echo request
      // details, and the operator has nothing actionable in it either way.
      setNotice({ kind: "error", text: "That action did not go through. Please try again." });
    }
  }

  const readOnly = !can(role, "verify");

  return (
    <section>
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[16rem] flex-1">
          <label htmlFor="roster-search" className="block font-mono text-[11px] uppercase tracking-[0.3em] text-ash">
            Search
          </label>
          <input
            id="roster-search"
            type="search"
            placeholder="Name, email, roll number, college, or UTR"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="mt-2 w-full border border-line bg-void-raised px-3 py-2 font-mono text-sm text-bone outline-none transition focus:border-violet-bright"
          />
        </div>
        <div>
          <label htmlFor="roster-status" className="block font-mono text-[11px] uppercase tracking-[0.3em] text-ash">
            Status
          </label>
          <select
            id="roster-status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="mt-2 border border-line bg-void-raised px-3 py-2 font-mono text-sm text-bone outline-none transition focus:border-violet-bright"
          >
            <option value="all">All</option>
            <option value="awaiting_utr">Awaiting UTR</option>
            <option value="verified">Verified</option>
            <option value="rejected">Rejected</option>
            <option value="unverified">Unverified</option>
          </select>
        </div>
      </div>

      <p className="mt-3 font-mono text-[11px] uppercase tracking-[0.25em] text-ash">
        {filtered.length} of {rows.length} registrations
      </p>

      {notice ? <div className="mt-3"><Banner kind={notice.kind}>{notice.text}</Banner></div> : null}

      {readOnly ? (
        <p className="mt-4 border border-line bg-void-raised px-3 py-2 text-sm text-ash">
          You are signed in as a {ROLE_META[role].label.toLowerCase()}. You can read and search, but
          changing a payment status is reserved for administrators and above.
        </p>
      ) : null}

      {/* id="admin-table-wrap" is the anchor scripts/verify.mjs asserts on to
          prove the roster is absent for anyone without a staff session. */}
      <ul id="admin-table-wrap" className="mt-5 space-y-3">
        {filtered.map((r) => (
          <li key={r.id} className="border border-line bg-void-raised p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-lg font-semibold text-bone">{r.name}</p>
                <p className="mt-1 font-mono text-xs text-ash">
                  {r.college_name} · {r.department} · {r.year}
                </p>
                <p className="mt-1 font-mono text-xs text-ash">
                  {r.roll_number} · {r.email} · {r.phone_number}
                </p>
                <p className="mt-1 font-mono text-xs text-ash">
                  {r.purchase_label ?? r.purchase_type ?? "—"}
                  {r.purchase_amount != null ? ` · ₹${r.purchase_amount}` : ""}
                </p>
                <p className="mt-1 font-mono text-xs text-ash">
                  UTR: {r.utr_number || "—"} · submitted {when(r.utr_submitted_at)}
                </p>
                <p className="mt-1 font-mono text-xs text-ash">
                  Registered {when(r.created_at)}
                  {r.user_id ? "" : " · no owner linked yet"}
                </p>
                {r.payment_verified_by ? (
                  <p className="mt-1 font-mono text-xs text-jade">
                    Verified by {r.payment_verified_by} on {when(r.payment_verified_at)}
                  </p>
                ) : null}
              </div>
              <StatusPill status={r.payment_status} />
            </div>

            {!readOnly ? (
              <div className="mt-4 flex flex-wrap gap-2">
                <ActionButton
                  label="Confirm"
                  disabled={r.payment_status === "verified" || busyId === r.id}
                  onClick={() =>
                    act(
                      r.id,
                      () => staffSetStatus(session.token, r.id, "verified", session.username),
                      `${r.name} confirmed. Recorded in the audit log as ${session.username}.`
                    )
                  }
                />
                <ActionButton
                  label="Reject"
                  disabled={r.payment_status === "rejected" || busyId === r.id}
                  onClick={() =>
                    act(
                      r.id,
                      () => staffSetStatus(session.token, r.id, "rejected", session.username),
                      `${r.name} rejected. Recorded in the audit log as ${session.username}.`
                    )
                  }
                />
              </div>
            ) : null}

            {can(role, "remove") ? (
              <div className="mt-2">
                <ActionButton
                  danger
                  label="Remove permanently"
                  disabled={busyId === r.id}
                  onClick={() => {
                    if (!window.confirm(`Permanently remove ${r.name}? This cannot be undone.`)) return;
                    act(
                      r.id,
                      () => staffDeleteRegistration(session.token, r.id),
                      `${r.name} removed. The removal is recorded in the audit log.`
                    );
                  }}
                />
              </div>
            ) : null}
          </li>
        ))}
        {filtered.length === 0 ? (
          <li className="border border-line bg-void-raised px-4 py-6 text-center text-sm text-ash">
            No registrations match that search.
          </li>
        ) : null}
      </ul>
    </section>
  );
}

/* ============================== audit log ============================== */

const ACTION_LABELS = {
  login: "Signed in",
  logout: "Signed out",
  bootstrap_master: "Created the first master administrator",
  create_staff: "Added a staff account",
  update_staff: "Changed a staff account",
  revoke_sessions: "Revoked all sessions",
  update_registration: "Changed a registration",
  delete_registration: "Removed a registration",
  create_price: "Added a price",
  update_price: "Changed a price",
  delete_price: "Removed a price",
};

/**
 * The answer to "who confirmed this participant, and when?".
 *
 * This is a read-only window onto public.staff_audit_log, which is append-only
 * and written by database triggers. Nothing on this page can edit or delete an
 * entry, so the record cannot be tidied up after the fact.
 */
function AuditTab({ rows }) {
  const [filter, setFilter] = useState("all");

  const shown = useMemo(
    () => (filter === "all" ? rows : rows.filter((r) => r.action === filter)),
    [rows, filter]
  );

  return (
    <section>
      <div>
        <label htmlFor="audit-filter" className="block font-mono text-[11px] uppercase tracking-[0.3em] text-ash">
          Show
        </label>
        <select
          id="audit-filter"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="mt-2 border border-line bg-void-raised px-3 py-2 font-mono text-sm text-bone outline-none transition focus:border-violet-bright"
        >
          <option value="all">Everything</option>
          {Object.entries(ACTION_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>

      <p className="mt-3 font-mono text-[11px] uppercase tracking-[0.25em] text-ash">
        {shown.length} entries · newest first · append-only, nothing here can be edited or deleted
      </p>

      <ol className="mt-5 space-y-2">
        {shown.map((entry) => (
          <li key={entry.id} className="border border-line bg-void-raised px-4 py-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="font-mono text-sm text-bone">
                {entry.username ?? "system"}
                <span className="ml-2 text-xs text-ash">{entry.role ?? ""}</span>
              </p>
              <p className="font-mono text-[11px] text-ash">{when(entry.created_at)}</p>
            </div>
            <p className="mt-1 text-sm text-bone">
              {ACTION_LABELS[entry.action] ?? entry.action}
            </p>
            {entry.details ? (
              <p className="mt-1 break-words font-mono text-[11px] text-ash">
                {Object.entries(entry.details)
                  .filter(([, v]) => v != null)
                  .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`)
                  .join("  ·  ")}
              </p>
            ) : null}
          </li>
        ))}
        {shown.length === 0 ? (
          <li className="border border-line bg-void-raised px-4 py-6 text-center text-sm text-ash">
            No matching entries yet.
          </li>
        ) : null}
      </ol>
    </section>
  );
}

/* ============================== staff ============================== */

const ROLE_OPTIONS = [
  { value: "coordinator", label: "Coordinator — read and search only" },
  { value: "admin", label: "Administrator — accept or reject participants" },
  { value: "master", label: "Master administrator — everything" },
];

const inputClass =
  "mt-2 w-full border border-line bg-void-raised px-3 py-2 font-mono text-sm text-bone outline-none transition focus:border-violet-bright";

function Field({ label, id, hint, children }) {
  return (
    <div>
      <label htmlFor={id} className="block font-mono text-[11px] uppercase tracking-[0.3em] text-ash">
        {label}
      </label>
      {children}
      {hint ? <p className="mt-1 font-mono text-[10px] text-ash/70">{hint}</p> : null}
    </div>
  );
}

/**
 * Add and manage operations accounts. Master-only in the UI, and master-only in
 * the database — staff_create / staff_update re-check the role server-side, so
 * calling the function directly as a non-master still fails.
 */
function StaffTab({ session, rows, reload }) {
  const [form, setForm] = useState({ username: "", fullName: "", password: "", role: "coordinator" });
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setNotice(null);
    const result = await staffCreate({ ...form, token: session.token });
    setBusy(false);
    if (result.body?.ok) {
      setForm({ username: "", fullName: "", password: "", role: "coordinator" });
      setNotice({ kind: "ok", text: `${form.username} added.` });
      reload();
    } else {
      setNotice({ kind: "error", text: result.body?.error ?? "Could not add that account." });
    }
  }

  async function runChange(run, okText) {
    setNotice(null);
    const result = await run();
    if (result.body?.ok) {
      setNotice({ kind: "ok", text: okText });
      reload();
    } else {
      setNotice({ kind: "error", text: result.body?.error ?? "That change did not go through." });
    }
  }

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  return (
    <section>

      <h2 className="mt-8 font-mono text-[11px] uppercase tracking-[0.35em] text-ash">
        Current accounts ({rows.length})
      </h2>
      <ul className="mt-3 space-y-2">
        {rows.map((u) => (
          <li key={u.id} className="border border-line bg-void-raised px-4 py-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="font-mono text-sm text-bone">
                  {u.username}
                  {u.username === session.username ? (
                    <span className="ml-2 text-[11px] text-violet-bright">(you)</span>
                  ) : null}
                </p>
                <p className="mt-1 font-mono text-[11px] text-ash">
                  {u.full_name || "—"} · {u.role} · {u.is_active ? "active" : "deactivated"} · last
                  signed in {when(u.last_login_at)}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <select
                  aria-label={`Role for ${u.username}`}
                  value={u.role}
                  onChange={(e) =>
                    runChange(
                      () => staffUpdate({ userId: u.id, role: e.target.value, token: session.token }),
                      `${u.username} is now ${e.target.value}.`
                    )
                  }
                  className="border border-line bg-void px-2 py-1 font-mono text-[11px] text-bone"
                >
                  {ROLE_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.value}
                    </option>
                  ))}
                </select>
                <ActionButton
                  label={u.is_active ? "Deactivate" : "Reactivate"}
                  onClick={() =>
                    runChange(
                      () => staffUpdate({ userId: u.id, isActive: !u.is_active, token: session.token }),
                      `${u.username} ${u.is_active ? "deactivated" : "reactivated"}.`
                    )
                  }
                />
                <ActionButton
                  label="Sign out everywhere"
                  onClick={() =>
                    runChange(
                      () => staffRevokeSessions(u.id, session.token),
                      `All sessions for ${u.username} were revoked.`
                    )
                  }
                />
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* ============================== pricing ============================== */

/**
 * Edit the prices that the public site reads.
 *
 * The bundle/event shape stays in JS (bundles.js / events.js); only the number
 * lives here. Saving writes public.pricing, and a database trigger records the
 * change in the audit log with the operator's identity — so "who raised this
 * price and when" has an answer.
 */
function PricingTab({ session, rows, reload }) {
  const [drafts, setDrafts] = useState({});
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(null);

  const catalogue = useMemo(
    () => [
      ...bundles.map((b) => ({ kind: "bundle", ref_id: b.id, label: `${b.number} · ${b.name}`, price: Number(b.price) })),
      ...events
        .filter((e) => e.payment != null && e.payment !== "")
        .map((e) => ({ kind: "event", ref_id: e.id, label: `${e.number} · ${e.title}`, price: e.payment })),
    ],
    []
  );

  const liveFor = (kind, refId) => rows.find((p) => p.kind === kind && p.ref_id === refId);

  async function save(entry) {
    const key = `${entry.kind}:${entry.ref_id}`;
    const raw = drafts[key];
    const price = Number(raw);
    if (!Number.isInteger(price) || price < 0) {
      setNotice({ kind: "error", text: "Enter a whole number of rupees, zero or more." });
      return;
    }
    setBusy(key);
    setNotice(null);
    const result = await staffSetPrice({ kind: entry.kind, refId: entry.ref_id, price, token: session.token });
    setBusy(null);
    if (result.ok) {
      setDrafts((d) => {
        const next = { ...d };
        delete next[key];
        return next;
      });
      setNotice({ kind: "ok", text: `${entry.label} is now ₹${price}. Change recorded in the audit log.` });
      reload();
    } else {
      setNotice({ kind: "error", text: "That price could not be saved." });
    }
  }

  const sections = [
    { kind: "bundle", title: "Bundles" },
    { kind: "event", title: "Events" },
  ];

  return (
    <section>
      <p className="text-sm leading-relaxed text-ash">
        These are the live prices the public site renders. Editing one takes effect on the next page
        load — no rebuild, no redeploy. The values compiled into the site are used only if this
        database is unreachable.
      </p>

      {notice ? <div className="mt-4"><Banner kind={notice.kind}>{notice.text}</Banner></div> : null}

      {sections.map((section) => (
        <div key={section.kind} className="mt-8">
          <h2 className="font-mono text-[11px] uppercase tracking-[0.35em] text-ash">{section.title}</h2>
          <ul className="mt-3 space-y-2">
            {catalogue
              .filter((c) => c.kind === section.kind)
              .map((entry) => {
                const key = `${entry.kind}:${entry.ref_id}`;
                const live = liveFor(entry.kind, entry.ref_id);
                const current = live ? live.price : entry.price;
                return (
                  <li key={key} className="flex flex-wrap items-center gap-3 border border-line bg-void-raised px-4 py-3">
                    <div className="min-w-[12rem] flex-1">
                      <p className="font-mono text-sm text-bone">{entry.label}</p>
                      <p className="mt-0.5 font-mono text-[11px] text-ash">
                        {entry.ref_id}
                        {live ? ` · from database` : " · not set in the database yet"}
                      </p>
                    </div>
                    <label className="sr-only" htmlFor={`price-${key}`}>
                      Price for {entry.label}
                    </label>
                    <input
                      id={`price-${key}`}
                      type="number"
                      min="0"
                      step="1"
                      inputMode="numeric"
                      value={drafts[key] ?? String(current)}
                      onChange={(e) => setDrafts((d) => ({ ...d, [key]: e.target.value }))}
                      className="w-28 border border-line bg-void px-3 py-2 font-mono text-sm text-bone outline-none focus:border-violet-bright"
                    />
                    <ActionButton
                      label="Save"
                      disabled={busy === key || Number(drafts[key] ?? current) === current}
                      onClick={() => save(entry)}
                    />
                  </li>
                );
              })}
          </ul>
        </div>
      ))}
    </section>
  );
}

/* ============================== console ============================== */

function Console({ session, onExpired }) {
  const [tab, setTab] = useState("roster");
  const [rows, setRows] = useState({ registrations: [], audit: [], staff: [], pricing: [] });
  const [remaining, setRemaining] = useState(session.expiresAt - Date.now());
  const [signedOut, setSignedOut] = useState(false);

  /* Reload prices whenever they change, so a master editing a price here sees
     the same numbers a visitor would. */
  useEffect(() => {
    loadPricing();
    return subscribePricing(() => loadPricing());
  }, []);

  /* Countdown. Purely informational — the database decides the real expiry. */
  useEffect(() => {
    const tick = () => setRemaining(session.expiresAt - Date.now());
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [session]);

  /* The local countdown hit zero: hand back to the login form. Any request made
     after this is refused by the server anyway, so this is NOT the security
     boundary — it exists so the operator is not staring at a frozen screen
     wondering why nothing is saving. */
  useEffect(() => {
    if (remaining <= 0 && !signedOut) {
      setSignedOut(true);
      onExpired();
    }
  }, [remaining, signedOut, onExpired]);

  const reload = useCallback(async () => {
    const token = session.token;
    const [reg, audit, staff, pricing] = await Promise.all([
      staffListRegistrations(token),
      can(session.role, "view_audit") ? staffListAudit(token) : { data: [] },
      can(session.role, "manage_staff") ? staffListStaff(token) : { data: [] },
      can(session.role, "edit_pricing") ? staffListPricing(token) : { data: [] },
    ]);
    setRows({
      registrations: reg.data,
      audit: audit.data,
      staff: staff.data,
      pricing: pricing.data,
    });
  }, [session]);

  useEffect(() => {
    reload();
  }, [reload]);

  async function signOut() {
    await staffLogout();
    setSignedOut(true);
    onExpired();
  }

  const visibleTabs = TABS.filter((t) => can(session.role, t.action));
  const active = visibleTabs.find((t) => t.id === tab) ?? visibleTabs[0];
  const roleMeta = ROLE_META[session.role];
  const mm = Math.max(0, Math.floor(remaining / 60000));
  const ss = Math.max(0, Math.floor((remaining % 60000) / 1000));
  const expiringSoon = remaining > 0 && remaining < 5 * 60 * 1000;

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-16">
      <header className="border-b border-line pb-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="font-mono text-[11px] uppercase tracking-[0.42em] text-violet-bright">
              NEXUS Operations
            </p>
            <h1 className="mt-2 text-3xl font-bold tracking-tight text-bone">Operations console</h1>
            <p className="mt-2 text-sm text-ash">
              Signed in as <span className="text-bone">{session.username}</span> · {roleMeta.label}
            </p>
            <p className="mt-1 max-w-prose text-sm text-ash">{roleMeta.blurb}</p>
          </div>
          <div className="text-right">
            <p className="font-mono text-[11px] uppercase tracking-[0.3em] text-ash">Session ends in</p>
            <p
              className={`mt-1 font-mono text-2xl tabular-nums ${expiringSoon ? "text-ember" : "text-bone"}`}
            >
              {String(mm).padStart(2, "0")}:{String(ss).padStart(2, "0")}
            </p>
            <button
              type="button"
              onClick={signOut}
              className="mt-2 border border-line px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.2em] text-ash transition hover:border-ember/60 hover:text-ember"
            >
              Sign out
            </button>
          </div>
        </div>

        {expiringSoon ? (
          <p className="mt-4 border border-ember/50 bg-ember/10 px-3 py-2 text-sm text-ember">
            Your session is about to expire. Sign in again to keep working.
          </p>
        ) : null}
      </header>

      <nav aria-label="Console sections" className="mt-6 flex flex-wrap gap-2">
        {visibleTabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            aria-current={active?.id === t.id ? "page" : undefined}
            className={`border px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.2em] transition ${
              active?.id === t.id
                ? "border-violet-bright bg-violet/20 text-violet-bright"
                : "border-line text-ash hover:text-bone"
            }`}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <div className="mt-8">
        {active?.id === "roster" ? (
          <RosterTab session={session} rows={rows.registrations} reload={reload} />
        ) : null}
        {active?.id === "audit" ? <AuditTab rows={rows.audit} /> : null}
        {active?.id === "staff" ? <StaffTab session={session} rows={rows.staff} reload={reload} /> : null}
        {active?.id === "pricing" ? <PricingTab session={session} rows={rows.pricing} reload={reload} /> : null}
      </div>
    </main>
  );
}

export default function Admin() {
  const [session, setSession] = useState(null);
  const [checking, setChecking] = useState(true);

  /* On mount, ask the database whether the stored token is still good. A reload
     must not resurrect a session that has since expired or been revoked. */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const result = await staffResume();
      if (cancelled) return;
      setSession(result.session ?? null);
      setChecking(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (checking) {
    return (
      <main aria-busy="true" className="flex min-h-[60vh] flex-1 items-center justify-center">
        <span className="sr-only">Checking your staff session…</span>
        <span
          aria-hidden
          className="anim-pulse h-3 w-3 rotate-45 bg-violet-bright shadow-[0_0_18px_rgba(168,85,247,0.95)]"
        />
      </main>
    );
  }

  if (!session) {
    return <StaffLogin onSignedIn={setSession} />;
  }

  return <Console session={session} onExpired={() => setSession(null)} />;
}

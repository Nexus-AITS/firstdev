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
  MAX_PAGE_SIZE,
  PAGE_SIZES,
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

/**
 * Delay a fast-changing value so it settles.
 *
 * Search boxes need this now that the query runs in the database: without a
 * debounce, every keystroke is a PostgREST request against a growing table —
 * the exact load problem paging was added to solve. The input still updates
 * immediately, so typing stays responsive; only the fetch waits.
 */
function useDebounced(value, delay = 300) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);
  return settled;
}

/**
 * Which list call backs each tab, the state key it writes into, and the grant
 * that gates it.
 *
 * Module scope on purpose: this is a static routing table, and rebuilding it per
 * render would give `reload` a new dependency on every render, which would make
 * the load-on-tab-change effect fire in a loop.
 */
const LIST_BY_TAB = {
  roster: { key: "registrations", action: "read", run: staffListRegistrations, label: "roster" },
  audit: { key: "audit", action: "view_audit", run: staffListAudit, label: "audit" },
  staff: { key: "staff", action: "manage_staff", run: staffListStaff, label: "staff" },
  pricing: { key: "pricing", action: "edit_pricing", run: staffListPricing, label: "pricing" },
};

/** The state shape a tab has before it has ever loaded. `total: null` is
 *  meaningful: the count is unknown, not zero, so the pager shows "loaded"
 *  rather than inventing a page count. */
const EMPTY_WINDOW = { data: [], total: null, page: 1, pageCount: 1, error: null };

/** The default window for each tab. 25 rows is a screenful of the console's
 *  roomy cards; the audit log is denser but shares the same default so the
 *  control behaves identically everywhere.
 *
 *  Pricing is the exception and the reason is structural, not laziness: that tab
 *  maps database rows onto a fixed JS catalogue with `find`, so a price on
 *  page 2 would render as "not set in the database yet" and an operator would
 *  "correct" it by re-saving the compiled-in number. The catalogue is bounded by
 *  the site's own content (19 rows today), so it is read in one window — paged,
 *  counted, and refreshable, but not split. PricingTab refuses to edit if it
 *  ever outgrows MAX_PAGE_SIZE. */
const DEFAULT_PAGING = {
  registrations: { page: 1, pageSize: 25, query: "", status: "all" },
  audit: { page: 1, pageSize: 25, action: "all" },
  staff: { page: 1, pageSize: 25 },
  pricing: { page: 1, pageSize: MAX_PAGE_SIZE },
};

/** Merge a partial window change for one tab, leaving the others untouched.
 *  Changing a page or a page size returns to page 1: keeping the old page
 *  number after narrowing a filter would show an empty screen and look broken. */
function mergePaging(state, key, patch) {
  const resets = "page" in patch && patch.page !== 1;
  return {
    ...state,
    [key]: { ...state[key], ...patch, ...(resets ? { page: 1 } : {}) },
  };
}

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

/**
 * The row-paging + refresh control shared by every data tab.
 *
 * Two separate jobs that belong in one place:
 *
 *   Refresh is how an operator picks up a change made by someone else (a peer
 *   confirms a payment, a master edits a price). Auto-refresh on a timer was
 *   rejected deliberately: the roster is an append-only table that several
 *   operators share, and a poll would re-query the database forever on a screen
 *   nobody is necessarily looking at. One explicit read, on demand.
 *
 *   Paging is what keeps that read small. The database is asked for one window
 *   at a time with an exact count, so the page stays fast as the table grows
 *   and the operator is told the true total rather than being handed a silently
 *   truncated first screen.
 *
 * `busy` dims everything while a fetch is in flight so a double-click cannot
 * fire two overlapping reads.
 */
function Pager({ page, pageSize, pageCount, total, busy, onPage, onPageSize, label }) {
  const first = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total ?? 0);
  const canPrev = page > 1;
  const canNext = total != null && page < pageCount;
  // Numbered jump links, windowed around the current page so the control stays
  // a fixed size whether the table has 3 rows or 3,000. Named `pages` rather
  // than `window` to avoid shadowing the global the page itself depends on.
  const pages = [];
  for (let p = Math.max(1, page - 2); p <= Math.min(pageCount, page + 2); p += 1) {
    pages.push(p);
  }

  return (
    <div className="mt-4 flex flex-wrap items-center gap-3 border border-line bg-void-raised px-3 py-2">
      <button
        type="button"
        id={`${label}-refresh`}
        onClick={() => onPage(page)}
        disabled={busy}
        className="border border-line px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.2em] text-ash transition hover:border-violet-bright/60 hover:text-violet-bright disabled:opacity-40"
      >
        {busy ? "Refreshing…" : "Refresh"}
      </button>

      <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-ash" aria-live="polite">
        {total == null
          ? `${last} loaded`
          : `${first}–${last} of ${total}`}
      </p>

      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => onPage(page - 1)}
          disabled={!canPrev || busy}
          aria-label="Previous page"
          className="border border-line px-2 py-1 font-mono text-[11px] text-ash transition hover:text-bone disabled:opacity-30"
        >
          Prev
        </button>
        {pages.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => onPage(p)}
            disabled={busy}
            aria-current={p === page ? "page" : undefined}
            className={`border px-2 py-1 font-mono text-[11px] transition disabled:opacity-40 ${
              p === page
                ? "border-violet-bright bg-violet/20 text-violet-bright"
                : "border-line text-ash hover:text-bone"
            }`}
          >
            {p}
          </button>
        ))}
        <button
          type="button"
          onClick={() => onPage(page + 1)}
          disabled={!canNext || busy}
          aria-label="Next page"
          className="border border-line px-2 py-1 font-mono text-[11px] text-ash transition hover:text-bone disabled:opacity-30"
        >
          Next
        </button>
      </div>

      <label className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.2em] text-ash">
        Rows
        <select
          value={pageSize}
          onChange={(e) => onPageSize(Number(e.target.value))}
          disabled={busy}
          className="border border-line bg-void-raised px-2 py-1 font-mono text-[11px] text-bone outline-none focus:border-violet-bright"
        >
          {PAGE_SIZES.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

/* ============================== roster ============================== */

function RosterTab({
  session,
  window: win,
  paging,
  busy,
  reload,
  setPage,
  setPageSize,
  setFilter,
}) {
  const role = session.role;
  const [notice, setNotice] = useState(null);
  const [busyId, setBusyId] = useState(null);

  /* The text box is the operator's own state; the query it triggers belongs to
     the database. Debounced so a fast typist makes one request, not one per
     keystroke. */
  const [term, setTerm] = useState(paging.query);
  const debouncedTerm = useDebounced(term, 300);
  useEffect(() => {
    if (debouncedTerm !== paging.query) setFilter({ query: debouncedTerm });
    // Only the settled term should drive this; including `paging` would make
    // the effect re-fire when its own setFilter lands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedTerm]);

  /* If the filter is cleared from elsewhere (the reset button), follow it. */
  useEffect(() => {
    if (paging.query === "" && term !== "") setTerm("");
  }, [paging.query, term]);

  const rows = win.data;
  const filtering = paging.query.trim() !== "" || paging.status !== "all";

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
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            className="mt-2 w-full border border-line bg-void-raised px-3 py-2 font-mono text-sm text-bone outline-none transition focus:border-violet-bright"
          />
        </div>
        <div>
          <label htmlFor="roster-status" className="block font-mono text-[11px] uppercase tracking-[0.3em] text-ash">
            Status
          </label>
          <select
            id="roster-status"
            value={paging.status}
            onChange={(e) => setFilter({ status: e.target.value })}
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
        {filtering
          ? `${win.total ?? rows.length} matching registration${win.total === 1 ? "" : "s"}`
          : "Newest first"}
      </p>

      {notice ? <div className="mt-3"><Banner kind={notice.kind}>{notice.text}</Banner></div> : null}

      {win.error ? <div className="mt-3"><Banner>Could not load the roster. Try refreshing.</Banner></div> : null}

      {readOnly ? (
        <p className="mt-4 border border-line bg-void-raised px-3 py-2 text-sm text-ash">
          You are signed in as a {ROLE_META[role].label.toLowerCase()}. You can read and search, but
          changing a payment status is reserved for administrators and above.
        </p>
      ) : null}

      <Pager
        label="roster"
        page={win.page}
        pageSize={paging.pageSize}
        pageCount={win.pageCount}
        total={win.total}
        busy={busy}
        onPage={setPage}
        onPageSize={setPageSize}
      />

      {/* id="admin-table-wrap" is the anchor scripts/verify.mjs asserts on to
          prove the roster is absent for anyone without a staff session. */}
      <ul id="admin-table-wrap" className="mt-5 space-y-3">
        {rows.map((r) => (
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
        {rows.length === 0 ? (
          <li className="border border-line bg-void-raised px-4 py-6 text-center text-sm text-ash">
            {busy
              ? "Loading…"
              : filtering
                ? "No registrations match that search."
                : "No registrations yet."}
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
function AuditTab({ window: win, paging, busy, setPage, setPageSize, setFilter }) {
  const rows = win.data;

  return (
    <section>
      <div>
        <label htmlFor="audit-filter" className="block font-mono text-[11px] uppercase tracking-[0.3em] text-ash">
          Show
        </label>
        <select
          id="audit-filter"
          value={paging.action}
          onChange={(e) => setFilter({ action: e.target.value })}
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
        Newest first · append-only, nothing here can be edited or deleted
      </p>

      {win.error ? <div className="mt-3"><Banner>Could not load the audit log. Try refreshing.</Banner></div> : null}

      <Pager
        label="audit"
        page={win.page}
        pageSize={paging.pageSize}
        pageCount={win.pageCount}
        total={win.total}
        busy={busy}
        onPage={setPage}
        onPageSize={setPageSize}
      />

      <ol className="mt-5 space-y-2">
        {rows.map((entry) => (
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
        {rows.length === 0 ? (
          <li className="border border-line bg-void-raised px-4 py-6 text-center text-sm text-ash">
            {busy ? "Loading…" : "No matching entries yet."}
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
 * Create and manage operations accounts. Master-only in the UI, and master-only in
 * the database — staff_create / staff_update re-check the role server-side, so
 * calling the function directly as a non-master still fails.
 *
 * This is the full set of account operations, from the panel itself:
 *   create  — the "Add an account" form (username, name, password, any of the
 *             three roles, including promoting someone to master)
 *   read    — the list below
 *   update  — role, full name, password
 *   delete  — deactivate
 *
 * There is deliberately no hard DELETE. staff_users rows are referenced by
 * staff_audit_log.staff_id and by every payment confirmed under that username;
 * removing the row would leave those actions attributed to an account that no
 * longer exists. Deactivating revokes access while keeping the audit trail
 * intact. The database refuses to deactivate or demote the last active master,
 * so this panel cannot lock everyone out.
 */
function StaffTab({
  session,
  window: win,
  paging,
  busy: listBusy,
  reload,
  setPage,
  setPageSize,
}) {
  /* `busy` below is the form's own submitting flag; the list's in-flight flag
     arrives as `listBusy` so the two never shadow each other. */
  const rows = win.data;
  const [form, setForm] = useState({ username: "", fullName: "", password: "", role: "coordinator" });
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  /* Per-account edit buffer, keyed by user id so two rows can be mid-edit
     without one clobbering the other. */
  const [edits, setEdits] = useState({});

  const editFor = (u) => edits[u.id] ?? { fullName: u.full_name ?? "", newPassword: "" };
  const setEdit = (u, patch) =>
    setEdits((prev) => ({ ...prev, [u.id]: { ...(prev[u.id] ?? { fullName: u.full_name ?? "", newPassword: "" }), ...patch } }));

  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setNotice(null);
    const result = await staffCreate({ ...form, token: session.token });
    setBusy(false);
    if (result.body?.ok) {
      setForm({ username: "", fullName: "", password: "", role: "coordinator" });
      setNotice({ kind: "ok", text: `${form.username} added as ${form.role}.` });
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
      return true;
    }
    setNotice({ kind: "error", text: result.body?.error ?? "That change did not go through." });
    return false;
  }

  /* One save for the name + password fields. The RPC treats NULL as "leave
     alone", so only genuinely-changed fields are sent. */
  async function saveEdits(u) {
    const draft = editFor(u);
    const nameChanged = draft.fullName.trim() !== (u.full_name ?? "");
    const newPassword = draft.newPassword.trim();
    if (!nameChanged && !newPassword) return;

    const ok = await runChange(
      () =>
        staffUpdate({
          userId: u.id,
          fullName: nameChanged ? draft.fullName : null,
          newPassword: newPassword || null,
          token: session.token,
        }),
      newPassword
        ? `${u.username} updated and their password was reset.`
        : `${u.username}'s name was updated.`
    );
    if (!ok) return;

    setEdits((prev) => {
      const next = { ...prev };
      delete next[u.id];
      return next;
    });
    // A password reset that leaves the old session alive would not actually
    // revoke access, so the sessions go with it.
    if (newPassword) {
      await staffRevokeSessions(u.id, session.token);
      reload();
    }
  }

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  return (
    <section>
      <p className="text-sm leading-relaxed text-ash">
        Create and manage operations accounts. Only a master administrator may do any of this, and
        the database re-checks that on every call — so hiding this tab is a courtesy, not the control.
      </p>

      {notice ? (
        <div className="mt-4">
          <Banner kind={notice.kind}>{notice.text}</Banner>
        </div>
      ) : null}

      {/* ---------- create ---------- */}
      <form onSubmit={submit} className="mt-8 border border-line bg-void-raised p-4">
        <h2 className="font-mono text-[11px] uppercase tracking-[0.35em] text-ash">
          Add an account
        </h2>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <Field
            label="Username"
            id="staff-new-username"
            hint="3–32 characters: a–z, 0-9, dot, dash, underscore."
          >
            <input
              id="staff-new-username"
              name="username"
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              required
              pattern="[a-z0-9._\-]{3,32}"
              value={form.username}
              onChange={set("username")}
              className={inputClass}
            />
          </Field>
          <Field label="Full name" id="staff-new-fullname" hint="Optional — shown in the audit log.">
            <input
              id="staff-new-fullname"
              name="fullName"
              autoComplete="off"
              value={form.fullName}
              onChange={set("fullName")}
              className={inputClass}
            />
          </Field>
          <Field label="Password" id="staff-new-password" hint="At least 10 characters.">
            <input
              id="staff-new-password"
              name="password"
              type="password"
              autoComplete="new-password"
              required
              minLength={10}
              value={form.password}
              onChange={set("password")}
              className={inputClass}
            />
          </Field>
          <Field label="Role" id="staff-new-role" hint={ROLE_META[form.role]?.blurb}>
            <select
              id="staff-new-role"
              name="role"
              value={form.role}
              onChange={set("role")}
              className={inputClass}
            >
              {ROLE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="mt-4">
          <button
            type="submit"
            id="staff-create-submit"
            disabled={busy}
            className="border border-violet-bright/60 px-4 py-2 font-mono text-[11px] uppercase tracking-[0.2em] text-violet-bright transition hover:bg-violet/20 disabled:opacity-40"
          >
            {busy ? "Creating…" : "Create account"}
          </button>
        </div>
      </form>

      <h2 className="mt-8 font-mono text-[11px] uppercase tracking-[0.35em] text-ash">
        Current accounts
      </h2>

      {win.error ? <div className="mt-3"><Banner>Could not load staff accounts. Try refreshing.</Banner></div> : null}

      <Pager
        label="staff"
        page={win.page}
        pageSize={paging.pageSize}
        pageCount={win.pageCount}
        total={win.total}
        busy={listBusy}
        onPage={setPage}
        onPageSize={setPageSize}
      />

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

            {/* name + password */}
            <div className="mt-4 grid gap-3 border-t border-line pt-4 md:grid-cols-[1fr_1fr_auto] md:items-end">
              <Field label="Full name" id={`staff-name-${u.id}`}>
                <input
                  id={`staff-name-${u.id}`}
                  value={editFor(u).fullName}
                  onChange={(e) => setEdit(u, { fullName: e.target.value })}
                  className={inputClass}
                />
              </Field>
              <Field
                label="New password"
                id={`staff-pass-${u.id}`}
                hint="Leave blank to keep the current one."
              >
                <input
                  id={`staff-pass-${u.id}`}
                  type="password"
                  autoComplete="new-password"
                  minLength={10}
                  value={editFor(u).newPassword}
                  onChange={(e) => setEdit(u, { newPassword: e.target.value })}
                  className={inputClass}
                />
              </Field>
              <div className="pb-0.5">
                <ActionButton
                  label="Save"
                  disabled={
                    (editFor(u).fullName.trim() === (u.full_name ?? "") &&
                      !editFor(u).newPassword.trim()) ||
                    (editFor(u).newPassword.length > 0 && editFor(u).newPassword.length < 10)
                  }
                  onClick={() => saveEdits(u)}
                />
              </div>
            </div>
            {u.username === session.username ? (
              <p className="mt-2 font-mono text-[10px] text-ash/70">
                Resetting your own password signs you out everywhere — you will sign in again with
                the new one.
              </p>
            ) : null}
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
function PricingTab({
  session,
  window: win,
  paging,
  busy: listBusy,
  reload,
  setPage,
  setPageSize,
}) {
  /* `busy` below is the per-row save flag; the list's in-flight flag arrives as
     `listBusy` so the two never shadow each other. */
  const rows = win.data;
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
      // Re-read public.pricing so the public site's cached prices and this
      // console's own list both reflect the change immediately. `force` is
      // required because loadPricing() is otherwise a no-op once loaded.
      await loadPricing({ force: true });
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

  if (rows.length > MAX_PAGE_SIZE) {
    // A catalogue longer than one window means `liveFor` cannot see every price,
    // and the console would start reporting real database prices as "not set in
    // the database yet". Refuse to edit rather than mislead the operator.
    return (
      <p className="border border-ember/50 bg-ember/10 px-3 py-2 text-sm text-ember">
        {rows.length} priced items exceeds the {MAX_PAGE_SIZE}-row window this editor loads at
        once. Raise MAX_PAGE_SIZE before editing prices, or the console would report real
        database prices as missing.
      </p>
    );
  }
  return (
    <section>
      <p className="text-sm leading-relaxed text-ash">
        These are the live prices the public site renders. Editing one takes effect on the next page
        load — no rebuild, no redeploy. The values compiled into the site are used only if this
        database is unreachable.
      </p>

      {notice ? <div className="mt-4"><Banner kind={notice.kind}>{notice.text}</Banner></div> : null}

      {win.error ? <div className="mt-4"><Banner>Could not load prices. Try refreshing.</Banner></div> : null}

      <Pager
        label="pricing"
        page={win.page}
        pageSize={paging.pageSize}
        pageCount={win.pageCount}
        total={win.total}
        busy={listBusy}
        onPage={setPage}
        onPageSize={setPageSize}
      />

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
  /* Each tab keeps its own window of rows, plus the page controls that produced
     it. EMPTY_WINDOW / DEFAULT_PAGING are module constants, so this initialiser
     runs once and the state identity stays stable across renders. */
  const [rows, setRows] = useState({
    registrations: EMPTY_WINDOW,
    audit: EMPTY_WINDOW,
    staff: EMPTY_WINDOW,
    pricing: EMPTY_WINDOW,
  });
  const [paging, setPaging] = useState(DEFAULT_PAGING);
  const [loading, setLoading] = useState({});

  const [remaining, setRemaining] = useState(session.expiresAt - Date.now());
  const [signedOut, setSignedOut] = useState(false);

  /* Load the live prices once, and re-read this console's own rows whenever the
     price store changes.

     The old code was `subscribePricing(() => loadPricing())`, an infinite loop:
     loadPricing() notifies its listeners in its `finally`, and that listener
     called loadPricing() again, forever. The console is also not where prices are
     fetched for the public site any more (App.jsx does that at start-up) — here
     we only need to refresh after PricingTab saves, so the subscriber bumps a
     counter that re-runs `reload`. */
  const [pricingVersion, setPricingVersion] = useState(0);
  useEffect(() => {
    loadPricing();
    return subscribePricing(() => setPricingVersion((v) => v + 1));
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

  const reload = useCallback(
    async (tabId, override) => {
      const spec = LIST_BY_TAB[tabId];
      if (!spec || !can(session.role, spec.action)) return;
      const token = session.token;
      const options = override ?? paging[spec.key];
      setLoading((prev) => ({ ...prev, [tabId]: true }));
      const result = await spec.run(token, options);
      setLoading((prev) => ({ ...prev, [tabId]: false }));
      if (!result.ok) {
        setRows((prev) => ({
          ...prev,
          [spec.key]: { ...prev[spec.key], error: result.error ?? "Could not load." },
        }));
        return;
      }
      const nextWindow = {
        data: result.data,
        total: result.total,
        page: result.page,
        pageCount: result.pageCount,
        error: null,
      };
      setRows((prev) => ({ ...prev, [spec.key]: nextWindow }));
      // An edit can remove the last row of the final page (a registration
      // removed, a filter narrowed). Sitting on page 3 of 3 and then reading
      // "0 rows" is a dead end for the operator, so step back to the last page
      // that still exists. Only when the page really is empty — not on every
      // load, which would fight the operator's own paging.
      if (result.data.length === 0 && result.page > 1 && result.page > result.pageCount) {
        setPaging((prev) => ({
          ...prev,
          [spec.key]: { ...prev[spec.key], page: result.pageCount },
        }));
      }
    },
    // pricingVersion is a dependency on purpose: when the price store changes
    // (a save, or the app-start load landing) the pricing tab re-reads itself.
    [session, paging, pricingVersion]
  );

  /* Load the visible tab whenever the tab, its paging, or the price version
     changes. `reload` already closes over `paging`, so changing a page or a
     filter produces a new callback identity and this fires. One effect rather
     than a special case for pricing: the pricing tab still refreshes when the
     price store changes because `pricingVersion` is a `reload` dependency. */
  useEffect(() => {
    reload(tab);
  }, [tab, reload]);

  /** Jump to a page. The Pager's Refresh button calls this with the same page
   *  it is already on, which is what makes it a refresh rather than a move. */
  const goToPage = useCallback(
    (tabId, page) => {
      const spec = LIST_BY_TAB[tabId];
      if (!spec) return;
      setPaging((prev) => mergePaging(prev, spec.key, { page: Math.max(1, page) }));
    },
    []
  );

  /** Change the page size, always returning to page 1: page 7 of the old size
   *  is almost certainly past the end of the new, larger one. */
  const setPageSize = useCallback((tabId, pageSize) => {
    const spec = LIST_BY_TAB[tabId];
    if (!spec) return;
    setPaging((prev) => ({ ...prev, [spec.key]: { ...prev[spec.key], pageSize, page: 1 } }));
  }, []);

  /** Update a filter (search text, status, action). Resetting to page 1 is the
   *  whole point — see mergePaging. */
  const setFilter = useCallback((tabId, patch) => {
    const spec = LIST_BY_TAB[tabId];
    if (!spec) return;
    setPaging((prev) => mergePaging(prev, spec.key, { ...patch, page: 1 }));
  }, []);

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
          <RosterTab
            session={session}
            window={rows.registrations}
            paging={paging.registrations}
            busy={Boolean(loading.roster)}
            reload={() => reload("roster")}
            setPage={(page) => goToPage("roster", page)}
            setPageSize={(size) => setPageSize("roster", size)}
            setFilter={(patch) => setFilter("roster", patch)}
          />
        ) : null}
        {active?.id === "audit" ? (
          <AuditTab
            window={rows.audit}
            paging={paging.audit}
            busy={Boolean(loading.audit)}
            setPage={(page) => goToPage("audit", page)}
            setPageSize={(size) => setPageSize("audit", size)}
            setFilter={(patch) => setFilter("audit", patch)}
          />
        ) : null}
        {active?.id === "staff" ? (
          <StaffTab
            session={session}
            window={rows.staff}
            paging={paging.staff}
            busy={Boolean(loading.staff)}
            reload={() => reload("staff")}
            setPage={(page) => goToPage("staff", page)}
            setPageSize={(size) => setPageSize("staff", size)}
          />
        ) : null}
        {active?.id === "pricing" ? (
          <PricingTab
            session={session}
            window={rows.pricing}
            paging={paging.pricing}
            busy={Boolean(loading.pricing)}
            reload={() => reload("pricing")}
            setPage={(page) => goToPage("pricing", page)}
            setPageSize={(size) => setPageSize("pricing", size)}
          />
        ) : null}
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

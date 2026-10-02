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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  MAX_PAGE_SIZE,
  PAGE_SIZES,
  ROLE_META,
  can,
  staffCreate,
  staffCreateRegistration,
  staffDeleteRegistration,
  staffUpdateRegistration,
  staffExportRegistrations,
  staffFilterOptions,
  staffListAudit,
  staffListPricing,
  staffListRegistrations,
  staffListStaff,
  staffLogin,
  staffLogout,
  staffResume,
  staffRevokeSessions,
  staffSetPrice,
  staffSetSelectionFreeze,
  staffSetStatus,
  staffUpdate,
  loadLookups,
  loadPublicCatalogue,
} from "../data/staff.js";
import { buildRosterWorkbook, downloadXlsx } from "../lib/xlsx.js";
import Select from "../components/ui/Select.jsx";
import DateField from "../components/ui/DateField.jsx";
import CatalogueManager from "../components/admin/CatalogueManager.jsx";
import ContactManager from "../components/admin/ContactManager.jsx";
import DestinationManager from "../components/admin/DestinationManager.jsx";
import LookupManager from "../components/admin/LookupManager.jsx";
import RegistrationEditor, { emptyRegistration } from "../components/admin/RegistrationEditor.jsx";
import FinanceStrip from "../components/admin/FinanceStrip.jsx";
// The `bundles` and `events` arrays are deliberately NOT imported here. This tab
// used to build its price list from them, which meant an event created in the
// Catalogue tab had no row to edit and a price for a deleted event was invisible.
// The catalogue is the list now — see the note above loadCatalogueList.
import { loadCatalogue } from "../data/catalogue.js";
import { loadPricing, subscribePricing } from "../data/pricing.js";

const SESSION_MINUTES = 60;

const TABS = [
  { id: "roster", label: "Roster", action: "read" },
  { id: "audit", label: "Audit log", action: "view_audit" },
  { id: "staff", label: "Staff", action: "manage_staff" },
  { id: "pricing", label: "Pricing", action: "edit_pricing" },
  // The catalogue is master-only, matching the RPCs' own staff_at_least('master')
  // gate. Hiding it from coordinators is a courtesy; the database is what
  // actually refuses the write.
  { id: "catalogue", label: "Catalogue", action: "manage_catalogue" },
  // Contact channels are admin+ (the operations team that verifies payments is
  // the team that answers the phone), matching the RPC's own gate.
  { id: "contacts", label: "Contacts", action: "manage_contacts" },
  // Where the roster is sent, and the keys a partner system reads it with.
  // Gated on manage_contacts (admin+) rather than manage_catalogue, because
  // sending data OUT is a decision about participant privacy, not about the
  // event catalogue — the same reasoning that put contacts with the team that
  // answers the phone. The database re-checks the real gate per RPC.
  { id: "destinations", label: "Destinations", action: "manage_contacts" },
  // Colleges and departments are admin+ to edit, for the same reason contacts
  // are: the team that takes registrations is the team that knows the colleges.
  { id: "lookups", label: "Colleges", action: "manage_contacts" },
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
  registrations: {
    page: 1,
    pageSize: 25,
    query: "",
    status: "all",
    // The event and date filters join the roster tab's own filter set. `all` and
    // the empty string are the "not filtering" values, and staffListRegistrations
    // drops both before building the query.
    event: "all",
    fromDate: "",
    toDate: "",
    // College, year and department. Columns on registrations, so the roster can
    // narrow to them in SQL — the operator's question is very often "everyone
    // from CSIT who is in their 2nd year", and the free-text search cannot
    // express that without matching a substring of each field separately.
    college: "all",
    year: "all",
    department: "all",
    // How the money arrived: cash or UPI. Kept SEPARATE from `status` rather than
    // folded into it, because "cash" spans two statuses - awaiting_cash (money
    // still due at the desk) and verified (taken and confirmed). Filtering on the
    // method answers the reconciler's question - "every cash row" - in one click,
    // which is what a cash float is counted against.
    method: "all",
  },
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

/**
 * `2026-09-27T06:11:21.853734+00:00` -> `27 Sep 2026, 11:41 IST`
 *
 * The zone is Asia/Kolkata, EXPLICITLY, and it was wrong before: this formatted
 * in UTC, so a payment confirmed at 9am IST was stamped 03:30 and the audit log
 * read as though the operations team worked five and a half hours in the past.
 * An operator checking "did we verify this before or after the tournament
 * started" was reading the wrong clock — and the mismatch was invisible because
 * the number looked like a real time.
 *
 * It is pinned rather than left to the browser because the DATABASE is what
 * decides these moments: the export's day windows and the date filters are
 * already +05:30, and a stamp rendered in the operator's own timezone would
 * disagree with the very filters it is being read against. The IST suffix is
 * printed because a bare time is exactly the thing that was ambiguous.
 */
function when(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Kolkata",
  })} IST`;
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
        <span className="w-[5.5rem]">
          <Select
            id="pager-size"
            ariaLabel="Rows per page"
            value={String(pageSize)}
            onChange={(value) => onPageSize(Number(value))}
            disabled={busy}
            options={PAGE_SIZES.map((n) => ({ value: String(n), label: String(n) }))}
            className="px-2 py-1 text-[11px]"
          />
        </span>
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
  /* Which row's editor is open, and whether the ADD form is open. One slot
     rather than one per row, so an operator cannot open four editors on four
     rows and lose track of what they were editing. */
  const [editingId, setEditingId] = useState(null);
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);

  /* What the three filters can actually match, each with a registration COUNT.
     Read from staff_filter_options(), NOT from the registration form's lookup
     list — those are two different populations. The form offers 17 colleges;
     only 3 have anybody registered. Picking one with nobody used to produce an
     empty roster that looked exactly like a broken filter, and the natural
     conclusion is that the filter does not work. Showing "(0)" turns that into
     an honest answer.

     Fetched once and deliberately not awaited by anything that renders: the
     roster is the page an operator lands on mid-shift, and a spinner there is
     worse than three filters that fill in a moment later. */
  const [lookups, setLookups] = useState({ colleges: [], departments: [], years: [] });
  useEffect(() => {
    let alive = true;
    /* session.token, NOT a bare `token`. This component destructures `session`,
       not `token` — a bare identifier is a ReferenceError at runtime that
       esbuild does NOT catch, because it never resolves free identifiers. It
       took the whole Roster tab down while `npm run build` stayed green, which
       is the second time that has bitten in this codebase. */
    staffFilterOptions(session.token).then((result) => {
      if (alive && result.ok) {
        setLookups({
          colleges: result.colleges,
          departments: result.departments,
          years: result.years,
        });
      }
    });
    return () => {
      alive = false;
    };
  }, [session.token]);

  /* The text box is the operator's own state; the query it triggers belongs to
     the database.

     Two things this deliberately does, because the search is the filter people
     fight with most:

     1. WAITS FOR THREE CHARACTERS. `or=(name.ilike.%a%,…five columns…)` is a
        full scan that matches nearly every row, and the operator is not going
        to read the result — they are halfway through typing. Three is also the
        shortest pattern pg_trgm can actually help with (migration …012), so a
        shorter term would be slow for a reason no index can fix. The box stays
        live; only the request waits.

     2. SHOWS THAT IT IS WORKING. The list used to sit there unchanged for the
        length of the request with no indicator, so a search that was working
        read as one that had been ignored. `searching` covers both halves of the
        wait: the debounce still settling, and the request in flight. */
  const MIN_TERM = 3;
  const [term, setTerm] = useState(paging.query);
  const debouncedTerm = useDebounced(term, 320);
  const trimmed = term.trim();
  const ready = debouncedTerm.trim().length >= MIN_TERM;
  const settledTerm = ready ? debouncedTerm : "";
  const tooShort = trimmed.length > 0 && trimmed.length < MIN_TERM;

  /* What we last handed to the database, so we can tell OUR change apart from
     somebody else's.

     This is the bug that made the search look broken. There was a second effect
     shaped "if the query is empty, clear the box", meant to follow the Clear
     filters button. But while an operator is TYPING, `paging.query` is still
     the previous value — the debounce has not fired yet — so that effect read
     their first keystroke as "the filter was cleared elsewhere" and wiped the
     box. One character typed, then gone. With a fast typist it flickered; with
     a slow one it looked like the field ignored you entirely. Nothing to do
     with the database, which was answering correctly the whole time. */
  const pushed = useRef(paging.query);

  // Push our own settled term. Only the settled value drives this, so this does
  // not re-fire when the setFilter it makes lands.
  useEffect(() => {
    if (settledTerm === paging.query) return;
    pushed.current = settledTerm;
    setFilter({ query: settledTerm });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settledTerm]);

  // Adopt a query changed by something else (Clear filters), and only that.
  useEffect(() => {
    if (paging.query === pushed.current) return;
    pushed.current = paging.query;
    setTerm(paging.query);
  }, [paging.query]);

  // The debounce has not fired yet, or the list is fetching.
  const searching = (trimmed !== "" && trimmed !== settledTerm) || busy;

  const rows = win.data;
  const [catalogueEvents, setCatalogueEvents] = useState([]);
  const [exporting, setExporting] = useState(false);

  /* The event filter's options come from the catalogue, so the console never
     offers an event the database does not know about — which would filter to
     nothing and read as broken. A failed load is non-fatal: the filter simply
     stays on "All events". */
  useEffect(() => {
    let alive = true;
    loadPublicCatalogue().then(({ events: list }) => {
      if (alive && Array.isArray(list)) setCatalogueEvents(list);
    });
    return () => {
      alive = false;
    };
  }, []);

  /**
   * Download the roster as a spreadsheet.
   *
   * The rows come from the export RPC, NOT from the paged list above. The pager
   * shows 25 at a time, so building the file from what is on screen would hand an
   * operator reconciling a payment sheet a fraction of the truth — and a file
   * whose row count silently depends on which page they happened to be viewing.
   *
   * The date and event filters are passed through so the file matches what the
   * operator is looking at. The search text is deliberately NOT: the export RPC
   * has no such parameter, and silently exporting a different set than the one on
   * screen would be worse than not honouring it.
   */
  async function exportRoster() {
    if (exporting) return;
    setExporting(true);
    setNotice(null);
    const result = await staffExportRegistrations(session.token, {
      fromDate: paging.fromDate || null,
      toDate: paging.toDate || null,
      event: paging.event ?? "all",
      status: paging.status ?? "all",
      /* The college / year / department filters go into the export too. The sheet
         and the roster on screen are the same question asked twice: an operator
         who narrows to one college and presses Download must get that college's
         sheet. Exporting everything while the screen showed one college is the
         kind of mistake that reconciles a payment sheet against the wrong people
         and is not noticed until the money does not add up. */
      college: paging.college ?? "all",
      year: paging.year ?? "all",
      department: paging.department ?? "all",
      /* The payment-method filter too. Same reason, sharper: a cash sheet that
         quietly contains UTR rows (or the reverse) is a reconciliation error that
         looks fine until somebody counts the float. */
      method: paging.method ?? "all",
    });
    setExporting(false);

    if (!result.ok) {
      setNotice({ kind: "error", text: "The export could not be prepared. Please try again." });
      return;
    }
    if (!result.rows.length) {
      setNotice({
        kind: "error",
        text: "No registrations match these filters, so there is nothing to export.",
      });
      return;
    }

    // Named for what was filtered, so a file forwarded to a reconciler says what
    // it contains without anyone having to open it.
    const scope = paging.event !== "all" ? `-${paging.event}` : "";
    const stamp = new Date().toISOString().slice(0, 10);
    downloadXlsx(
      buildRosterWorkbook(
        result.rows,
        `${paging.fromDate || "all"}-to-${paging.toDate || "all"}${scope}`
      ),
      `nexus-roster-${stamp}${scope}.xlsx`
    );
    setNotice({
      kind: "ok",
      text: `Exported ${result.rows.length} registration${result.rows.length === 1 ? "" : "s"}.`,
    });
  }

  // Every one of these narrows the set, and each has to count as "filtering" or
  // the summary line would read "Newest first" over a filtered result.
  /* Every one of these narrows the set, and each has to count as "filtering" or
     the summary line would read "Newest first" over a filtered result. The three
     new ones are here for that reason alone — a filter that works but does not
     change the label is how an operator concludes it did nothing. */
  const filtering =
    paging.query.trim() !== "" ||
    paging.status !== "all" ||
    paging.event !== "all" ||
    paging.college !== "all" ||
    paging.year !== "all" ||
    paging.department !== "all" ||
    Boolean(paging.fromDate) ||
    Boolean(paging.toDate);

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

  /* Save one edited row. The server's own sentence is shown verbatim here, unlike
     `act()` above — because this form's whole job is to explain refusals the
     operator can act on ("empty the reference after setting the status to
     Rejected first"), and replacing them with "please try again" would leave
     somebody stuck in front of a form that will never save. */
  async function saveEdit(id, pairs) {
    setSaving(true);
    const result = await staffUpdateRegistration(session.token, id, Object.fromEntries(pairs));
    setSaving(false);
    if (result.ok) {
      setEditingId(null);
      setNotice({
        kind: "ok",
        text:
          result.changed > 0
            ? `Saved. ${result.changed} field${result.changed === 1 ? "" : "s"} changed, recorded in the audit log as ${session.username}.`
            : "Nothing was changed.",
      });
      reload();
    } else {
      setNotice({ kind: "error", text: result.error ?? "That change could not be saved." });
    }
  }

  async function createOne(pairs) {
    setSaving(true);
    const result = await staffCreateRegistration(session.token, Object.fromEntries(pairs));
    setSaving(false);
    if (result.ok) {
      setAdding(false);
      setNotice({
        kind: "ok",
        text: "Registration added. It has no owner linked — nobody signed up on the site.",
      });
      reload();
    } else {
      setNotice({ kind: "error", text: result.error ?? "That registration could not be added." });
    }
  }

  /**
   * Freeze or re-open a selection.
   *
   * Separate from `act()` because it deliberately shows the SERVER's message.
   * `act()` replaces failures with a generic sentence, which is right for the
   * routine buttons — but the whole point here is that an admin who tries to lift
   * a freeze is told only a master can, and that sentence is the only thing
   * explaining what to do next. A generic "that did not go through" would leave
   * them with no way forward.
   */
  async function toggleFreeze(row) {
    if (busyId) return;
    const next = !row.selection_frozen;
    setBusyId(row.id);
    setNotice(null);
    const result = await staffSetSelectionFreeze(session.token, row.id, next);
    setBusyId(null);
    if (!result.ok) {
      setNotice({ kind: "error", text: result.error });
      return;
    }
    setNotice({
      kind: "ok",
      text: next
        ? `${row.name}'s event selection is now final. Only a master can re-open it.`
        : `${row.name}'s event selection is open again.`,
    });
    reload();
  }

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
          <div className="mt-2">
            <Select
              id="roster-status"
              data-action="roster-status"
              value={paging.status}
              onChange={(value) => setFilter({ status: value })}
              options={[
                { value: "all", label: "All" },
                /* Every value public.payment_status allows, in lifecycle order.
                   `awaiting_cash` is here because it is a real state with real
                   rows - money due at the desk, never a UTR - and it was MISSING
                   from this list. Ten registrations sat in it, counted in every
                   total on this screen and reachable by no filter at all: the one
                   question an operator asks most at the desk ("who still owes me
                   cash?") had no answer, and the only way to get it was to search
                   the free-text box, which does not match on status.

                   The list is written out rather than read from the database
                   because the labels are operator wording, not enum labels, and
                   the two are not the same vocabulary: `unverified` means a UTR
                   was submitted and nobody has checked it, which is not what
                   "unverified" suggests to somebody reading it quickly. The test
                    scripts/verify-roster-filters.mjs asserts this list against the
                   live enum, so a status added by a later migration fails the
                   suite instead of quietly becoming unfilterable. */
                { value: "awaiting_utr", label: "Awaiting UTR" },
                { value: "awaiting_cash", label: "Awaiting cash" },
                { value: "unverified", label: "Unverified" },
                { value: "verified", label: "Verified" },
                { value: "rejected", label: "Rejected" },
              ]}
              className="w-[11rem]"
            />
          </div>
        </div>

        {/* PAYMENT METHOD, beside Status rather than inside it.

            Deliberately a second control and not more Status options. "Cash" is
            not a lifecycle stage: the same cash registration is `awaiting_cash`
            until somebody takes the money and `verified` afterwards, so a
            reconciler asking "show me every cash payment" needs to span both -
            which a status filter structurally cannot do, because every value in
            it means exactly one stage. Two cash statuses would have been the
            alternative, and it would have been wrong: it would split one
            population in two and make a count of cash registrations depend on
            which screen you counted it from. */}
        <div>
          <label htmlFor="roster-method" className="block font-mono text-[11px] uppercase tracking-[0.3em] text-ash">
            Payment
          </label>
          <div className="mt-2">
            <Select
              id="roster-method"
              data-action="roster-method"
              value={paging.method}
              onChange={(value) => setFilter({ method: value })}
              options={[
                { value: "all", label: "All payments" },
                { value: "cash", label: "Cash (any status)" },
                { value: "utr", label: "UPI / UTR" },
              ]}
              className="w-[11rem]"
            />
          </div>
        </div>

        {/* The event filter narrows to registrations that actually carry the
            event. It is driven by the catalogue, not a hardcoded list, so a new
            event becomes filterable the moment the database knows about it. */}
        <div>
          <label htmlFor="roster-event" className="block font-mono text-[11px] uppercase tracking-[0.3em] text-ash">
            Event
          </label>
          <div className="mt-2">
            <Select
              id="roster-event"
              value={paging.event}
              onChange={(value) => setFilter({ event: value })}
              options={[
                { value: "all", label: "All events" },
                ...catalogueEvents.map((e) => ({ value: e.id, label: e.title })),
              ]}
              className="w-[15rem]"
            />
          </div>
        </div>

        {/* College, year and department. Columns on registrations, so these are
            exact matches in SQL rather than something the browser filters over
            the loaded page — the whole point being that "CSIT, 2nd year" finds
            the person who is not on the page currently on screen.

            Driven by public_lookups(), the same lists the registration form
            offers, so a filter can never name a college nobody has registered
            from. YEAR is a closed set of four, so it is written out here rather
            than read from a table the column CHECK already guarantees. */}
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label
              htmlFor="roster-college"
              className="block font-mono text-[11px] uppercase tracking-[0.3em] text-ash"
            >
              College
            </label>
            <div className="mt-2">
              <Select
                id="roster-college"
                data-action="roster-college"
                value={paging.college}
                onChange={(value) => setFilter({ college: value })}
                options={[
                  { value: "all", label: "All colleges" },
                  /* The count is the whole reason this control reads the way it
                     does. "Sri Venkateswara College of Engineering (SVCE) (0)"
                     says "nobody has registered from there yet"; the same college
                     with no number says "the filter is broken", and the operator
                     cannot tell which they are looking at. */
                  ...lookups.colleges.map((c) => ({
                    value: c.name,
                    label: `${c.name} (${c.count ?? 0})`,
                  })),
                ]}
                className="w-[15rem]"
              />
            </div>
          </div>
          <div>
            <label
              htmlFor="roster-year"
              className="block font-mono text-[11px] uppercase tracking-[0.3em] text-ash"
            >
              Year
            </label>
            <div className="mt-2">
              <Select
                id="roster-year"
                data-action="roster-year"
                value={paging.year}
                onChange={(value) => setFilter({ year: value })}
                options={[
                  { value: "all", label: "All years" },
                  ...lookups.years.map((y) => ({
                    value: y.name,
                    label: `${y.name} (${y.count ?? 0})`,
                  })),
                ]}
                className="w-[10rem]"
              />
            </div>
          </div>
          <div>
            <label
              htmlFor="roster-department"
              className="block font-mono text-[11px] uppercase tracking-[0.3em] text-ash"
            >
              Department
            </label>
            <div className="mt-2">
              <Select
                id="roster-department"
                data-action="roster-department"
                value={paging.department}
                onChange={(value) => setFilter({ department: value })}
                options={[
                  { value: "all", label: "All departments" },
                  ...lookups.departments.map((d) => ({
                    value: d.name,
                    label: `${d.name} (${d.count ?? 0})`,
                  })),
                ]}
                className="w-[15rem]"
              />
            </div>
          </div>
        </div>

        {/* Calendar dates, not timestamps. The data layer appends the +05:30 day
            boundary itself; sending a full ISO instant from the browser would
            hand Postgres a UTC value and quietly cut the day at 05:30 IST.

            A themed picker rather than <input type="date">: the native one opens
            the operating system's own light-themed calendar on top of the dark
            console, and offered no way to jump to today. */}
        <div>
          <label htmlFor="roster-from" className="block font-mono text-[11px] uppercase tracking-[0.3em] text-ash">
            From
          </label>
          <div className="mt-2">
            <DateField
              id="roster-from"
              value={paging.fromDate}
              onChange={(value) => setFilter({ fromDate: value })}
              placeholder="Any date"
              max={paging.toDate || undefined}
            />
          </div>
        </div>
        <div>
          <label htmlFor="roster-to" className="block font-mono text-[11px] uppercase tracking-[0.3em] text-ash">
            To
          </label>
          <div className="mt-2">
            <DateField
              id="roster-to"
              value={paging.toDate}
              onChange={(value) => setFilter({ toDate: value })}
              placeholder="Any date"
              min={paging.fromDate || undefined}
            />
          </div>
        </div>

        <div className="ml-auto flex flex-wrap items-end gap-3">
          {filtering ? (
            <button
              type="button"
              data-action="roster-reset"
              onClick={() =>
                setFilter({
                  query: "",
                  status: "all",
                  event: "all",
                  college: "all",
                  year: "all",
                  department: "all",
                  fromDate: "",
                  toDate: "",
                })
              }
              className="border border-line px-4 py-2 font-mono text-[11px] uppercase tracking-[0.2em] text-ash transition hover:border-violet-bright hover:text-bone"
            >
              Clear filters
            </button>
          ) : null}
          <button
            type="button"
            data-action="roster-export"
            disabled={exporting}
            onClick={exportRoster}
            className="border border-violet-bright/60 px-4 py-2 font-mono text-[11px] uppercase tracking-[0.2em] text-bone transition hover:border-violet-bright disabled:opacity-50"
          >
            {exporting ? "Preparing…" : "Export to Excel"}
          </button>
          {/* Add a registration taken at the desk. Offered to anyone who can READ
              the roster, because staff_create_registration is coordinator+ and a
              wider button would only ever answer "Not authorised". A coordinator
              reconciling a cash float is doing routine work, not escalating. */}
          <button
            type="button"
            data-action="roster-add"
            onClick={() => {
              setAdding((v) => !v);
              setEditingId(null);
            }}
            className="border border-lavender/50 px-4 py-2 font-mono text-[11px] uppercase tracking-[0.2em] text-crystal/80 transition hover:border-lavender"
          >
            {adding ? "Cancel" : "Add registration"}
          </button>
        </div>
      </div>

      {adding ? (
        <RegistrationEditor
          initial={emptyRegistration()}
          onSave={createOne}
          onCancel={() => setAdding(false)}
          saving={saving}
          submitLabel="Add registration"
        />
      ) : null}

      <p
        className="mt-3 font-mono text-[11px] uppercase tracking-[0.25em] text-ash"
        aria-live="polite"
        data-roster-summary="true"
        data-searching={searching ? "true" : "false"}
      >
        {searching
          ? "Searching…"
          : filtering
            ? `${win.total ?? rows.length} matching registration${win.total === 1 ? "" : "s"}`
            : "Newest first"}
      </p>

      {tooShort ? (
        <p className="mt-1 font-mono text-[11px] text-ash" data-search-hint="true">
          Type {MIN_TERM - trimmed.length} more character{MIN_TERM - trimmed.length === 1 ? "" : "s"} to
          search.
        </p>
      ) : null}

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

      {/* A search that matches nothing must SAY the term it searched for. "No
          registrations" reads as "the roster is empty", which sends an operator
          off to check whether everyone disappeared.

          This replaces the empty row that used to live INSIDE the list: it was an
          <li>, so a test counting `#admin-table-wrap > li` counted it as a
          participant, and it appeared below the list rather than where the
          operator is looking. */}
      {!busy && rows.length === 0 ? (
        <p
          className="mt-4 border border-line bg-void-raised px-4 py-4 text-sm text-ash"
          data-roster-empty="true"
        >
          {filtering
            ? `No registrations match these filters${
                trimmed && ready ? ` — including the search “${trimmed}”` : ""
              }.`
            : "No registrations yet."}
        </p>
      ) : null}

      {/* id="admin-table-wrap" is the anchor scripts/verify.mjs asserts on to
          prove the roster is absent for anyone without a staff session. */}
      <ul
        id="admin-table-wrap"
        className={`mt-5 space-y-3 transition-opacity ${searching ? "opacity-60" : ""}`}
        aria-busy={searching}
        data-searching={searching ? "true" : "false"}
      >
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
                {/* Cash and UPI are DIFFERENT records and were being displayed as
                    the same row: a cash registration has no UTR and no submission
                    time, so it printed "UTR: — · submitted —", which reads as a
                    UTR payment that went wrong rather than a cash one that is
                    perfectly normal. The method is now stated first, and the
                    reference line only appears when there IS a reference to show.
                    `awaiting_cash` against `verified` still distinguishes money
                    due from money taken, so nothing is lost by not repeating the
                    method on every cash row in prose. */}
                {r.payment_method === "cash" ? (
                  <p
                    className="mt-1 font-mono text-xs text-gold"
                    data-payment-method="cash"
                  >
                    CASH
                    {r.payment_status === "awaiting_cash"
                      ? " · money due at the desk"
                      : r.payment_status === "verified"
                        ? ` · cash received${r.payment_verified_by ? ` by ${r.payment_verified_by}` : ""}`
                        : ""}
                    {r.utr_number
                      ? " · WARNING: a cash row carries a reference"
                      : ""}
                  </p>
                ) : (
                  <p className="mt-1 font-mono text-xs text-ash" data-payment-method="utr">
                    UTR: {r.utr_number || "—"} · submitted {when(r.utr_submitted_at)}
                  </p>
                )}
                {/* Shown only when the row carries one. An event that asks for an
                    identifier is checked on it at the venue, and a reconciler needs
                    it on screen — not in a spreadsheet they have to open separately.

                    `event_id_value ?? free_fire_id` because migration ...037 added the
                    generic column and backfilled it, but rows written between the
                    two migrations — and any row an older client creates — still
                    only have the FREE FIRE one. Reading the new column alone would
                    blank the ID on exactly the rows an operator most needs it on,
                    which is the failure mode of a migration that looks complete. */}
                {r.event_id_value || r.free_fire_id ? (
                  <p
                    className="mt-1 font-mono text-xs text-gold"
                    data-event-id="true"
                  >
                    Event ID: {r.event_id_value || r.free_fire_id}
                  </p>
                ) : null}
                <p className="mt-1 font-mono text-xs text-ash">
                  Registered {when(r.created_at)}
                  {r.user_id ? "" : " · no owner linked yet"}
                </p>
                {r.payment_verified_by ? (
                  <p className="mt-1 font-mono text-xs text-jade">
                    Verified by {r.payment_verified_by} on {when(r.payment_verified_at)}
                  </p>
                ) : null}
                {/* A frozen selection is the one fact on this card that changes
                    what the operator may do next, so it is stated in words rather
                    than left to the button. "Final" is the word that matters: it
                    tells whoever is reading that the participant cannot change
                    this and that only a master can. */}
                {r.selection_frozen ? (
                  <p
                    className="mt-1 font-mono text-xs text-gold"
                    data-selection-frozen="true"
                  >
                    Event selection FINAL
                    {r.selection_frozen_by ? ` · frozen by ${r.selection_frozen_by}` : ""}
                    {r.selection_frozen_at ? ` on ${when(r.selection_frozen_at)}` : ""}
                  </p>
                ) : null}
              </div>
              <StatusPill status={r.payment_status} />
            </div>

            {!readOnly ? (
              <div className="mt-4 flex flex-wrap gap-2">
                {/* EDIT. Sits with Confirm and Reject rather than behind a
                    separate screen, because correcting a mistyped roll number is
                    the same act as confirming a payment — it happens while
                    looking at this row, with this row's context on screen. */}
                <ActionButton
                  label={editingId === r.id ? "Editing…" : "Edit"}
                  disabled={busyId === r.id || saving}
                  onClick={() => {
                    setEditingId((cur) => (cur === r.id ? null : r.id));
                    setAdding(false);
                  }}
                />
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
                {/* Freezing is offered to anyone who can verify — it is the
                    routine, protective action. Re-opening is offered ONLY to a
                    master, matching the server, so an admin is never invited to
                    click a button whose answer is always no. An admin looking at
                    a frozen row sees the FINAL note and no way to undo it, which
                    is exactly the path the product asks for: the request goes to
                    a master. */}
                {!r.selection_frozen ? (
                  <ActionButton
                    label="Freeze selection"
                    disabled={busyId === r.id}
                    onClick={() => toggleFreeze(r)}
                  />
                ) : role === "master" ? (
                  <ActionButton
                    label="Re-open selection"
                    disabled={busyId === r.id}
                    onClick={() => toggleFreeze(r)}
                  />
                ) : null}
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

            {/* The editor opens INSIDE the row rather than in a dialog, so the
                operator keeps the row's status, amount and audit state on screen
                while they correct it. Gated on the same readOnly as the other
                actions, because staff_update_registration is admin+. */}
            {editingId === r.id && !readOnly ? (
              <RegistrationEditor
                initial={r}
                onSave={(pairs) => saveEdit(r.id, pairs)}
                onCancel={() => setEditingId(null)}
                saving={saving}
                submitLabel="Save changes"
              />
            ) : null}
          </li>
        ))}
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
        <div className="mt-2">
          <Select
            id="audit-filter"
            value={paging.action}
            onChange={(value) => setFilter({ action: value })}
            options={[
              { value: "all", label: "Everything" },
              ...Object.entries(ACTION_LABELS).map(([value, label]) => ({ value, label })),
            ]}
            className="w-[14rem]"
          />
        </div>
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

  /* Accepts BOTH shapes of value, because this form mixes two kinds of control.

     <input onChange> hands back a DOM event and <Select> hands back the option's
     VALUE. This setter serves both, and it used to read `e.target.value`
     unconditionally - which meant the Role dropdown could only be wired by
     FAKING an event around its value:
         onChange={(value) => set("role")({ target: { value } })}
     That worked and hid the trap rather than closing it: the next person to add
     a <Select onChange={set(...)}> here would pass a bare string and get
     `Cannot read properties of undefined`, and with no error boundary on this
     route React would unmount the whole console to a blank page.

     The identical crash is what the PROFILE page suffered on its college and
     department dropdowns; it is fixed there the same way. Same shape in both
     files, deliberately - one convention, not two. */
  const set = (key) => (value) =>
    setForm((f) => ({ ...f, [key]: value?.target ? value.target.value : value }));

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
            <Select
              id="staff-new-role"
              name="role"
              value={form.role}
              onChange={(value) => set("role")(value)}
              options={ROLE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
              className={inputClass}
            />
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
                <Select
                  id={`staff-role-${u.username}`}
                  ariaLabel={`Role for ${u.username}`}
                  value={u.role}
                  onChange={(value) =>
                    runChange(
                      () => staffUpdate({ userId: u.id, role: value, token: session.token }),
                      `${u.username} is now ${value}.`
                    )
                  }
                  options={ROLE_OPTIONS.map((o) => ({ value: o.value, label: o.value }))}
                  className="w-[7.5rem] px-2 py-1 text-[11px]"
                />
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
 * The LIST is the catalogue, so it contains every event and bundle that exists —
 * including the ones with no price yet, which are precisely the ones an operator
 * needs to see. Saving calls staff_set_price, which checks the catalogue and
 * derives the entry type server-side, and a database trigger records the change
 * in the audit log with the operator's identity — so "who raised this price and
 * when" has an answer.
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

  /* The list comes from the CATALOGUE, not from src/data.
     This tab used to build its rows from the compiled-in `bundles` and `events`
     arrays, which meant an event created in the Catalogue tab had no row to edit
     here at all, and a price left behind by a deleted event was invisible. The
     database is the only list that can be right, and public_catalogue already
     returns the price joined onto the same object. */
  const [catalogue, setCatalogue] = useState({ events: [], bundles: [] });
  const [catalogueError, setCatalogueError] = useState(null);

  const loadCatalogueList = useCallback(async () => {
    const result = await loadPublicCatalogue();
    if (result.ok) {
      setCatalogue({ events: result.events ?? [], bundles: result.bundles ?? [] });
      setCatalogueError(null);
    } else {
      setCatalogueError(result.error);
    }
  }, []);

  useEffect(() => {
    loadCatalogueList();
  }, [loadCatalogueList]);

  /* Every catalogue item gets a row, INCLUDING the ones with no price yet. An
     unpriced event is a thing an operator has to be able to fix, and a list that
     only shows what is already priced can never show them. */
  const entries = useMemo(
    () => [
      ...catalogue.bundles.map((b) => ({
        kind: "bundle",
        ref_id: b.id,
        label: `${b.number} · ${b.name}`,
        price: b.price ?? null,
        note: "",
      })),
      ...catalogue.events.map((e) => ({
        kind: "event",
        ref_id: e.id,
        label: `${e.number} · ${e.title}`,
        price: e.price ?? null,
        // The note has to say WHAT the number covers. "300" on a per-person event
        // and "300" on a squad event are five times apart in real money, and the
        // operator editing one without the other needs to see which they are on.
        note:
          e.payment_mode === "per_team"
            ? `one squad leader pays this, for up to ${e.max_team_members ?? "?"} players`
            : "each person pays this",
      })),
    ],
    [catalogue]
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
      // required because loadPricing() is otherwise a no-op once loaded. The
      // catalogue is re-read too, because THAT is where the list now comes from.
      await loadPricing({ force: true });
      await loadCatalogueList();
      setDrafts((d) => {
        const next = { ...d };
        delete next[key];
        return next;
      });
      setNotice({ kind: "ok", text: `${entry.label} is now ₹${price}. Change recorded in the audit log.` });
      reload();
    } else {
      // The RPC's own sentence — "There is no event X in the catalogue, so it
      // cannot be priced" is far more use to an operator than a generic failure.
      setNotice({ kind: "error", text: result.body?.error ?? "That price could not be saved." });
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
        These are the live prices the public site renders, and the list is the catalogue itself —
        every event and bundle that exists, so an item created in the Catalogue tab is priceable here
        straight away and a price can never outlive the thing it was for. Editing one takes effect on
        the next page load, with no rebuild and no redeploy.
      </p>

      {notice ? <div className="mt-4"><Banner kind={notice.kind}>{notice.text}</Banner></div> : null}

      {win.error ? <div className="mt-4"><Banner>Could not load prices. Try refreshing.</Banner></div> : null}

      {catalogueError ? (
        <div className="mt-4">
          <Banner>Could not load the catalogue, so there is nothing to price. {catalogueError}</Banner>
        </div>
      ) : null}

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
            {entries
              .filter((c) => c.kind === section.kind)
              .map((entry) => {
                const key = `${entry.kind}:${entry.ref_id}`;
                const live = liveFor(entry.kind, entry.ref_id);
                const current = live ? live.price : entry.price;
                // `?? ""` rather than String(current): an unpriced item must render
                // an EMPTY box, because String(null) is the text "null" and that
                // would look like a price of nothing.
                const shown = drafts[key] ?? (current == null ? "" : String(current));
                return (
                  <li key={key} className="flex flex-wrap items-center gap-3 border border-line bg-void-raised px-4 py-3">
                    <div className="min-w-[12rem] flex-1">
                      <p className="font-mono text-sm text-bone">{entry.label}</p>
                      <p className="mt-0.5 font-mono text-[11px] text-ash">
                        {entry.ref_id}
                        {current == null
                          ? " · NO PRICE SET YET"
                          : live
                            ? " · from database"
                            : " · not set in the database yet"}
                        {entry.note ? ` · ${entry.note}` : ""}
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
                      value={shown}
                      onChange={(e) => setDrafts((d) => ({ ...d, [key]: e.target.value }))}
                      className="w-28 border border-line bg-void px-3 py-2 font-mono text-sm text-bone outline-none focus:border-violet-bright"
                    />
                    <ActionButton
                      label="Save"
                      disabled={
                        busy === key ||
                        !Number.isInteger(Number(shown)) ||
                        Number(shown) < 0 ||
                        Number(shown) === current
                      }
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
          <>
            {/* The two money figures, above the list. "How much have we
                received" and "how much are we waiting to check" were only
                answerable by downloading the roster and totalling a column by
                hand, and answering them with one combined number is how a
                payment gets written off as collected before anyone has seen the
                bank statement. */}
            <FinanceStrip token={session.token} />
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
          </>
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
        {/* The catalogue loads and saves itself (public_catalogue is one unpaged
            JSON document, not a PostgREST list), so it takes no window, no pager
            and no reload wiring from this shell. */}
        {active?.id === "catalogue" ? <CatalogueManager session={session} /> : null}
        {/* Same shape of ownership as the catalogue: the contacts tab loads and
            saves itself, so it takes no window, pager or reload wiring. */}
        {active?.id === "contacts" ? <ContactManager session={session} /> : null}

        {/* Same shape of ownership as the catalogue and contacts: the tab loads
            and saves itself, so it takes no window, pager or reload wiring. */}
        {active?.id === "destinations" ? <DestinationManager session={session} /> : null}

      {active?.id === "lookups" ? <LookupManager session={session} /> : null}
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

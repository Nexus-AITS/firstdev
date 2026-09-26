import { useMemo, useState } from "react";
import Page from "../components/ui/Page.jsx";
import Reveal from "../components/ui/Reveal.jsx";
import CinematicButton from "../components/ui/CinematicButton.jsx";
import RealmFX from "../components/fx/RealmFX.jsx";
import {
  listRegistrations,
  getStats,
  confirmPayment,
  rejectPayment,
  removeRegistration,
} from "../data/registrations.js";

/**
 * ADMIN CONSOLE — /admin123456789
 *
 * Participant roster + payment verification desk:
 *  • dashboard totals (participants, distinct colleges, payment states)
 *  • every participant's details incl. user id, UTR and status
 *  • sortable roster beside search (newest / name / college / status)
 *  • row actions: CONFIRM (UTR → verified), REJECT, REMOVE
 *
 * Deliberately NOT linked from Navbar/Footer. Authentication is a planned
 * follow-up pass — until then the store is the local Supabase mirror
 * (src/data/registrations.js).
 */

const STATUS_META = {
  verified: { label: "Verified", cls: "border-gold/45 text-gold bg-gold/5" },
  unverified: {
    label: "Unverified",
    cls: "border-lavender/50 text-lavender bg-violet-core/15",
  },
  awaiting_utr: {
    label: "Awaiting UTR",
    cls: "border-white/15 text-crystal/55 bg-white/[0.03]",
  },
  rejected: {
    label: "Rejected",
    cls: "border-rose-400/35 text-rose-300/85 bg-rose-500/5",
  },
};

const FILTERS = [
  { id: "all", label: "All" },
  { id: "unverified", label: "To review" },
  { id: "verified", label: "Verified" },
  { id: "awaiting_utr", label: "Awaiting UTR" },
  { id: "rejected", label: "Rejected" },
];

/** Sort options — the select beside the search bar. */
const SORTS = [
  { id: "newest", label: "Newest first" },
  { id: "oldest", label: "Oldest first" },
  { id: "name", label: "Name A–Z" },
  { id: "name-desc", label: "Name Z–A" },
  { id: "college", label: "College A–Z" },
  { id: "status", label: "Status — action first" },
];

/** Priority for the "Status" sort: rows needing admin action come first. */
const STATUS_ORDER = ["unverified", "rejected", "awaiting_utr", "verified"];

const shortDate = (iso) =>
  iso
    ? new Date(iso).toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "short",
        year: "2-digit",
      })
    : "—";

export default function Admin() {
  const [rows, setRows] = useState(() => listRegistrations());
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [sort, setSort] = useState("newest");
  const [pendingRemove, setPendingRemove] = useState(null);

  const stats = useMemo(() => getStats(rows), [rows]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = rows.filter((r) => {
      if (filter !== "all" && r.payment_status !== filter) return false;
      if (!q) return true;
      return [r.name, r.roll_number, r.college_name, r.email, r.utr_number, r.id, r.purchase_label, r.purchase_type]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q));
    });

    // Apply the active sort (filter + search stay untouched).
    const byName = (a, b) =>
      String(a.name ?? "").localeCompare(String(b.name ?? ""));
    const byCreated = (a, b) =>
      (a.created_at ? Date.parse(a.created_at) || 0 : 0) -
      (b.created_at ? Date.parse(b.created_at) || 0 : 0);
    const sorted = [...matched];
    switch (sort) {
      case "oldest":
        sorted.sort((a, b) => byCreated(a, b) || byName(a, b));
        break;
      case "name":
        sorted.sort(byName);
        break;
      case "name-desc":
        sorted.sort((a, b) => byName(b, a));
        break;
      case "college":
        sorted.sort(
          (a, b) =>
            String(a.college_name ?? "").localeCompare(
              String(b.college_name ?? "")
            ) || byName(a, b)
        );
        break;
      case "status":
        sorted.sort(
          (a, b) =>
            STATUS_ORDER.indexOf(a.payment_status) -
              STATUS_ORDER.indexOf(b.payment_status) || byName(a, b)
        );
        break;
      default: // newest — registration date descending
        sorted.sort((a, b) => byCreated(b, a) || byName(a, b));
    }
    return sorted;
  }, [rows, query, filter, sort]);

  const onRemove = (id) => {
    if (pendingRemove === id) {
      setRows(removeRegistration(id));
      setPendingRemove(null);
    } else {
      setPendingRemove(id);
    }
  };

  const statCards = [
    { id: "stat-participants", label: "Participants", value: stats.total, tone: "text-crystal" },
    { id: "stat-colleges", label: "Colleges", value: stats.colleges, tone: "text-crystal" },
    { id: "stat-events", label: "Event entries", value: stats.events, tone: "text-lavender" },
    { id: "stat-bundles", label: "Bundle entries", value: stats.bundles, tone: "text-gold" },
    { id: "stat-verified", label: "Payment verified", value: stats.verified, tone: "text-gold" },
    { id: "stat-review", label: "To review (UTR)", value: stats.unverified, tone: "text-lavender" },
    { id: "stat-awaiting", label: "Awaiting UTR", value: stats.awaiting, tone: "text-crystal/70" },
    { id: "stat-rejected", label: "Rejected", value: stats.rejected, tone: "text-rose-300/80" },
  ];

  return (
    <Page>
      <div className="relative min-h-svh overflow-hidden bg-void">
        <RealmFX mode="stars" tint="#a855f7" />
        {/* hero */}
        <section className="relative z-10 mx-auto max-w-[1680px] px-5 pt-32 text-center md:px-10 md:pt-40">
          <Reveal>
            <p className="text-[10px] font-medium uppercase tracking-[0.55em] text-lavender/70">
              Nexus // Operations console
            </p>
          </Reveal>

          <h1 className="mt-5 font-display text-[clamp(2.4rem,7vw,5.5rem)] font-medium leading-[1.04] tracking-[0.1em] text-crystal">
            <Reveal y={44}>
              <span className="block text-glow-soft">ADMIN CONSOLE</span>
            </Reveal>
          </h1>

          <Reveal delay={0.3}>
            <div className="hairline mx-auto mt-8 w-56" aria-hidden />
          </Reveal>

          <Reveal delay={0.4}>
            <p
              id="admin-auth-note"
              className="mx-auto mt-8 max-w-3xl border border-gold/30 bg-gold/[0.04] px-5 py-4 text-left text-[11px] leading-relaxed tracking-wide text-gold/85"
            >
              <span className="font-medium uppercase tracking-[0.3em]">Auth: not enabled</span> —
              this console is open to anyone with the link. A future pass will gate /admin123456789 behind
              an admin login; until then treat the URL as private. Data comes from the local staged
              store that mirrors the Supabase schema (src/data/registrations.js).
            </p>
          </Reveal>
        </section>

        {/* dashboard totals */}
        <section
          className="relative z-10 mx-auto mt-12 max-w-[1680px] px-5 md:mt-16 md:px-10"
          aria-label="Dashboard totals"
        >
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            {statCards.map((card, i) => (
              <Reveal key={card.id} delay={0.05 * i}>
                <div className="glass-panel h-full p-4 md:p-5">
                  <p className="text-[9px] font-medium uppercase tracking-[0.32em] text-lavender/60">
                    {card.label}
                  </p>
                  <p
                    id={card.id}
                    className={`mt-3 font-display text-4xl md:text-5xl ${card.tone}`}
                  >
                    {card.value}
                  </p>
                </div>
              </Reveal>
            ))}
          </div>
        </section>
        {/* roster controls + table */}
        <section
          className="relative z-10 mx-auto mt-10 max-w-[1680px] px-5 pb-36 md:px-10"
          aria-label="Participants"
        >
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div className="flex w-full flex-col gap-3 sm:flex-row sm:items-center">
              <div className="w-full sm:flex-1 md:max-w-sm">
                <label htmlFor="admin-search" className="sr-only">
                  Search participants
                </label>
                <input
                  id="admin-search"
                  type="search"
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setPendingRemove(null);
                  }}
                  placeholder="Search name, roll, college, email, UTR…"
                  className="w-full border border-white/15 bg-white/[0.03] px-4 py-3 text-xs tracking-wide text-crystal placeholder:text-crystal/35 focus:border-lavender/60 focus:outline-none"
                />
              </div>
              <label htmlFor="admin-sort" className="group relative block shrink-0">
                <span className="sr-only">Sort participants by</span>
                <select
                  id="admin-sort"
                  value={sort}
                  onChange={(e) => setSort(e.target.value)}
                  className="w-full cursor-pointer appearance-none border border-white/15 bg-white/[0.03] px-4 py-3 pr-9 text-[10px] font-medium uppercase tracking-[0.28em] text-crystal/70 transition-colors duration-300 hover:border-lavender/50 hover:text-crystal focus:border-lavender/60 focus:outline-none sm:w-auto"
                >
                  {SORTS.map((s) => (
                    <option key={s.id} value={s.id} className="bg-void text-crystal">
                      {s.label}
                    </option>
                  ))}
                </select>
                <svg
                  aria-hidden="true"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="pointer-events-none absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-crystal/40 transition-colors group-hover:text-lavender/70"
                >
                  <path d="m6 9 6 6 6-6" />
                </svg>
              </label>
            </div>

            <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by payment status">
              {FILTERS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  aria-pressed={filter === f.id}
                  onClick={() => {
                    setFilter(f.id);
                    setPendingRemove(null);
                  }}
                  className={`border px-3 py-2 text-[9px] font-medium uppercase tracking-[0.28em] transition-colors duration-300 ${
                    filter === f.id
                      ? "border-lavender/80 bg-violet-core/25 text-crystal"
                      : "border-white/15 text-crystal/55 hover:border-lavender/50 hover:text-crystal"
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          <p className="sr-only" role="status">
            {visible.length} of {rows.length} participants shown
          </p>
          <div id="admin-table-wrap" className="mt-6 overflow-x-auto border border-white/10">
            <table
              className="w-full min-w-[1300px] border-collapse text-left"
              aria-label="All participants"
            >
              <thead>
                <tr className="border-b border-white/10 bg-white/[0.03] text-[9px] uppercase tracking-[0.28em] text-lavender/70">
                  <th scope="col" className="px-4 py-3 font-medium">User ID</th>
                  <th scope="col" className="px-4 py-3 font-medium">Participant</th>
                  <th scope="col" className="px-4 py-3 font-medium">Purchase</th>
                  <th scope="col" className="px-4 py-3 font-medium">College</th>
                  <th scope="col" className="px-4 py-3 font-medium">Year · Dept</th>
                  <th scope="col" className="px-4 py-3 font-medium">UTR</th>
                  <th scope="col" className="px-4 py-3 font-medium">Submitted</th>
                  <th scope="col" className="px-4 py-3 font-medium">Payment</th>
                  <th scope="col" className="px-4 py-3 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => {
                  const meta = STATUS_META[r.payment_status] || STATUS_META.awaiting_utr;
                  const removing = pendingRemove === r.id;
                  return (
                    <tr
                      key={r.id}
                      className="border-b border-white/[0.06] align-top transition-colors duration-300 hover:bg-violet-core/[0.07]"
                    >
                      <td className="break-all px-4 py-4 font-mono text-[10px] leading-relaxed text-crystal/40">
                        {r.id}
                      </td>
                      <td className="px-4 py-4">
                        <p className="text-sm text-crystal">{r.name}</p>
                        <p className="mt-1 text-[11px] text-crystal/45">{r.email}</p>
                        <p className="text-[11px] text-crystal/45">{r.phone_number}</p>
                        <p className="mt-1 text-[10px] uppercase tracking-[0.2em] text-lavender/50">
                          {r.roll_number}
                        </p>
                      </td>
                      <td className="px-4 py-4">
                        <span
                          className={`inline-block border px-2.5 py-1 text-[9px] font-medium uppercase tracking-[0.22em] ${
                            r.purchase_type === "event"
                              ? "border-lavender/50 text-lavender bg-violet-core/15"
                              : r.purchase_type === "bundle"
                                ? "border-gold/45 text-gold bg-gold/5"
                                : "border-white/15 text-crystal/45 bg-white/[0.03]"
                          }`}
                        >
                          {r.purchase_type === "event"
                            ? "Event"
                            : r.purchase_type === "bundle"
                              ? "Bundle"
                              : "—"}
                        </span>
                        {r.purchase_label ? (
                          <p className="mt-1.5 text-[11px] leading-snug text-crystal/60">
                            {r.purchase_label}
                          </p>
                        ) : null}
                      </td>
                      <td className="px-4 py-4 text-xs text-crystal/70">{r.college_name}</td>
                      <td className="px-4 py-4 text-xs text-crystal/70">
                        {r.year} · {r.department}
                      </td>
                      <td className="px-4 py-4 font-mono text-[11px] text-crystal/75">
                        {r.utr_number || "—"}
                      </td>
                      <td className="px-4 py-4 text-[11px] text-crystal/55">
                        {shortDate(r.utr_submitted_at)}
                      </td>
                      <td className="px-4 py-4">
                        <span
                          className={`inline-block border px-2.5 py-1 text-[9px] font-medium uppercase tracking-[0.22em] ${meta.cls}`}
                        >
                          {meta.label}
                        </span>
                        {r.payment_status === "verified" ? (
                          <p className="mt-1.5 text-[10px] leading-snug text-crystal/40">
                            {shortDate(r.payment_verified_at)} · {r.payment_verified_by}
                          </p>
                        ) : null}
                      </td>
                      <td className="px-4 py-4">
                        <div className="flex flex-col items-start gap-2">
                          {r.payment_status === "unverified" ? (
                            <>
                              <button
                                type="button"
                                data-action="confirm"
                                onClick={() => setRows(confirmPayment(r.id))}
                                className="border border-gold/45 px-3 py-1.5 text-[9px] font-medium uppercase tracking-[0.22em] text-gold transition-colors duration-300 hover:bg-gold/10"
                              >
                                Confirm
                              </button>
                              <button
                                type="button"
                                data-action="reject"
                                onClick={() => setRows(rejectPayment(r.id))}
                                className="border border-white/15 px-3 py-1.5 text-[9px] font-medium uppercase tracking-[0.22em] text-crystal/55 transition-colors duration-300 hover:border-lavender/60 hover:text-crystal"
                              >
                                Reject
                              </button>
                            </>
                          ) : null}
                          <button
                            type="button"
                            data-action={removing ? "remove-confirm" : "remove"}
                            onClick={() => onRemove(r.id)}
                            className={`border px-3 py-1.5 text-[9px] font-medium uppercase tracking-[0.22em] transition-colors duration-300 ${
                              removing
                                ? "border-rose-400/70 bg-rose-500/15 text-rose-200"
                                : "border-rose-400/25 text-rose-300/70 hover:border-rose-400/60 hover:text-rose-200"
                            }`}
                          >
                            {removing ? "Confirm remove" : "Remove"}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {visible.length === 0 ? (
            <div className="mt-10 border border-dashed border-white/15 px-6 py-14 text-center">
              <p className="font-display text-2xl tracking-wide text-crystal/70">
                No participants match
              </p>
              <p className="mt-2 text-xs text-crystal/45">
                Clear the search or switch the status filter.
              </p>
            </div>
          ) : null}

          <div className="mt-14 flex flex-col items-center gap-6 text-center">
            <p className="max-w-2xl text-[10px] uppercase leading-relaxed tracking-[0.28em] text-crystal/40">
              Confirm stamps payment_verified_at + admin identity · Remove deletes the registration
              · Auth gate arrives in a future pass
            </p>
            <CinematicButton to="/" arrow="left">
              Return to the nexus
            </CinematicButton>
          </div>
        </section>
      </div>
    </Page>
  );
}

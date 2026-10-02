/**
 * Catalogue management — events and bundles, master only.
 *
 * This tab is an EDITOR over the database, not a view of the compiled-in
 * src/data files. The JS arrays are the seed and the offline fallback; once the
 * database answers it is the authority, and a master editing here changes what
 * the public site shows without a redeploy. So nothing on this screen is a
 * hardcoded list: the rows come from public_catalogue and every write goes
 * through a staff RPC.
 *
 * Errors are surfaced from the server verbatim, with one exception. The bundle
 * and event RPCs return human sentences on purpose ("No active event called
 * X", "Choose a realm: technical, non-technical or esports"), and those are
 * exactly what the operator needs to read. A raw constraint name or a Postgres
 * code is not, and the wrapper functions already translate the common cases.
 */
import { useCallback, useEffect, useState } from "react";
import { ENTRY_TYPES } from "../../data/events.js";
import DateField from "../ui/DateField.jsx";
import {
  loadPublicCatalogue,
  can as roleCan,
  staffDeleteBundle,
  staffDeleteEvent,
  staffListCatalogue,
  staffRetireBundle,
  staffRetireEvent,
  staffUpsertBundle,
  staffUpsertEvent,
} from "../../data/staff.js";

const REALMS = [
  { id: "forge", label: "Technical" },
  { id: "paradox", label: "Non-technical" },
  { id: "arena", label: "Esports" },
];

const inputClass =
  "w-full border border-line bg-void-raised px-3 py-2 font-mono text-sm text-bone outline-none transition focus:border-violet-bright";
const labelClass = "block font-mono text-[11px] uppercase tracking-[0.3em] text-ash";
const buttonClass =
  "border border-violet-bright/60 px-4 py-2 font-mono text-[11px] uppercase tracking-[0.2em] text-bone transition hover:border-violet-bright disabled:opacity-50";

const emptyEvent = {
  id: "",
  number: "",
  title: "",
  realm: "forge",
  category: "",
  tagline: "",
  event_date: "",
  venue: "",
  team_size: "",
  entry_type: "individual",
  max_team_members: "",
  // Blank means "no limit", which is the state every event starts in. Sending
  // null (not "") is what the RPC reads as unlimited.
  max_registrations: "",
  // Whether a leader must list their teammates here. TRUE for every event
  // unless an operator says otherwise - FREE FIRE is the one exception, because
  // its squad forms in game (migration ...035). Distinct from
  // `team_formed_offsite`, which decides who PAYS.
  roster_collected_on_site: true,
  // Same rule for the deadline: blank is OPEN, not "closed today". The column is
  // a calendar day (migration ...034), so the form carries a plain YYYY-MM-DD
  // and the database compares it in Asia/Kolkata - never as an instant.
  registration_closes_on: "",
  price: "",
  // Not a payment_mode any more. The fact is "is this team formed elsewhere",
  // and the database derives who pays from it (migration ...028). False means
  // the leader pays once and lists their teammates here.
  team_formed_offsite: false,
  team_form_url: "",
  status: "REGISTRATION OPEN",
  is_active: true,
};

/** Coerce a catalogue row into the form's shape. */
function toEventForm(row) {
  return {
    id: row.id,
    number: row.number ?? "",
    title: row.title ?? "",
    realm: row.realm ?? "forge",
    category: row.category ?? "",
    tagline: row.tagline ?? "",
    event_date: row.event_date ?? "",
    venue: row.venue ?? "",
    team_size: row.team_size ?? "",
    // Anything that is not exactly "team" reads as individual, which is what the
    // database CHECK guarantees anyway. Normalising on read means the select can
    // never be handed a value it has no option for.
    entry_type: row.entry_type === "team" ? "team" : "individual",
    max_team_members: row.max_team_members ?? "",
    max_registrations: row.max_registrations ?? "",
    // `?? true` rather than a bare read: a row written before migration ...035
    // carries no value for this column, and an undefined here would render the
    // checkbox as unticked — silently switching OFF the data collection the
    // event has always done. The database default is true; this matches it.
    roster_collected_on_site: row.roster_collected_on_site !== false,
    // The database stores a `date`, which PostgREST serialises as a bare
    // YYYY-MM-DD - the exact shape DateField parses. The `?? ""` is for a row
    // that predates migration ...034 and has no deadline at all.
    registration_closes_on: row.registration_closes_on ?? "",
    // `payment_mode` is deliberately NOT read back into the form: it is derived
    // in the database now, and an editor that displayed it would be showing an
    // operator a value they can no longer change.
    team_formed_offsite: row.team_formed_offsite === true,
    team_form_url: row.team_form_url ?? "",
    // The price lives in public.pricing, not on the event row, so it arrives on
    // the catalogue object as `price` (public_catalogue joins it on). Blank when
    // the database has no price for this event, which is a gap to fix rather than
    // a zero to show.
    price: row.price ?? "",
    status: row.status ?? "REGISTRATION OPEN",
    is_active: row.is_active !== false,
  };
}

/**
 * How an event's entry rule reads in the list.
 *
 * The same words formatEntryType() puts on the public card, so an operator
 * checking the cap here and a participant reading the event page are looking at
 * one sentence rather than two that can drift.
 */
function entryLabel(row) {
  const type =
    row.entry_type !== "team"
      ? "INDIVIDUAL"
      : `TEAM · MAX ${row.max_team_members ?? "?"}`;
  // A squad's registration limit counts SQUADS and its fee covers a whole squad,
  // so the list has to say which it is showing or the number is unreadable.
  const perTeam = row.payment_mode === "per_team";
  const seats =
    row.max_registrations == null
      ? "no limit"
      : `${row.registered_count ?? 0}/${row.max_registrations}${perTeam ? " squads" : ""}`;
  const who = perTeam ? "squad pays" : "per person";
  // Whether this site lists the squad. A per_team event that does NOT is the
  // FREE FIRE case: one leader pays, nobody's details are taken. Printing it
  // stops an operator reading "12/20 squads" and assuming they can see the four
  // names behind each one.
  const roster =
    row.entry_type === "team" && perTeam && row.roster_collected_on_site === false
      ? " · no roster"
      : "";
  // The last day is printed beside the cap because the two are the same
  // sentence: "12/20 squads, closes 5 Oct" tells an operator whether the number
  // is a running total or a closed book. A deadline in the PAST says so
  // explicitly rather than reading as a date that has not arrived.
  const closes = closeLabel(row.registration_closes_on);
  return `${type} · ${who} · ${seats}${roster}${closes ? ` · ${closes}` : ""} · ${
    row.price == null ? "NO PRICE" : `₹${row.price}`
  }`;
}

/**
 * "CLOSES 5 OCT 2026" / "CLOSED 5 OCT 2026" / "" for no deadline.
 *
 * Built from the three numbers in the value rather than `new Date(...)`, for the
 * reason DateField.jsx gives at length: "2026-10-05" parsed as a Date is midnight
 * UTC, and formatting that back in IST prints the 4th. A one-day error on a
 * deadline is exactly the kind that loses somebody a registration.
 */
function closeLabel(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? "").trim());
  if (!m) return "";
  const months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN",
                  "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  // Group 2 is the MONTH and group 3 the DAY. Reading them the other way round
  // renders "5 OCT" as "31 OCT" and, worse, indexes the month array with 31 -
  // which yields undefined and silently drops the deadline from the list.
  const month = months[Number(m[2]) - 1];
  if (!month) return "";
  const text = `${Number(m[3])} ${month} ${m[1]}`;

  // Today in Asia/Kolkata, same arithmetic as DateField's todayIso(): local time
  // plus this machine's offset plus IST's own 330 minutes.
  const now = new Date();
  const ist = new Date(now.getTime() + (now.getTimezoneOffset() + 330) * 60000);
  const today = `${ist.getFullYear()}${String(ist.getMonth() + 1).padStart(2, "0")}${String(
    ist.getDate()
  ).padStart(2, "0")}`;
  // Comparing YYYYMMDD strings is calendar arithmetic on the three numbers, which
  // is the whole point - no Date is ever parsed from the value.
  const past = `${m[1]}${m[2]}${m[3]}` < today;
  return past ? `CLOSED ${text}` : `CLOSES ${text}`;
}

function toBundleForm(row) {
  return {
    id: row.id,
    number: row.number ?? "",
    name: row.name ?? "",
    group_id: row.group_id ?? "nexus-forge",
    is_active: row.is_active !== false,
    includes: (row.includes ?? []).map((line) =>
      line.event
        ? { kind: "event", event: line.event }
        : {
            kind: "pool",
            pick: line.pick,
            count: line.count ?? 1,
            excludeHackathon: !!line.excludeHackathon,
          }
    ),
  };
}

/* ------------------------------------------------------------------ */
/* events                                                              */
/* ------------------------------------------------------------------ */

function EventEditor({ events, token, onSaved, onError, onDeleted, canDelete }) {
  const [form, setForm] = useState(emptyEvent);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) =>
    setForm((f) => ({ ...f, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));

  // Flipping to Individual clears the cap rather than leaving a number behind a
  // field that is no longer on screen — it would otherwise go back to the server
  // as a value the operator cannot see and did not intend. It also clears the
  // off-site flag, because a team formed on another website is meaningless for
  // an event nobody enters as a team, and a stale true would make a solo event
  // look like it charges per person for no reason the operator can see.
  const setEntryType = (e) =>
    setForm((f) => ({
      ...f,
      entry_type: e.target.value,
      max_team_members: e.target.value === "team" ? f.max_team_members : "",
      team_formed_offsite:
        e.target.value === "team" ? f.team_formed_offsite : false,
      // Same reasoning for the roster flag: a solo event collects no roster, so
      // carrying a `false` behind a field that is no longer on screen would send
      // back a value the operator cannot see and did not intend. Forced TRUE,
      // which is what the RPC would do anyway.
      roster_collected_on_site:
        e.target.value === "team" ? f.roster_collected_on_site : true,
    }));

  function edit(row) {
    setForm(toEventForm(row));
  }

  async function save() {
    if (busy) return;
    setBusy(true);
    onError(null);
    // Only the fields this form exposes are sent. The RPC coalesces the rest to
    // sensible defaults, and sending them as blanks would wipe copy the operator
    // cannot see from this screen (the `about` paragraphs, the sigil, the link
    // key) — a save that silently deletes a paragraph is worse than a no-op.
    const result = await staffUpsertEvent(
      {
        id: form.id.trim(),
        number: form.number.trim(),
        title: form.title.trim(),
        realm: form.realm,
        category: form.category.trim(),
        tagline: form.tagline,
        event_date: form.event_date.trim(),
        venue: form.venue.trim(),
        team_size: form.team_size.trim(),
        entry_type: form.entry_type,
        // A number or null, never "". A solo event sends null so the RPC's
        // "no cap given" branch is what runs, which is also what keeps the
        // database's CHECK true whatever a client does.
        max_team_members:
          form.entry_type === "team" && form.max_team_members !== ""
            ? Number(form.max_team_members)
            : null,
        // null is "no limit" and is checked as a cap, not as a number. Zero is a
        // number, and the RPC refuses it — a capped-at-zero event is not the same
        // thing as an uncapped one and must not look like it in the form.
        max_registrations:
          form.max_registrations === "" ? null : Number(form.max_registrations),
        // "" is "no deadline", which the RPC reads as null. Sent as a plain
        // YYYY-MM-DD string, never an ISO instant: the column is a date and the
        // comparison happens in Asia/Kolkata on the server.
        registration_closes_on: form.registration_closes_on || null,
        // A blank amount leaves the existing price alone rather than clearing it.
        // Clearing a price is done in the Pricing tab, where "no price" is
        // something an operator can see and choose.
        price: form.price === "" ? null : Number(form.price),
        // The FACT, not the derived mode. The RPC recomputes payment_mode from
        // this and entry_type, so an old console tab still posting a
        // payment_mode cannot put a team event back on per-person payment.
        team_formed_offsite:
          form.entry_type === "team" ? !!form.team_formed_offsite : false,
        // Whether the leader lists their squad here. Forced true for a solo
        // event, matching the RPC. Sent even when false so a tick can be CLEARED
        // — the RPC reads it by presence, so omitting it would leave the old
        // value in place and the box would appear to save but not save.
        roster_collected_on_site:
          form.entry_type === "team" ? !!form.roster_collected_on_site : true,
        team_form_url: form.team_form_url.trim() === "" ? null : form.team_form_url.trim(),
        status: form.status.trim(),
        is_active: form.is_active,
      },
      token
    );
    setBusy(false);
    if (!result.ok) {
      onError(result.body?.error ?? "The event could not be saved.");
      return;
    }
    setForm(emptyEvent);
    onSaved();
  }

  async function retire(id) {
    if (busy) return;
    setBusy(true);
    onError(null);
    const result = await staffRetireEvent(id, token);
    setBusy(false);
    if (!result.ok) {
      onError(result.body?.error ?? "The event could not be retired.");
      return;
    }
    onSaved();
  }

  /**
   * Permanently remove an event. Master only, and the database refuses anything
   * somebody has registered for or that a live bundle seats.
   *
   * `window.confirm` names the event, because "Delete" beside a list of nine is
   * a coin flip. It also says the word permanent, so the difference from the
   * Retire button next to it is not a surprise. The confirm is a courtesy - the
   * role check and the reference checks both live in the RPC, where a caller
   * that skips this prompt still cannot get past them.
   */
  async function remove(id, title) {
    if (busy) return;
    if (
      !window.confirm(
        `Permanently delete "${title}"?\n\nThis cannot be undone, and it is refused if anybody has registered for it. Retire it instead if you only want it off the public site.`
      )
    ) {
      return;
    }
    setBusy(true);
    onError(null);
    const result = await staffDeleteEvent(id, token);
    setBusy(false);
    if (!result.ok) {
      onError(result.body?.error ?? "The event could not be deleted.");
      return;
    }
    onDeleted?.(`"${title}" was deleted permanently.`);
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
      <div>
        <h3 className="font-mono text-[11px] uppercase tracking-[0.3em] text-ash">
          Events ({events.length})
        </h3>
        <ul className="mt-3 divide-y divide-line border border-line">
          {events.length === 0 ? (
            <li className="p-4 font-mono text-sm text-ash">
              No events yet. Add one on the right.
            </li>
          ) : null}
          {events.map((e) => (
            <li key={e.id} className="flex flex-wrap items-center gap-3 p-3">
              <button
                type="button"
                onClick={() => edit(e)}
                className="min-w-[12rem] flex-1 text-left"
              >
                <span className="block text-sm text-bone">{e.title}</span>
                <span className="block font-mono text-[11px] text-ash">
                  {e.id} · {e.realm} · {entryLabel(e)}
                  {e.is_active ? "" : " · RETIRED"}
                </span>
              </button>
              {e.is_active ? (
                <button
                  type="button"
                  data-action="retire-event"
                  onClick={() => retire(e.id)}
                  className="border border-line px-3 py-1 font-mono text-[10px] uppercase tracking-[0.2em] text-ash transition hover:border-red-400/60 hover:text-bone"
                >
                  Retire
                </button>
              ) : null}
              {/* Delete is shown for a RETIRED row only, and to a master only.
                  Retiring first is the deliberate order: it is the step that
                  takes something off the public site, and delete is the
                  irreversible one. Offering both on a live row invites the
                  wrong click on the button people reach for. */}
              {canDelete ? (
                <button
                  type="button"
                  data-action="delete-event"
                  onClick={() => remove(e.id, e.title)}
                  className="border border-red-400/40 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.2em] text-red-300/80 transition hover:border-red-400 hover:text-red-200"
                >
                  Delete
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
        className="flex flex-col gap-3"
      >
        <h3 className="font-mono text-[11px] uppercase tracking-[0.3em] text-ash">
          {form.id && events.some((e) => e.id === form.id) ? "Edit event" : "New event"}
        </h3>
        <div>
          <label className={labelClass} htmlFor="cat-event-id">ID</label>
          <input id="cat-event-id" className={`mt-1 ${inputClass}`} value={form.id} onChange={set("id")} placeholder="vision-2065" />
        </div>
        <div>
          <label className={labelClass} htmlFor="cat-event-title">Title</label>
          <input id="cat-event-title" className={`mt-1 ${inputClass}`} value={form.title} onChange={set("title")} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelClass} htmlFor="cat-event-number">Number</label>
            <input id="cat-event-number" className={`mt-1 ${inputClass}`} value={form.number} onChange={set("number")} placeholder="02" />
          </div>
          <div>
            <label className={labelClass} htmlFor="cat-event-realm">Realm</label>
            <select id="cat-event-realm" className={`mt-1 ${inputClass}`} value={form.realm} onChange={set("realm")}>
              {REALMS.map((r) => (
                <option key={r.id} value={r.id}>{r.label}</option>
              ))}
            </select>
          </div>
        </div>
        <div>
          <label className={labelClass} htmlFor="cat-event-category">Category</label>
          <input id="cat-event-category" className={`mt-1 ${inputClass}`} value={form.category} onChange={set("category")} placeholder="IDEATHON" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelClass} htmlFor="cat-event-entry">Entry type</label>
            <select
              id="cat-event-entry"
              data-action="cat-event-entry"
              className={`mt-1 ${inputClass}`}
              value={form.entry_type}
              onChange={setEntryType}
            >
              {ENTRY_TYPES.map((t) => (
                <option key={t.id} value={t.id}>{t.label}</option>
              ))}
            </select>
          </div>
          {/* Shown only for a team, because that is the only case the cap means
              anything in. `required` rather than a JS check: the browser refuses
              an empty submit, and the RPC refuses it again with a sentence if
              anything ever posts here directly. */}
          {form.entry_type === "team" ? (
            <div>
              <label className={labelClass} htmlFor="cat-event-cap">Max team members</label>
              <input
                id="cat-event-cap"
                data-action="cat-event-cap"
                type="number"
                min="1"
                max="50"
                step="1"
                required
                className={`mt-1 ${inputClass}`}
                value={form.max_team_members}
                onChange={set("max_team_members")}
                placeholder="5"
              />
            </div>
          ) : null}
        </div>
        {/* These four had no inputs until now. The form read them, sent them on
            save, and blanked them — the RPC saw an empty string for a field the
            operator could not see, which is the worst kind of save. */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelClass} htmlFor="cat-event-date">Date</label>
            <input
              id="cat-event-date"
              data-action="cat-event-date"
              className={`mt-1 ${inputClass}`}
              value={form.event_date}
              onChange={set("event_date")}
              placeholder="OCT 5 — 6, 2026"
            />
          </div>
          <div>
            <label className={labelClass} htmlFor="cat-event-venue">Venue</label>
            <input
              id="cat-event-venue"
              data-action="cat-event-venue"
              className={`mt-1 ${inputClass}`}
              value={form.venue}
              onChange={set("venue")}
              placeholder="E-BLOCK · LABS A–E"
            />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelClass} htmlFor="cat-event-teamsize">Team size (printed)</label>
            <input
              id="cat-event-teamsize"
              data-action="cat-event-teamsize"
              className={`mt-1 ${inputClass}`}
              value={form.team_size}
              onChange={set("team_size")}
              placeholder="2 — 5 MEMBERS"
            />
            <p className="mt-1 font-mono text-[10px] text-ash">
              The label the card prints. The rule is the cap above.
            </p>
          </div>
          <div>
            <label className={labelClass} htmlFor="cat-event-status">Status</label>
            <input
              id="cat-event-status"
              data-action="cat-event-status"
              className={`mt-1 ${inputClass}`}
              value={form.status}
              onChange={set("status")}
              placeholder="REGISTRATION OPEN"
            />
          </div>
        </div>
        {form.entry_type === "team" ? (
          /* "Who pays" is NO LONGER A CHOICE, and that is the point of this
             control replacing a select.
             A team event is paid for by the team, so the only question an
             operator has is the exception: is the team formed on ANOTHER
             website? If it is, every member settles their own seat over there
             and this site collects no teammate list at all. That is the
             hackathon, and it is why this is one checkbox rather than two
             radio buttons that could be set to something impossible.
             payment_mode is derived from this flag and entry_type in the
             database (migration ...028), so it cannot drift. */
          <div>
            <label className={labelClass} htmlFor="cat-event-offsite">
              Team formed on another website
            </label>
            <label className="mt-2 flex items-start gap-2 font-mono text-[12px] text-bone">
              <input
                id="cat-event-offsite"
                data-action="cat-event-offsite"
                type="checkbox"
                className="mt-0.5"
                checked={!!form.team_formed_offsite}
                onChange={set("team_formed_offsite")}
              />
              <span>
                Tick this when each member pays their own fee and the team is
                assembled somewhere else. Leave it unticked and the leader pays
                once for the whole squad and lists their teammates here.
              </span>
            </label>
          </div>
        ) : null}
        {/* Only meaningful when the team pays as a team AND is not formed
            offsite - an offsite squad is never listed here whatever this says, so
            offering the box would be offering a control with no effect. Same
            reason migration ...035 keeps the two facts apart, applied to the UI
            so an operator is never shown a setting that does nothing. */}
        {form.entry_type === "team" && !form.team_formed_offsite ? (
          <div>
            <label className={labelClass} htmlFor="cat-event-roster">
              Collect teammate details
            </label>
            <label className="mt-2 flex items-start gap-2 font-mono text-[12px] text-bone">
              <input
                id="cat-event-roster"
                data-action="cat-event-roster"
                type="checkbox"
                className="mt-0.5"
                checked={!!form.roster_collected_on_site}
                onChange={set("roster_collected_on_site")}
              />
              <span>
                Tick this to ask the leader for their teammates&apos; names, roll
                numbers and contact details on this site. Untick it when the
                squad is assembled elsewhere &mdash; the leader still pays the one
                squad fee either way.
              </span>
            </label>
          </div>
        ) : null}
        <div>
          <label className={labelClass} htmlFor="cat-event-teamurl">Team link</label>
          <input
            id="cat-event-teamurl"
            data-action="cat-event-teamurl"
            type="url"
            className={`mt-1 ${inputClass}`}
            value={form.team_form_url}
            onChange={set("team_form_url")}
            placeholder="https://…"
          />
          <p className="mt-1 font-mono text-[10px] text-ash">
            Where a paid participant goes to form a team, if that happens elsewhere. Blank for none.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelClass} htmlFor="cat-event-price">
              {form.payment_mode === "per_team" ? "Squad payment" : "Individual payment"}
            </label>
            <input
              id="cat-event-price"
              data-action="cat-event-price"
              type="number"
              min="0"
              step="1"
              inputMode="numeric"
              className={`mt-1 ${inputClass}`}
              value={form.price}
              onChange={set("price")}
              placeholder={form.payment_mode === "per_team" ? "300" : "249"}
            />
            <p className="mt-1 font-mono text-[10px] text-ash">
              {form.payment_mode === "per_team"
                ? "The whole squad's fee, paid once by the leader."
                : "What one person pays. Leave blank to keep the current price."}
            </p>
          </div>
          <div>
            <label className={labelClass} htmlFor="cat-event-limit">
              {form.payment_mode === "per_team" ? "Squad limit" : "Registration limit"}
            </label>
            <input
              id="cat-event-limit"
              data-action="cat-event-limit"
              type="number"
              min="1"
              step="1"
              inputMode="numeric"
              className={`mt-1 ${inputClass}`}
              value={form.max_registrations}
              onChange={set("max_registrations")}
              placeholder="No limit"
            />
            <p className="mt-1 font-mono text-[10px] text-ash">
              {form.payment_mode === "per_team"
                ? "How many squads. Leave blank for no limit."
                : "Total people allowed. Leave blank for no limit."}
            </p>
          </div>
          {/* The last day, beside the limit because the two are one decision:
              how many, and until when. DateField rather than <input type="date">
              because that widget opens the OS's own light-themed calendar on top
              of this dark console - the reason the roster's date filters were
              replaced with this component. */}
          <div className="col-span-2">
            <label className={labelClass} htmlFor="cat-event-closes">
              Registration closes
            </label>
            <div className="mt-1">
              <DateField
                id="cat-event-closes"
                value={form.registration_closes_on}
                onChange={(v) => setForm((f) => ({ ...f, registration_closes_on: v }))}
                placeholder="No deadline"
              />
            </div>
            <p className="mt-1 font-mono text-[10px] text-ash">
              The last day somebody may register for this event — that whole day is
              still open. Leave blank for no deadline. Closing registration does not
              take the event off the site; use Retire for that.
            </p>
          </div>
        </div>
        <label className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.2em] text-ash">
          <input type="checkbox" checked={form.is_active} onChange={set("is_active")} />
          Published
        </label>
        <button type="submit" disabled={busy} className={buttonClass} data-action="save-event">
          {busy ? "Saving…" : "Save event"}
        </button>
      </form>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* bundles                                                             */
/* ------------------------------------------------------------------ */

const emptyBundle = {
  id: "",
  number: "",
  name: "",
  group_id: "nexus-forge",
  is_active: true,
  includes: [],
};

function BundleEditor({ bundles, events, token, onSaved, onError, onDeleted, canDelete }) {
  const [form, setForm] = useState(emptyBundle);
  const [busy, setBusy] = useState(false);

  function edit(row) {
    setForm(toBundleForm(row));
  }
  const setField = (k) => (e) =>
    setForm((f) => ({ ...f, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));

  function addLine(kind) {
    setForm((f) => ({
      ...f,
      includes: [
        ...f.includes,
        kind === "event"
          ? { kind: "event", event: events[0]?.id ?? "" }
          : { kind: "pool", pick: "forge", count: 1, excludeHackathon: false },
      ],
    }));
  }

  function updateLine(index, patch) {
    setForm((f) => ({
      ...f,
      includes: f.includes.map((line, i) => (i === index ? { ...line, ...patch } : line)),
    }));
  }

  function removeLine(index) {
    setForm((f) => ({ ...f, includes: f.includes.filter((_, i) => i !== index) }));
  }

  async function save() {
    if (busy) return;
    setBusy(true);
    onError(null);
    const result = await staffUpsertBundle(
      {
        id: form.id.trim(),
        number: form.number.trim(),
        name: form.name.trim(),
        group_id: form.group_id,
        is_active: form.is_active,
        // Normalised to the RPC's line shape. The form's `kind` is a UI
        // affordance only; the database stores "event OR realm+count" and
        // rejects anything that is both or neither, so the mapping happens here
        // rather than relying on the server to infer it.
        includes: form.includes.map((line) =>
          line.kind === "event"
            ? { event: line.event }
            : {
                pick: line.pick,
                count: Number(line.count),
                excludeHackathon: !!line.excludeHackathon,
              }
        ),
      },
      token
    );
    setBusy(false);
    if (!result.ok) {
      // The server's message is the useful one here: it names the offending line
      // ("No active event called X") or the duplicate bundle it clashed with.
      onError(result.body?.error ?? "The bundle could not be saved.");
      return;
    }
    setForm(emptyBundle);
    onSaved();
  }

  async function retire(id) {
    if (busy) return;
    setBusy(true);
    onError(null);
    const result = await staffRetireBundle(id, token);
    setBusy(false);
    if (!result.ok) {
      onError(result.body?.error ?? "The bundle could not be retired.");
      return;
    }
    onSaved();
  }

  /** Permanently remove a bundle, its include lines and its price. Master only. */
  async function remove(id, label) {
    if (busy) return;
    if (
      !window.confirm(
        `Permanently delete "${label}"?\n\nIts include lines and its price go with it. This cannot be undone, and it is refused if anybody has bought it.`
      )
    ) {
      return;
    }
    setBusy(true);
    onError(null);
    const result = await staffDeleteBundle(id, token);
    setBusy(false);
    if (!result.ok) {
      onError(result.body?.error ?? "The bundle could not be deleted.");
      return;
    }
    onDeleted?.(`"${label}" was deleted permanently.`);
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_24rem]">
      <div>
        <h3 className="font-mono text-[11px] uppercase tracking-[0.3em] text-ash">
          Bundles ({bundles.length})
        </h3>
        <ul className="mt-3 divide-y divide-line border border-line">
          {bundles.length === 0 ? (
            <li className="p-4 font-mono text-sm text-ash">No bundles yet. Add one on the right.</li>
          ) : null}
          {bundles.map((b) => (
            <li key={b.id} className="flex flex-wrap items-center gap-3 p-3">
              <button type="button" onClick={() => edit(b)} className="min-w-[12rem] flex-1 text-left">
                <span className="block text-sm text-bone">#{b.number} {b.name}</span>
                <span className="block font-mono text-[11px] text-ash">
                  {b.id}
                  {b.is_active ? "" : " · RETIRED"}
                </span>
              </button>
              {b.is_active ? (
                <button
                  type="button"
                  data-action="retire-bundle"
                  onClick={() => retire(b.id)}
                  className="border border-line px-3 py-1 font-mono text-[10px] uppercase tracking-[0.2em] text-ash transition hover:border-red-400/60 hover:text-bone"
                >
                  Retire
                </button>
              ) : null}
              {/* Master only, and offered on a retired row: retire is the
                  reversible way off the public site, delete is the one that
                  erases the lines and the price for good. */}
              {canDelete ? (
                <button
                  type="button"
                  data-action="delete-bundle"
                  onClick={() => remove(b.id, `#${b.number} ${b.name}`)}
                  className="border border-red-400/40 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.2em] text-red-300/80 transition hover:border-red-400 hover:text-red-200"
                >
                  Delete
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
        className="flex flex-col gap-3"
      >
        <h3 className="font-mono text-[11px] uppercase tracking-[0.3em] text-ash">
          {bundles.some((b) => b.id === form.id) ? "Edit bundle" : "New bundle"}
        </h3>
        <div>
          <label className={labelClass} htmlFor="cat-bundle-id">ID</label>
          <input id="cat-bundle-id" className={`mt-1 ${inputClass}`} value={form.id} onChange={setField("id")} placeholder="bundled-299" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelClass} htmlFor="cat-bundle-name">Name</label>
            <input id="cat-bundle-name" className={`mt-1 ${inputClass}`} value={form.name} onChange={setField("name")} />
          </div>
          <div>
            <label className={labelClass} htmlFor="cat-bundle-number">Number</label>
            <input id="cat-bundle-number" className={`mt-1 ${inputClass}`} value={form.number} onChange={setField("number")} placeholder="01" />
          </div>
        </div>

        <fieldset className="border border-line p-3">
          <legend className="px-1 font-mono text-[11px] uppercase tracking-[0.2em] text-ash">
            Includes
          </legend>
          {form.includes.length === 0 ? (
            <p className="font-mono text-[11px] text-ash">
              None yet. A bundle needs at least one line.
            </p>
          ) : null}
          <ul className="flex flex-col gap-2">
            {form.includes.map((line, i) => (
              <li key={i} className="flex flex-wrap items-center gap-2">
                <select
                  aria-label={`Line ${i + 1} type`}
                  className={inputClass}
                  value={line.kind}
                  onChange={(e) =>
                    updateLine(
                      i,
                      e.target.value === "event"
                        ? { kind: "event", event: events[0]?.id ?? "" }
                        : { kind: "pool", pick: "forge", count: 1, excludeHackathon: false }
                    )
                  }
                >
                  <option value="event">Event</option>
                  <option value="pool">Pick-pool</option>
                </select>
                {line.kind === "event" ? (
                  <select
                    aria-label={`Line ${i + 1} event`}
                    className={inputClass}
                    value={line.event}
                    onChange={(e) => updateLine(i, { event: e.target.value })}
                  >
                    {events.map((e) => (
                      <option key={e.id} value={e.id}>{e.title}</option>
                    ))}
                  </select>
                ) : (
                  <>
                    <select
                      aria-label={`Line ${i + 1} realm`}
                      className={inputClass}
                      value={line.pick}
                      onChange={(e) => updateLine(i, { pick: e.target.value })}
                    >
                      {REALMS.map((r) => (
                        <option key={r.id} value={r.id}>{r.label}</option>
                      ))}
                    </select>
                    <input
                      aria-label={`Line ${i + 1} count`}
                      type="number"
                      min="1"
                      className={`${inputClass} w-20`}
                      value={line.count}
                      onChange={(e) => updateLine(i, { count: e.target.value })}
                    />
                    <label className="font-mono text-[10px] uppercase tracking-[0.15em] text-ash">
                      <input
                        type="checkbox"
                        checked={!!line.excludeHackathon}
                        onChange={(e) => updateLine(i, { excludeHackathon: e.target.checked })}
                      />{" "}
                      no hackathon
                    </label>
                  </>
                )}
                <button
                  type="button"
                  aria-label={`Remove line ${i + 1}`}
                  onClick={() => removeLine(i)}
                  className="border border-line px-2 py-1 font-mono text-[10px] text-ash transition hover:border-red-400/60 hover:text-bone"
                >
                  âœ•
                </button>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex gap-2">
            <button type="button" onClick={() => addLine("event")} className={buttonClass}>
              + Event
            </button>
            <button type="button" onClick={() => addLine("pool")} className={buttonClass}>
              + Pool
            </button>
          </div>
        </fieldset>

        <label className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.2em] text-ash">
          <input type="checkbox" checked={form.is_active} onChange={setField("is_active")} />
          Published
        </label>
        <button type="submit" disabled={busy} className={buttonClass} data-action="save-bundle">
          {busy ? "Saving…" : "Save bundle"}
        </button>
      </form>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* the tab                                                             */
/* ------------------------------------------------------------------ */

export default function CatalogueManager({ session }) {
  const [catalogue, setCatalogue] = useState({ events: [], bundles: [] });
  const [error, setError] = useState(null);
  const [ok, setOk] = useState(null);
  const [which, setWhich] = useState("events");

  // Re-read after every write. Nothing here is optimistically updated: a save is
  // a server round trip that can be refused (a duplicate bundle, a missing
  // event), and a list that disagreed with the database would be worse than one
  // that is briefly stale.
  const reload = useCallback(() => {
    // staffListCatalogue, not loadPublicCatalogue. The public one filters to
    // `is_active` because it feeds the public site, so using it here meant a
    // retired event or bundle was invisible in the one screen whose job is
    // editing the catalogue - it could not be seen, restored, or deleted, and
    // the only record it existed was the audit log. Live rows first, retired
    // below, so the working set stays at the top of the list.
    staffListCatalogue(session.token).then((result) => {
      if (result.ok) {
        setCatalogue({ events: result.events, bundles: result.bundles });
        setError(null);
      } else {
        setError(result.error);
      }
    });
    // `session.token` is a dependency because the list is now a STAFF read
    // rather than the public one - without it in the deps the callback would
    // capture the token from the first render, which is null before sign-in,
    // and the console would show "Only a master administrator can read the full
    // catalogue" forever.
  }, [session.token]);

  useEffect(reload, [reload]);

  function saved(message) {
    setError(null);
    setOk(message);
    reload();
  }

  return (
    <section data-action="catalogue-manager">
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <div className="flex gap-2">
          <button
            type="button"
            data-action="catalogue-tab-events"
            aria-pressed={which === "events"}
            onClick={() => setWhich("events")}
            className={`border px-4 py-2 font-mono text-[11px] uppercase tracking-[0.2em] transition ${
              which === "events"
                ? "border-violet-bright text-bone"
                : "border-line text-ash hover:border-violet-bright/60"
            }`}
          >
            Events
          </button>
          <button
            type="button"
            data-action="catalogue-tab-bundles"
            aria-pressed={which === "bundles"}
            onClick={() => setWhich("bundles")}
            className={`border px-4 py-2 font-mono text-[11px] uppercase tracking-[0.2em] transition ${
              which === "bundles"
                ? "border-violet-bright text-bone"
                : "border-line text-ash hover:border-violet-bright/60"
            }`}
          >
            Bundles
          </button>
        </div>
        <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-ash">
          Signed in as {session.username} · {session.role}
        </p>
      </div>

      {error ? (
        <p role="alert" className="mb-4 border border-red-400/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {error}
        </p>
      ) : null}
      {ok && !error ? (
        <p className="mb-4 border border-violet-bright/30 bg-violet-bright/10 px-4 py-3 text-sm text-bone">
          {ok}
        </p>
      ) : null}

      {which === "events" ? (
        <EventEditor
          events={catalogue.events}
          token={session.token}
          onError={setError}
          onSaved={() => saved("Event saved. The public catalogue is updated.")}
          onDeleted={(message) => {
            setError(null);
            setOk(message);
            reload();
          }}
          canDelete={roleCan(session.role, "delete_catalogue")}
        />
      ) : (
        <BundleEditor
          bundles={catalogue.bundles}
          events={catalogue.events}
          token={session.token}
          onError={setError}
          onSaved={() => saved("Bundle saved. The public catalogue is updated.")}
          onDeleted={(message) => {
            setError(null);
            setOk(message);
            reload();
          }}
          canDelete={roleCan(session.role, "delete_catalogue")}
        />
      )}
    </section>
  );
}

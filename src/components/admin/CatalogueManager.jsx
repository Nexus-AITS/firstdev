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
import {
  loadPublicCatalogue,
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
  if (row.entry_type !== "team") return "INDIVIDUAL";
  return row.max_team_members == null
    ? "TEAM · NO CAP"
    : `TEAM · MAX ${row.max_team_members}`;
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

function EventEditor({ events, token, onSaved, onError }) {
  const [form, setForm] = useState(emptyEvent);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) =>
    setForm((f) => ({ ...f, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));

  // Flipping to Individual clears the cap rather than leaving a number behind a
  // field that is no longer on screen — it would otherwise go back to the server
  // as a value the operator cannot see and did not intend.
  const setEntryType = (e) =>
    setForm((f) => ({
      ...f,
      entry_type: e.target.value,
      max_team_members: e.target.value === "team" ? f.max_team_members : "",
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

function BundleEditor({ bundles, events, token, onSaved, onError }) {
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
    loadPublicCatalogue().then((result) => {
      if (result.ok) {
        setCatalogue({ events: result.events, bundles: result.bundles });
        setError(null);
      } else {
        setError(result.error);
      }
    });
  }, []);

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
        />
      ) : (
        <BundleEditor
          bundles={catalogue.bundles}
          events={catalogue.events}
          token={session.token}
          onError={setError}
          onSaved={() => saved("Bundle saved. The public catalogue is updated.")}
        />
      )}
    </section>
  );
}

/**
 * Problem statements tab — the briefs the public /problem-statements page renders.
 *
 * Same contract as the contacts tab: an editor over the database, not a list of
 * briefs compiled into the bundle. Editing a title here changes what every team
 * reads, immediately, with no redeploy.
 *
 * The event dropdown is fed by the same call that returns the rows, because the
 * event list is the catalogue's and the statements are the console's — asking for
 * them separately would be two requests that can disagree about which events
 * exist.
 *
 * Retire, never delete. A brief a team has already read and built against does not
 * stop existing because it was hidden, and the audit trail is the record of what
 * was promised.
 */
import { useCallback, useEffect, useState } from "react";
import {
  staffListProblemStatements,
  staffRetireProblemStatement,
  staffUpsertProblemStatement,
} from "../../data/staff.js";
import Select from "../ui/Select.jsx";

const inputClass =
  "w-full border border-line bg-void-raised px-3 py-2 font-mono text-sm text-bone outline-none transition focus:border-violet-bright";
const labelClass = "block font-mono text-[11px] uppercase tracking-[0.3em] text-ash";
const buttonClass =
  "border border-violet-bright/60 px-4 py-2 font-mono text-[11px] uppercase tracking-[0.2em] text-bone transition hover:border-violet-bright disabled:opacity-50";

const emptyForm = {
  id: "",
  event_id: "",
  title: "",
  summary: "",
  detail: "",
  track: "",
  is_active: false,
  sort_order: "0",
};

/** Coerce a row into the form's shape; every field is a string, always. */
function toForm(row) {
  return {
    id: row.id ?? "",
    event_id: row.event_id ?? "",
    title: row.title ?? "",
    summary: row.summary ?? "",
    detail: row.detail ?? "",
    track: row.track ?? "",
    is_active: row.is_active === true,
    sort_order: String(row.sort_order ?? 0),
  };
}

function Row({ row, eventName, onEdit, onRetire }) {
  return (
    <li
      className={`border p-4 ${row.is_active ? "border-line" : "border-line/50 opacity-60"}`}
      data-action="statement-row"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-lavender/70">
            {eventName ?? "No event"}
            {row.track ? ` · ${row.track}` : ""}
            {!row.is_active ? " · not published" : ""}
          </p>
          <p className="mt-2 font-display text-base tracking-[0.1em] text-crystal">{row.title}</p>
          <p className="mt-1 text-sm leading-relaxed text-crystal/60">{row.summary}</p>
        </div>
        <div className="flex shrink-0 gap-2">
          <button type="button" className={buttonClass} onClick={() => onEdit(row)}>
            Edit
          </button>
          {row.is_active ? (
            <button type="button" className={buttonClass} onClick={() => onRetire(row)}>
              Retire
            </button>
          ) : null}
        </div>
      </div>
    </li>
  );
}

function Form({ session, reload, events, editing, onCancelEdit }) {
  const [form, setForm] = useState(emptyForm);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Keyed on the id rather than the object: the parent re-renders on every
  // keystroke elsewhere, and depending on the whole row would reload the form from
  // the database under the operator's cursor mid-edit.
  useEffect(() => {
    if (editing) setForm(toForm(editing));
  }, [editing?.id]);

  /* Same three-shape problem as AnnouncementManager: <Select> passes a raw value,
     <input>/<textarea> pass a SyntheticEvent, and a checkbox event's .value is the
     string "on". Storing the event verbatim is what renders "[object Object]"
     in the field. */
  const setField = (key) => (arg) => {
    const value =
      arg && typeof arg === "object" && "target" in arg
        ? arg.target.type === "checkbox"
          ? arg.target.checked
          : arg.target.value
        : arg;
    setForm((f) => ({ ...f, [key]: value }));
  };
  const startNew = () => {
    setForm(emptyForm);
    setError("");
    onCancelEdit?.();
  };

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    const result = await staffUpsertProblemStatement(session.token, form);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    startNew();
    reload();
  };

  const options = [
    { value: "", label: "No event" },
    ...events.map((e) => ({ value: e.id, label: `${e.title}${e.is_active ? "" : " (inactive)"}` })),
  ];

  return (
    <section className="border border-line bg-void-raised/40 p-5">
      <h3 className="font-mono text-[11px] uppercase tracking-[0.3em] text-lavender">
        {form.id ? "Edit problem statement" : "New problem statement"}
      </h3>

      <form className="mt-5 grid gap-4" onSubmit={submit}>
        <div>
          <label className={labelClass} htmlFor="statement-event">
            Event
          </label>
          <Select
            id="statement-event"
            className="mt-1"
            value={form.event_id}
            onChange={setField("event_id")}
            options={options}
          />
          <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.2em] text-ash">
            Optional. A brief with no event still shows, under &ldquo;No event&rdquo;.
          </p>
        </div>

        <div>
          <label className={labelClass} htmlFor="statement-title">
            Title
          </label>
          <input
            id="statement-title"
            className={`mt-1 ${inputClass}`}
            value={form.title}
            onChange={setField("title")}
            placeholder="Campus Energy Optimiser"
            required
          />
        </div>

        <div>
          <label className={labelClass} htmlFor="statement-summary">
            Summary
          </label>
          <input
            id="statement-summary"
            className={`mt-1 ${inputClass}`}
            value={form.summary}
            onChange={setField("summary")}
            placeholder="One line a team reads before deciding to enter."
            required
          />
          <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.2em] text-ash">
            The one-line version. Shown on the card and under the heading.
          </p>
        </div>

        <div>
          <label className={labelClass} htmlFor="statement-detail">
            Detail
          </label>
          <textarea
            id="statement-detail"
            rows={8}
            className={`mt-1 ${inputClass}`}
            value={form.detail}
            onChange={setField("detail")}
            placeholder={"What teams must build.\nWhat is judged.\nWhat is out of scope."}
          />
          <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.2em] text-ash">
            Optional, plain text. Line breaks are kept; there is no markup.
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label className={labelClass} htmlFor="statement-track">
              Track
            </label>
            <input
              id="statement-track"
              className={`mt-1 ${inputClass}`}
              value={form.track}
              onChange={setField("track")}
              placeholder="Sustainability"
            />
            <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.2em] text-ash">
              Optional. Shown as a small chip when the event runs several.
            </p>
          </div>
          <div>
            <label className={labelClass} htmlFor="statement-order">
              Order
            </label>
            <input
              id="statement-order"
              type="number"
              className={`mt-1 ${inputClass}`}
              value={form.sort_order}
              onChange={setField("sort_order")}
            />
            <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.2em] text-ash">
              Lower shows first.
            </p>
          </div>
        </div>

        <label className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.2em] text-ash">
          <input type="checkbox" checked={form.is_active} onChange={setField("is_active")} />
          Published
        </label>

        {error ? (
          <p role="alert" className="border border-red-400/40 px-3 py-2 text-sm text-red-200">
            {error}
          </p>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <button type="submit" disabled={busy} className={buttonClass} data-action="save-statement">
            {busy ? "Saving…" : form.id ? "Save changes" : "Create statement"}
          </button>
          {form.id ? (
            <button type="button" onClick={startNew} className={buttonClass}>
              Cancel
            </button>
          ) : null}
        </div>
      </form>
    </section>
  );
}

export default function ProblemStatementManager({ session }) {
  const [rows, setRows] = useState([]);
  const [events, setEvents] = useState([]);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(null);

  const reload = useCallback(() => {
    staffListProblemStatements(session.token).then((result) => {
      if (!result.ok) {
        setError(result.error);
        setRows([]);
        setEvents([]);
        return;
      }
      setError("");
      setRows(result.statements);
      setEvents(result.events);
      // Re-synced from the returned list, so the form shows what is actually
      // stored rather than what was typed — the only way an operator can tell
      // their save landed.
      setEditing((current) =>
        current ? result.statements.find((r) => r.id === current.id) ?? null : null
      );
    });
  }, [session.token]);

  useEffect(() => {
    reload();
  }, [reload]);

  const retire = async (row) => {
    if (
      !window.confirm(
        `Retire "${row.title}"? It comes off the public page; the row stays for the audit trail.`
      )
    ) {
      return;
    }
    const result = await staffRetireProblemStatement(session.token, row.id);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    reload();
  };

  const eventName = (id) => events.find((e) => e.id === id)?.title ?? null;

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_420px]">
      <section className="border border-line bg-void-raised/40 p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h3 className="font-mono text-[11px] uppercase tracking-[0.3em] text-lavender">
            Problem statements
          </h3>
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-ash">
            {rows.length} total
          </span>
        </div>

        {error ? (
          <p role="alert" className="mt-4 border border-red-400/40 px-3 py-2 text-sm text-red-200">
            {error}
          </p>
        ) : null}

        {rows.length === 0 && !error ? (
          <p className="mt-4 border border-line px-4 py-6 text-center font-mono text-[11px] uppercase tracking-[0.2em] text-ash">
            Nothing written yet
          </p>
        ) : null}

        {rows.length > 0 ? (
          <ul className="mt-4 grid gap-3" data-action="statement-list">
            {rows.map((row) => (
              <Row
                key={row.id}
                row={row}
                eventName={eventName(row.event_id)}
                onEdit={setEditing}
                onRetire={retire}
              />
            ))}
          </ul>
        ) : null}
      </section>

      <Form
        session={session}
        reload={reload}
        events={events}
        editing={editing}
        onCancelEdit={() => setEditing(null)}
      />
    </div>
  );
}
/**
 * Announcements tab — what the public /announcements page renders, in the console.
 *
 * Same contract as the contacts tab: the screen is an editor over the database,
 * not a list of notices compiled into the bundle. Writing an announcement here
 * makes it appear on the public page immediately, with no redeploy and nothing for
 * a developer to do — which is the entire point, because a notice written into a
 * React component is a notice that is still on the site six months after the event.
 *
 * Retire, never delete. A notice a participant has already read does not stop
 * existing because it was hidden, and the audit log is the record of what was
 * published. Re-publishing is an edit with "Published" ticked.
 *
 * New rows default to UNPUBLISHED. The failure this avoids is the obvious one: an
 * operator opens the tab to check something, half-types a title, and a blank
 * placeholder goes live on the public site.
 */
import { useCallback, useEffect, useState } from "react";
import {
  can,
  staffDeleteAnnouncement,
  staffListAnnouncements,
  staffRetireAnnouncement,
  staffUpsertAnnouncement,
} from "../../data/staff.js";

const inputClass =
  "w-full border border-line bg-void-raised px-3 py-2 font-mono text-sm text-bone outline-none transition focus:border-violet-bright";
const labelClass = "block font-mono text-[11px] uppercase tracking-[0.3em] text-ash";
const buttonClass =
  "border border-violet-bright/60 px-4 py-2 font-mono text-[11px] uppercase tracking-[0.2em] text-bone transition hover:border-violet-bright disabled:opacity-50";

const emptyForm = {
  id: "",
  title: "",
  body: "",
  tag: "",
  link_label: "",
  link_href: "",
  is_pinned: false,
  is_active: false,
  published_at: "",
  sort_order: "0",
};

/** Coerce a row into the form's shape; every field is a string, always. */
function toForm(row) {
  return {
    id: row.id ?? "",
    title: row.title ?? "",
    body: row.body ?? "",
    tag: row.tag ?? "",
    link_label: row.link_label ?? "",
    link_href: row.link_href ?? "",
    is_pinned: row.is_pinned === true,
    is_active: row.is_active === true,
    // datetime-local wants "YYYY-MM-DDTHH:mm", and Postgres returns an ISO string
    // with a Z and seconds. Fed to <input type="datetime-local"> unchanged it is
    // silently invalid, the box renders empty, and saving that row wipes the
    // publish date. Trimmed to the shape the control actually accepts.
    published_at: row.published_at ? String(row.published_at).slice(0, 16) : "",
    sort_order: String(row.sort_order ?? 0),
  };
}

function whenLabel(row) {
  if (!row.published_at) return "no date — shows when you publish it";
  return new Date(row.published_at).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/* Retire is offered on EVERY row, not only published ones.

   It used to render only when `row.is_active`, which left an unpublished
   announcement with no buttons at all — you could save one by mistake, see it
   listed as "not published", and have no way to take it off the list except
   editing it into something you do want. Retiring a draft is harmless (it is
   already off the public page), so the button costs nothing and the hole is gone. */
function Row({ row, onEdit, onRetire, onDelete, canDelete }) {
  const isDraft = !row.is_active;
  return (
    <li
      className={`border p-4 ${row.is_active ? "border-line" : "border-line/50 opacity-60"}`}
      data-action="announcement-row"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-lavender/70">
            {row.is_pinned ? "Pinned" : "Notice"}
            {row.tag ? ` · ${row.tag}` : ""}
          </p>
          <p className="mt-2 font-display text-base tracking-[0.1em] text-crystal">{row.title}</p>
          <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.2em] text-ash">
            {whenLabel(row)}
          </p>

          {/* The DRAFT banner, stated in words. This is the single most
              confusing thing about the tab: an announcement that is saved, listed
              and completely absent from the public site. The row already carried a
              faint "not published", which is too quiet to explain an empty public
              page — an operator reasonably concludes the feature is broken. */}
          {isDraft ? (
            <p
              className="mt-2 inline-block border border-gold/40 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.25em] text-gold"
              data-action="announcement-draft"
            >
              Draft — not on the public page. Tick Published to show it.
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <button type="button" className={buttonClass} onClick={() => onEdit(row)}>
            Edit
          </button>
          <button type="button" className={buttonClass} onClick={() => onRetire(row)}>
            Retire
          </button>
          {canDelete ? (
            <button
              type="button"
              className={`${buttonClass} border-red-400/50 hover:border-red-300`}
              data-action="delete-announcement"
              onClick={() => onDelete(row)}
            >
              Delete
            </button>
          ) : null}
        </div>
      </div>
    </li>
  );
}

function Form({ session, reload, editing, onCancelEdit }) {
  const [form, setForm] = useState(emptyForm);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  /* The list and the form are separate components, so "Edit" is delivered here as a
     prop rather than by the row reaching into this state. Keyed on the id, not the
     object: the parent re-renders on every keystroke elsewhere, and a dependency on
     the whole row would reload the form from the database under the operator's
     cursor mid-edit. */
  useEffect(() => {
    if (editing) setForm(toForm(editing));
  }, [editing?.id]);

  /* Three DIFFERENT things arrive here under the same name, and treating them
     alike is what put a literal "[object Object]" in every field:
       - <Select> calls onChange(option.value) — a plain string.
       - <input>/<textarea> call onChange(event) — a SyntheticEvent, so storing it
         verbatim renders the event, not what was typed.
       - a checkbox's event.target.value is the string "on", not the state; only
         .checked carries the answer.
     An earlier version of this file assumed Select's shape and applied it to
     every input. */
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
    const result = await staffUpsertAnnouncement(session.token, {
      ...form,
      // The datetime-local control gives a LOCAL wall-clock string; Postgres wants
      // an instant. Sending the bare string and letting the server read it in the
      // database's zone is how a 6pm announcement goes out at midnight.
      published_at: form.published_at ? new Date(form.published_at).toISOString() : "",
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    startNew();
    reload();
  };

  return (
    <section className="border border-line bg-void-raised/40 p-5">
      <h3 className="font-mono text-[11px] uppercase tracking-[0.3em] text-lavender">
        {form.id ? "Edit announcement" : "New announcement"}
      </h3>

      <form className="mt-5 grid gap-4" onSubmit={submit}>
        <div>
          <label className={labelClass} htmlFor="announcement-title">
            Title
          </label>
          <input
            id="announcement-title"
            className={`mt-1 ${inputClass}`}
            value={form.title}
            onChange={setField("title")}
            placeholder="Results are published"
            required
          />
        </div>

        <div>
          <label className={labelClass} htmlFor="announcement-tag">
            Tag
          </label>
          <input
            id="announcement-tag"
            className={`mt-1 ${inputClass}`}
            value={form.tag}
            onChange={setField("tag")}
            placeholder="Results"
          />
          <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.2em] text-ash">
            Optional. The small label above the title on the public page.
          </p>
        </div>

        <div>
          <label className={labelClass} htmlFor="announcement-body">
            Body
          </label>
          <textarea
            id="announcement-body"
            rows={6}
            className={`mt-1 ${inputClass}`}
            value={form.body}
            onChange={setField("body")}
            placeholder="What changed, and what a participant should do about it."
          />
          <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.2em] text-ash">
            Plain text. Line breaks are kept; there is no markup.
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label className={labelClass} htmlFor="announcement-link-label">
              Link label
            </label>
            <input
              id="announcement-link-label"
              className={`mt-1 ${inputClass}`}
              value={form.link_label}
              onChange={setField("link_label")}
              placeholder="See the results"
            />
          </div>
          <div>
            <label className={labelClass} htmlFor="announcement-link-href">
              Link destination
            </label>
            <input
              id="announcement-link-href"
              className={`mt-1 ${inputClass}`}
              value={form.link_href}
              onChange={setField("link_href")}
              placeholder="/events/nexus-breach"
            />
          </div>
        </div>
        <p className="-mt-2 font-mono text-[10px] uppercase tracking-[0.2em] text-ash">
          Both halves or neither — the database refuses half a link, which is what a dead
          &ldquo;Read more&rdquo; button looks like.
        </p>

        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label className={labelClass} htmlFor="announcement-published">
              Publish date
            </label>
            <input
              id="announcement-published"
              type="datetime-local"
              className={`mt-1 ${inputClass}`}
              value={form.published_at}
              onChange={setField("published_at")}
            />
            <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.2em] text-ash">
              Leave empty and it appears the moment you tick Published.
            </p>
          </div>
          <div>
            <label className={labelClass} htmlFor="announcement-order">
              Order
            </label>
            <input
              id="announcement-order"
              type="number"
              className={`mt-1 ${inputClass}`}
              value={form.sort_order}
              onChange={setField("sort_order")}
            />
            <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.2em] text-ash">
              A tie-breaker for two notices on the same day.
            </p>
          </div>
        </div>

        <label className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.2em] text-ash">
          <input type="checkbox" checked={form.is_pinned} onChange={setField("is_pinned")} />
          Pin to the top
        </label>
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
          <button type="submit" disabled={busy} className={buttonClass} data-action="save-announcement">
            {busy ? "Saving…" : form.id ? "Save changes" : "Create announcement"}
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

export default function AnnouncementManager({ session }) {
  const [rows, setRows] = useState([]);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(null);

  const reload = useCallback(() => {
    staffListAnnouncements(session.token).then((result) => {
      if (!result.ok) {
        setError(result.error);
        setRows([]);
        return;
      }
      setError("");
      setRows(result.announcements);
      // The row being edited may have just been retired, or saved. Re-syncing it
      // from the returned list keeps the form showing what is actually stored
      // rather than what was typed, which is the only way an operator can tell
      // their save worked.
      setEditing((current) => (current ? result.announcements.find((r) => r.id === current.id) ?? null : null));
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
    const result = await staffRetireAnnouncement(session.token, row.id);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    reload();
  };

  /* Delete is deliberately a DIFFERENT action from retire, and the wording says
     so twice — in the confirm and in the failure path — because the two are easy
     to confuse and only one of them is recoverable. Two-step confirm on top: the
     first names the row, the second asks a question whose answer is not "yes". */
  const remove = async (row) => {
    if (
      !window.confirm(
        `Delete "${row.title}" PERMANENTLY?\n\nThis removes the row for good. Use Retire instead if it was published and you only want it off the public page.`
      )
    ) {
      return;
    }
    if (!window.confirm(`Last check — delete "${row.title}" for good?`)) return;

    const result = await staffDeleteAnnouncement(session.token, row.id);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    reload();
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_420px]">
      <section className="border border-line bg-void-raised/40 p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h3 className="font-mono text-[11px] uppercase tracking-[0.3em] text-lavender">
            Announcements
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
          <ul className="mt-4 grid gap-3" data-action="announcement-list">
            {rows.map((row) => (
              <Row
                key={row.id}
                row={row}
                onEdit={setEditing}
                onRetire={retire}
                onDelete={remove}
                /* Master only, checked against the SESSION role against its own capability —
     the same split the catalogue uses, where "delete" is a separate capability
     from "manage" precisely so an admin can be given one without the other.
     `delete_content` is granted to master alone; widen it here AND in
     staff_delete_announcement's staff_at_least('master') together, never one
     alone, or the UI starts offering a button the server always refuses. */
                canDelete={can(session.role, "delete_content")}
              />
            ))}
          </ul>
        ) : null}
      </section>

      <Form session={session} reload={reload} editing={editing} onCancelEdit={() => setEditing(null)} />
    </div>
  );
}
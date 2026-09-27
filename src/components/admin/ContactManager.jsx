/**
 * Contacts tab — what the public /contact page renders, in the console.
 *
 * Same contract as the catalogue tab: the screen is an editor over the
 * database, not a list of addresses compiled into the bundle. Adding a channel
 * here makes it appear on the public page immediately, with no redeploy and
 * nothing for a developer to do — which is the entire point, because the
 * previous arrangement (an address in a React component) is why it was wrong
 * every time somebody changed it.
 *
 * Retire, never delete. A number a participant has already written down does
 * not stop existing because we hide it, and the audit log is the record of
 * what was published. Re-publishing is an edit with "Published" ticked.
 */
import { useCallback, useEffect, useState } from "react";
import {
  staffListContacts,
  staffRetireContact,
  staffUpsertContact,
} from "../../data/staff.js";
import Select from "../ui/Select.jsx";

const KINDS = [
  { value: "email", label: "Email" },
  { value: "phone", label: "Phone" },
  { value: "website", label: "Website" },
  { value: "text", label: "Text / address" },
];

const inputClass =
  "w-full border border-line bg-void-raised px-3 py-2 font-mono text-sm text-bone outline-none transition focus:border-violet-bright";
const labelClass = "block font-mono text-[11px] uppercase tracking-[0.3em] text-ash";
const buttonClass =
  "border border-violet-bright/60 px-4 py-2 font-mono text-[11px] uppercase tracking-[0.2em] text-bone transition hover:border-violet-bright disabled:opacity-50";

const emptyForm = {
  id: "",
  kind: "email",
  label: "",
  purpose: "",
  value: "",
  note: "",
  sort_order: 0,
  is_active: true,
};

/** Coerce a row into the form's shape; every field is a string, always. */
function toForm(row) {
  return {
    id: row.id ?? "",
    kind: row.kind ?? "email",
    label: row.label ?? "",
    purpose: row.purpose ?? "",
    value: row.value ?? "",
    note: row.note ?? "",
    sort_order: String(row.sort_order ?? 0),
    is_active: row.is_active !== false,
  };
}

/** The placeholder under the value box, which follows the chosen kind. */
const VALUE_HINT = {
  email: "registrations@nexus.example",
  phone: "+91 98765 43210",
  website: "nexus.example/contact",
  text: "Main Block, ground floor",
};

/** The line under the value box. Says what will happen to what they type. */
function valueHelp(kind) {
  if (kind === "phone") return "Dialable as written — the page strips spaces and dashes for the tel: link.";
  if (kind === "email") return "The database refuses an address with no @ in it.";
  if (kind === "website") return "Type as you would read it out; the page adds https:// if you leave it off.";
  return "An address with nothing to dial or mail, so the page shows it as plain text.";
}

function Row({ row, onEdit, onRetire }) {
  return (
    <li className={`border p-4 ${row.is_active ? "border-line" : "border-line/50 opacity-60"}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-lavender/70">
            {KINDS.find((k) => k.value === row.kind)?.label ?? row.kind}
            {row.is_active ? "" : " · retired"}
          </p>
          <p className="mt-2 font-display text-base tracking-[0.1em] text-crystal">{row.label}</p>
          <p className="mt-1 break-words font-mono text-sm text-violet-bright">{row.value}</p>
          {row.purpose ? (
            <p className="mt-2 text-sm leading-relaxed text-crystal/60">{row.purpose}</p>
          ) : null}
          {row.note ? (
            <p className="mt-1 font-mono text-[11px] uppercase tracking-[0.2em] text-ash">
              {row.note}
            </p>
          ) : null}
        </div>

        <div className="flex shrink-0 gap-2">
          <button type="button" onClick={() => onEdit(row)} className={buttonClass} data-action="edit-contact">
            Edit
          </button>
          {row.is_active ? (
            <button
              type="button"
              onClick={() => onRetire(row)}
              className="border border-line px-4 py-2 font-mono text-[11px] uppercase tracking-[0.2em] text-ash transition hover:border-red-400/60 hover:text-bone"
              data-action="retire-contact"
            >
              Retire
            </button>
          ) : null}
        </div>
      </div>
    </li>
  );
}

export default function ContactManager({ session }) {
  const [rows, setRows] = useState([]);
  const [form, setForm] = useState(emptyForm);
  const [error, setError] = useState(null);
  const [ok, setOk] = useState(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // Re-read after every write. Nothing is optimistically updated: a save is a
  // round trip the database can refuse ("that does not look like an email
  // address"), and a console list that disagreed with the database would be
  // worse than one that is briefly stale.
  const reload = useCallback(() => {
    staffListContacts(session.token).then((result) => {
      if (result.ok) {
        setRows(result.contacts);
        setError(null);
      } else {
        setError(result.error);
      }
      setLoaded(true);
    });
  }, [session.token]);

  useEffect(reload, [reload]);

  // The Select passes the value through directly, an <input> passes an event.
  const setField = (field) => (event) => {
    const value = event?.target ? event.target.value : event;
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  function startNew() {
    setForm(emptyForm);
    setError(null);
    setOk(null);
  }

  function startEdit(row) {
    setForm(toForm(row));
    setError(null);
    setOk(null);
  }

  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setOk(null);
    const result = await staffUpsertContact(
      {
        // An empty id is what tells the server "create"; it fills one in.
        ...form,
        id: form.id || null,
        sort_order: Number(form.sort_order) || 0,
      },
      session.token
    );
    setBusy(false);
    if (!result.ok) {
      // The RPC's sentences are written for the operator, so they are shown
      // verbatim rather than replaced with something vaguer.
      setError(result.error);
      return;
    }
    setOk(
      result.created
        ? "Contact published. It is on the public contact page now."
        : "Contact updated. The public contact page shows the new value now."
    );
    setForm(emptyForm);
    reload();
  }

  async function retire(row) {
    setError(null);
    setOk(null);
    const result = await staffRetireContact(row.id, session.token);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setOk(`"${row.label}" is off the public page. The row is kept for the audit log.`);
    // If the operator was editing this row, stop: the form would otherwise still
    // hold the retired values, and a later save would republish it by accident
    // from a screen that no longer says what is live.
    setForm((prev) => (prev.id === row.id ? emptyForm : prev));
    reload();
  }

  return (
    <section data-action="contact-manager">
      <p className="mb-5 font-mono text-[11px] uppercase tracking-[0.2em] text-ash">
        Signed in as {session.username} · {session.role}
      </p>

      {error ? (
        <p
          role="alert"
          className="mb-4 border border-red-400/40 bg-red-500/10 px-4 py-3 text-sm text-red-200"
        >
          {error}
        </p>
      ) : null}
      {ok && !error ? (
        <p className="mb-4 border border-violet-bright/30 bg-violet-bright/10 px-4 py-3 text-sm text-bone">
          {ok}
        </p>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div>
          <h2 className="font-display text-lg tracking-[0.2em] text-crystal">PUBLISHED CHANNELS</h2>
          {loaded && rows.length === 0 ? (
            <p className="mt-4 border border-line px-4 py-5 text-sm leading-relaxed text-crystal/60">
              Nothing here yet, and the public contact page says exactly that — it shows &ldquo;
              nothing published yet&rdquo; rather than an empty box that reads as a broken page.
              Add the first channel with the form beside this list.
            </p>
          ) : null}

          <ul className="mt-4 flex flex-col gap-3" data-action="contact-rows">
            {rows.map((row) => (
              <Row key={row.id} row={row} onEdit={startEdit} onRetire={retire} />
            ))}
          </ul>
        </div>

        <form
          onSubmit={save}
          className="flex h-fit flex-col gap-4 border border-line bg-void-raised/40 p-5"
        >
          <h2 className="font-display text-lg tracking-[0.2em] text-crystal">
            {form.id ? "EDIT CHANNEL" : "NEW CHANNEL"}
          </h2>

          <div>
            <label className={labelClass} htmlFor="contact-kind">Kind</label>
            <Select id="contact-kind" value={form.kind} onChange={setField("kind")} options={KINDS} className="mt-1" />
          </div>

          <div>
            <label className={labelClass} htmlFor="contact-label">Label</label>
            <input
              id="contact-label"
              className={`mt-1 ${inputClass}`}
              value={form.label}
              onChange={setField("label")}
              placeholder="Payment help"
              required
            />
            <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.2em] text-ash">
              What this channel is for, in three or four words.
            </p>
          </div>

          <div>
            <label className={labelClass} htmlFor="contact-purpose">Purpose</label>
            <input
              id="contact-purpose"
              className={`mt-1 ${inputClass}`}
              value={form.purpose}
              onChange={setField("purpose")}
              placeholder="UTR corrections, refunds, seat queries"
            />
            <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.2em] text-ash">
              Shown under the label, so a participant knows to use this one.
            </p>
          </div>

          <div>
            <label className={labelClass} htmlFor="contact-value">Value</label>
            <input
              id="contact-value"
              className={`mt-1 ${inputClass}`}
              value={form.value}
              onChange={setField("value")}
              placeholder={VALUE_HINT[form.kind]}
              required
            />
            <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.2em] text-ash">
              {valueHelp(form.kind)}
            </p>
          </div>

          <div>
            <label className={labelClass} htmlFor="contact-note">Note</label>
            <input
              id="contact-note"
              className={`mt-1 ${inputClass}`}
              value={form.note}
              onChange={setField("note")}
              placeholder="Mon-Sat, 9 AM - 6 PM IST"
            />
          </div>

          <div>
            <label className={labelClass} htmlFor="contact-order">Order</label>
            <input
              id="contact-order"
              type="number"
              className={`mt-1 ${inputClass}`}
              value={form.sort_order}
              onChange={setField("sort_order")}
            />
            <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.2em] text-ash">
              Lower shows first.
            </p>
          </div>

          <label className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.2em] text-ash">
            <input type="checkbox" checked={form.is_active} onChange={setField("is_active")} />
            Published
          </label>

          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={busy} className={buttonClass} data-action="save-contact">
              {busy ? "Saving…" : form.id ? "Save changes" : "Publish channel"}
            </button>
            {form.id ? (
              <button type="button" onClick={startNew} className={buttonClass}>
                Cancel
              </button>
            ) : null}
          </div>
        </form>
      </div>
    </section>
  );
}

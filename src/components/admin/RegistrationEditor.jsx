import { useState } from "react";

/**
 * The fields a registration is made of, in one list, so the editor and the
 * create form cannot drift apart.
 *
 * `key` is the REGISTRATION COLUMN, not a form field name — it is what goes into
 * the patch sent to staff_update_registration, and that RPC writes a closed list
 * of columns. A field added here that the RPC does not know would be silently
 * ignored, so this list and the migration's SET clauses must move together.
 */
export const REG_FIELDS = [
  { key: "name", label: "Name", span: 2, required: true },
  { key: "email", label: "Email", required: true },
  { key: "phone_number", label: "Phone" },
  { key: "roll_number", label: "Roll number" },
  { key: "college_name", label: "College" },
  { key: "department", label: "Department" },
  { key: "year", label: "Year" },
  { key: "team_name", label: "Team name" },
  { key: "event_id_value", label: "Event ID", hint: "Only when the event asks for one." },
  { key: "purchase_label", label: "Purchase", span: 2 },
  { key: "purchase_amount", label: "Amount", type: "number" },
];

export const PAY_STATUS_OPTIONS = [
  { value: "awaiting_utr", label: "Awaiting UTR" },
  { value: "awaiting_cash", label: "Awaiting cash" },
  { value: "unverified", label: "Unverified" },
  { value: "verified", label: "Verified" },
  { value: "rejected", label: "Rejected" },
];

/** One blank registration, for the "add one" form. */
export function emptyRegistration() {
  const d = {};
  for (const f of REG_FIELDS) d[f.key] = "";
  d.payment_method = "utr";
  d.payment_status = "awaiting_utr";
  d.utr_number = "";
  return d;
}

/**
 * The inline editor, used for BOTH editing a row and adding one.
 *
 * One component for both on purpose: they are the same question with the same
 * answers, and two forms would drift — the create form would quietly omit a
 * field the editor could correct, which is how a desk registration ends up with
 * a blank college nobody notices until the pivot is built.
 *
 * `initial` decides the mode. The caller saves through staff_update_registration
 * when there is an id and staff_create_registration when there is not, so "who
 * may do this" stays a database question rather than being re-decided here.
 */
export default function RegistrationEditor({
  initial,
  onSave,
  onCancel,
  saving,
  submitLabel,
}) {
  const [draft, setDraft] = useState(() => {
    const d = {};
    for (const f of REG_FIELDS) d[f.key] = initial?.[f.key] ?? "";
    d.payment_method = initial?.payment_method === "cash" ? "cash" : "utr";
    d.payment_status = initial?.payment_status ?? "awaiting_utr";
    d.utr_number = initial?.utr_number ?? "";
    return d;
  });

  const set = (k) => (e) => setDraft((d) => ({ ...d, [k]: e.target.value }));

  /* Only send what the operator actually CHANGED. The RPC writes presence-
     guarded, so an unchanged field sent as "" would blank it — sending the whole
     form on every save would quietly erase a college name on any edit that
     touched nothing else. The diff is computed here for exactly that reason. */
  const changed = REG_FIELDS.filter((f) => {
    const now = draft[f.key] === "" ? null : draft[f.key];
    const was = (initial?.[f.key] ?? "") === "" ? null : initial?.[f.key];
    return String(now ?? "") !== String(was ?? "");
  }).map((f) => [f.key, draft[f.key] === "" ? null : draft[f.key]]);

  if (draft.utr_number !== (initial?.utr_number ?? "")) {
    changed.push(["utr_number", draft.utr_number === "" ? null : draft.utr_number]);
  }
  if (draft.payment_status !== (initial?.payment_status ?? "awaiting_utr")) {
    changed.push(["payment_status", draft.payment_status]);
  }
  if (draft.payment_method !== (initial?.payment_method ?? "utr")) {
    changed.push(["payment_method", draft.payment_method]);
  }

  const input =
    "mt-1 w-full border border-line bg-void-raised px-3 py-2 text-sm text-bone outline-none focus:border-lavender/60";

  return (
    <div
      className="mt-4 border border-lavender/25 bg-void/60 p-4"
      data-registration-editor="true"
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {REG_FIELDS.map((f) => (
          <div key={f.key} className={f.span === 2 ? "sm:col-span-2" : ""}>
            <label className="block font-mono text-[10px] uppercase tracking-[0.25em] text-ash">
              {f.label}
              {f.required ? " *" : ""}
            </label>
            <input
              type={f.type ?? "text"}
              data-edit-field={f.key}
              value={draft[f.key]}
              onChange={set(f.key)}
              className={input}
            />
          </div>
        ))}

        <div>
          <label className="block font-mono text-[10px] uppercase tracking-[0.25em] text-ash">
            Payment method
          </label>
          <select
            data-edit-field="payment_method"
            value={draft.payment_method}
            onChange={set("payment_method")}
            className={input}
          >
            <option value="utr">UPI / UTR</option>
            <option value="cash">Cash at the venue</option>
          </select>
        </div>

        <div>
          <label className="block font-mono text-[10px] uppercase tracking-[0.25em] text-ash">
            Payment status
          </label>
          <select
            data-edit-field="payment_status"
            value={draft.payment_status}
            onChange={set("payment_status")}
            className={input}
          >
            {PAY_STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>

        {/* The UTR is editable, and that is the field the brief was about. It is
            called out rather than left among the others because pasting a
            reference also moves the status server-side — the operator does not
            have to know that, but should know it happened. */}
        <div className="sm:col-span-2">
          <label className="block font-mono text-[10px] uppercase tracking-[0.25em] text-ash">
            UTR / transaction reference
          </label>
          <input
            data-edit-field="utr_number"
            value={draft.utr_number}
            onChange={set("utr_number")}
            placeholder="Paste the reference the participant read you"
            className={input}
          />
          <p className="mt-1 font-mono text-[10px] text-ash">
            Leave empty for a cash payment — cash never carries a reference.
          </p>
        </div>
      </div>

      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          data-action="save-registration"
          disabled={saving}
          onClick={() => onSave(changed)}
          className="border border-violet-bright/60 px-4 py-2 font-mono text-[11px] uppercase tracking-[0.2em] text-bone transition hover:border-violet-bright disabled:opacity-50"
        >
          {submitLabel}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="font-mono text-[11px] uppercase tracking-[0.2em] text-ash transition-colors hover:text-lavender"
        >
          Cancel
        </button>
        {saving ? <span className="font-mono text-[11px] text-ash">Saving…</span> : null}
      </div>
    </div>
  );
}
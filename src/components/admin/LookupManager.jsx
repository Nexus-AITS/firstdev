import { useCallback, useEffect, useState } from "react";
import {
  staffListLookups,
  staffRetireLookup,
  staffUpsertLookup,
} from "../../data/staff.js";

/**
 * Colleges and departments â€” the lists the registration form offers.
 *
 * An operator adds a department here and it is selectable on the form
 * immediately: no developer, no redeploy, no edit to a React constant. That is
 * the whole point, because the previous arrangement - a college typed into a
 * text box - is why "AITS Tirupati", "AITS Tirupati " and "aits tirupati" all
 * ended up in the same column.
 *
 * Retire, never delete, and the reason is worth stating: registrations store the
 * college as TEXT. Deleting a row would change nothing about any participant who
 * already registered, and would only lose the record that the option ever
 * existed. Retiring takes it out of the dropdown and brings it straight back.
 */
/* `kind` is the value the RPC expects - singular, because that is what
 * staff_upsert_lookup switches on. `key` is what the fetched state is stored
 * under - plural, because it is a list. Different words on purpose; conflating
 * them renders an empty list with no error anywhere, which is exactly the
 * failure this pair exists to prevent. */
const LISTS = [
  { kind: "college", key: "colleges", label: "Colleges" },
  { kind: "department", key: "departments", label: "Departments" },
];

export default function LookupManager({ session }) {
  const [data, setData] = useState({ colleges: [], departments: [] });
  const [error, setError] = useState(null);
  const [ok, setOk] = useState(null);
  const [busy, setBusy] = useState(null);
  const [draft, setDraft] = useState({ college: "", department: "" });

  const reload = useCallback(() => {
    staffListLookups(session.token).then((result) => {
      if (result.ok) {
        setData({ colleges: result.colleges, departments: result.departments });
        setError(null);
      } else {
        setError(result.error);
      }
    });
  }, [session.token]);

  useEffect(reload, [reload]);

  async function add(kind) {
    const name = (draft[kind] ?? "").trim();
    if (busy) return;
    if (name.length < 2) {
      setError(`Give the ${kind} at least 2 characters.`);
      return;
    }
    setBusy(kind);
    setError(null);
    setOk(null);
    const result = await staffUpsertLookup(kind, name, session.token);
    setBusy(null);
    if (!result.ok) {
      setError(result.body?.error ?? `That ${kind} could not be saved.`);
      return;
    }
    setDraft((d) => ({ ...d, [kind]: "" }));
    setOk(`${result.body?.name ?? name} is on the list. It is selectable on the form now.`);
    reload();
  }

  async function retire(kind, row) {
    if (busy) return;
    setBusy(row.id);
    setError(null);
    setOk(null);
    const result = await staffRetireLookup(kind, row.id, session.token);
    setBusy(null);
    if (!result.ok) {
      setError(result.body?.error ?? `That ${kind} could not be retired.`);
      return;
    }
    setOk(`"${row.name}" is off the form. Existing registrations keep it.`);
    reload();
  }

  const inputClass =
    "w-full border border-line bg-void px-3 py-2 text-sm text-bone outline-none focus:border-violet-bright/60";

  return (
    <section data-action="lookup-manager">
      <p className="mb-5 max-w-2xl text-sm leading-relaxed text-crystal/60">
        The registration form offers these as dropdowns. Adding one here puts it in
        front of the next participant with no deploy â€” and a dropdown cannot produce
        the three-spellings-of-one-college problem a free text box can.
      </p>

      {error ? (
        <p role="alert" className="mb-4 border border-red-400/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {error}
        </p>
      ) : null}
      {ok && !error ? (
        <p className="mb-4 border border-jade/30 bg-jade/10 px-4 py-3 text-sm text-jade">
          {ok}
        </p>
      ) : null}

      <div className="grid gap-6 md:grid-cols-2">
        {LISTS.map(({ kind, key, label }) => {
          const rows = data[key] ?? [];
          return (
            <div key={kind}>
              <h3 className="font-mono text-[11px] uppercase tracking-[0.3em] text-ash">
                {label} ({rows.filter((r) => r.is_active).length} active)
              </h3>

              <div className="mt-3 flex gap-2">
                <input
                  id={`lookup-${kind}-name`}
                  data-action={`lookup-${kind}-input`}
                  className={inputClass}
                  value={draft[kind]}
                  onChange={(e) => setDraft((d) => ({ ...d, [kind]: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      add(kind);
                    }
                  }}
                  placeholder={`Add a ${kind}`}
                  aria-label={`New ${kind}`}
                />
                <button
                  type="button"
                  data-action={`lookup-${kind}-add`}
                  disabled={busy === kind}
                  onClick={() => add(kind)}
                  className="shrink-0 border border-violet-bright/50 px-4 py-2 font-mono text-[11px] uppercase tracking-[0.2em] text-bone transition hover:border-violet-bright disabled:opacity-40"
                >
                  {busy === kind ? "â€¦" : "Add"}
                </button>
              </div>

              <ul
                className="mt-3 divide-y divide-line border border-line"
                data-action={`lookup-${kind}-rows`}
              >
                {rows.length === 0 ? (
                  <li className="p-3 font-mono text-[11px] text-ash">Nothing on the list yet.</li>
                ) : null}
                {rows.map((row) => (
                  <li key={row.id} className="flex items-center gap-3 p-3">
                    <span
                      className={`min-w-0 flex-1 truncate text-sm ${
                        row.is_active ? "text-bone" : "text-ash line-through"
                      }`}
                    >
                      {row.name}
                    </span>
                    {!row.is_active ? (
                      <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-ash">
                        retired
                      </span>
                    ) : (
                      <button
                        type="button"
                        data-action={`lookup-${kind}-retire`}
                        disabled={busy === row.id}
                        onClick={() => retire(kind, row)}
                        className="shrink-0 border border-line px-3 py-1 font-mono text-[10px] uppercase tracking-[0.2em] text-ash transition hover:border-red-400/60 hover:text-bone disabled:opacity-40"
                      >
                        Retire
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </section>
  );
}

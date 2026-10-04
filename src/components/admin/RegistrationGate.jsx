/**
 * THE MASTER REGISTRATION GATE - the button.
 *
 * One switch that stops new registrations for the whole site, and says so on the
 * public pages.
 *
 * WHAT THIS IS NOT
 *
 * This is not the control. It is the HANDLE on the control: the row it writes
 * (site_settings.registrations_open) is read by enforce_registration_gate(), a
 * BEFORE INSERT trigger on registrations. Hiding this button - or the Register
 * button on the public site - would change nothing a determined participant
 * cannot already do with the public anon key. The trigger is the gate; this is
 * the thing a master looks at to know which way it is pointing.
 *
 * WHY IT SITS ABOVE THE ROSTER
 *
 * This is a site-wide switch with no event attached, so it has no natural row in
 * a per-event editor. It goes above the roster because the roster is what an
 * operator is looking at when somebody asks why the site stopped taking
 * registrations.
 *
 * WHY MASTER ONLY, TWICE OVER
 *
 * staff_set_registration_gate refuses anybody below master, and this renders the
 * control only for a master. Both are deliberate and they are not redundant: the
 * server refuses because the server is the boundary, and the UI hides it because a
 * visible button that always fails is worse than no button. An admin is told it
 * is master-only rather than shown nothing, so the absence is explained.
 */
import { useCallback, useEffect, useState } from "react";
import { staffRegistrationGate, staffSetRegistrationGate } from "../../data/staff.js";

export default function RegistrationGate({ token, isMaster, version, onChanged }) {
  const [gate, setGate] = useState(null);
  const [failed, setFailed] = useState(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState(null);

  const load = useCallback(() => {
    staffRegistrationGate(token).then((r) => {
      if (r.ok) {
        setGate(r);
        /* Seeded from the stored note only when the field is not being edited, so
           a half-typed sentence survives the reload that follows a save. */
        setNote((cur) => (cur && cur.trim() ? cur : r.note ?? ""));
        setFailed(null);
      } else {
        setFailed(r.error ?? "The gate could not be read.");
      }
    });
  }, [token]);

  /* `version` for the same reason FinanceStrip takes it: the console refreshes
     data this component does not know about, and a gate read once at mount is a
     gate that goes on lying about the state of the site. */
  useEffect(load, [load, version]);

  const flip = async (open) => {
    setBusy(true);
    setSaid(null);
    const r = await staffSetRegistrationGate(token, open, open ? null : note);
    setBusy(false);
    if (!r.ok) {
      setSaid({ ok: false, text: r.error });
      return;
    }
    /* Repaint from what the database stored, not from what was asked for. */
    setGate((g) => ({ ...g, ...r.gate, ok: true }));
    if (open) setNote("");
    setSaid({
      ok: true,
      text: open
        ? "Registration is open again."
        : "Registration is closed. New sign-ups are refused.",
    });
    onChanged?.();
  };

  if (failed) {
    return (
      <p className="mb-4 font-mono text-[11px] text-ash" data-action="gate-failed">
        Registration gate unavailable: {failed}
      </p>
    );
  }
  if (!gate) return null;

  const closed = gate.open === false;

  return (
    <div
      data-action="registration-gate"
      data-open={String(!closed)}
      className={
        "mb-5 border px-4 py-4 " +
        (closed ? "border-red-400/50 bg-red-500/10" : "border-line bg-void-raised")
      }
    >
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p
            className={
              "font-mono text-[10px] uppercase tracking-[0.3em] " +
              (closed ? "text-red-200" : "text-jade")
            }
          >
            Registration {closed ? "closed" : "open"}
          </p>
          <p className="mt-1 text-sm text-crystal/70">
            {closed
              ? gate.note || "New registrations are being refused."
              : "Participants can register for any event."}
          </p>
          {closed && gate.closedAt ? (
            /* Rendered in UTC, for the reason the announcements page does it: a
               gate closed at 11pm IST must not read as "yesterday" to somebody
               west of Greenwich. */
            <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.2em] text-ash">
              Closed{" "}
              {new Date(gate.closedAt).toLocaleString("en-GB", {
                day: "numeric",
                month: "short",
                hour: "2-digit",
                minute: "2-digit",
                timeZone: "UTC",
              })}{" "}
              UTC
            </p>
          ) : null}
        </div>

        {!isMaster ? (
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-ash">
            Only a master can change this
          </p>
        ) : closed ? (
          <button
            type="button"
            data-action="gate-open"
            disabled={busy}
            onClick={() => flip(true)}
            className="border border-jade/60 px-4 py-2 font-mono text-[11px] uppercase tracking-[0.2em] text-jade transition hover:bg-jade/10 disabled:opacity-50"
          >
            Reopen registration
          </button>
        ) : (
          <button
            type="button"
            data-action="gate-close"
            disabled={busy}
            onClick={() => flip(false)}
            className="border border-red-400/60 px-4 py-2 font-mono text-[11px] uppercase tracking-[0.2em] text-red-200 transition hover:bg-red-500/10 disabled:opacity-50"
          >
            Stop registrations
          </button>
        )}
      </div>

      {/* Only while open: the note is only ever used to close with. */}
      {!isMaster || closed ? null : (
        <div className="mt-4">
          <label
            className="block font-mono text-[10px] uppercase tracking-[0.3em] text-ash"
            htmlFor="gate-note"
          >
            Reason shown when closed
          </label>
          <input
            id="gate-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. The final list has closed. Email us if you still have a seat."
            className="mt-2 w-full border border-line bg-void-raised px-3 py-2 font-mono text-sm text-bone outline-none transition focus:border-violet-bright"
          />
          <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.2em] text-ash">
            Optional. Blank reads &ldquo;Registrations are closed.&rdquo;
          </p>
        </div>
      )}

      {said ? (
        <p role="status" className={"mt-3 font-mono text-[11px] " + (said.ok ? "text-jade" : "text-red-200")}>
          {said.text}
        </p>
      ) : null}
    </div>
  );
}

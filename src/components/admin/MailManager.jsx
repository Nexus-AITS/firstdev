/**
 * The Mail tab: a template editor with the merge fields, a bulk composer with the
 * filters that matter, and the queue log.
 *
 * TWO ROLES ON ONE SCREEN, separated deliberately. Writing a template is routine
 * and reversible. SENDING it to everybody who ever registered is not: once
 * Resend has accepted a hundred messages there is no undo. So the composer always
 * PREVIEWS first — it asks the database how many people the filter matches and
 * shows that number before anything is queued — and only a master gets the send
 * button at all.
 *
 * The preview is not a courtesy. staff_send_campaign is called twice: once with
 * p_confirm false, which COUNTS and stops, and once with it true. Somebody who
 * cannot see the blast radius before committing is somebody who sends to the
 * wrong slice of the roster.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
// Two levels up: components/admin -> components -> src. One level is
// components/admin -> components, where there is no data/ directory.
import { loadCatalogue } from "../../data/catalogue.js";
import {
  staffMailState,
  staffPreviewCampaign,
  staffRunMailSender,
  staffSendCampaign,
  staffUpsertTemplate,
} from "../../data/staff.js";

const input =
  "w-full border border-line bg-void-raised px-3 py-2 text-sm text-bone outline-none focus:border-lavender/60";
const label = "mb-1 block font-mono text-[10px] uppercase tracking-[0.25em] text-ash";

const blankTemplate = {
  id: null,
  name: "",
  subject: "",
  body: "",
  is_default: false,
  is_active: true,
};

const PAY_STATUSES = [
  ["awaiting_utr", "Awaiting UTR"],
  ["awaiting_cash", "Awaiting cash"],
  ["unverified", "Unverified"],
  ["verified", "Verified"],
  ["rejected", "Rejected"],
];

const STATUS_TONE = {
  sent: "text-jade",
  queued: "text-lavender",
  sending: "text-gold",
  failed: "text-red-300",
  expired: "text-ash",
};

export default function MailManager({ session }) {
  /* Self-loading, like ContactManager and DestinationManager: every other tab
     owns its own fetch rather than being handed a window, a pager and a reload,
     and a mail tab needing the roster's event list as well as its own state
     would have doubled that wiring for no gain. */
  const [state, setState] = useState({ fields: [], templates: [], jobs: [], counts: {} });
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const reload = useCallback(() => {
    let alive = true;
    setLoading(true);

    /* The two reads are INDEPENDENT and settled separately. Promise.all would
       discard the mail state if the catalogue fetch failed for any reason — and
       the visible result of that is a Mail tab with no templates, no merge fields
       and NO error anywhere, because the rejection skips the .then that sets it.
       The catalogue is only needed for the bulk event filter; a mail tab that
       cannot list events should still let a template be written. */
    Promise.allSettled([staffMailState(session.token, 50), loadCatalogue()]).then(
      ([mail, cat]) => {
        if (!alive) return;
        setLoading(false);

        if (mail.status === "fulfilled" && mail.value?.ok) {
          setState({
            fields: mail.value.fields ?? [],
            templates: mail.value.templates ?? [],
            jobs: mail.value.jobs ?? [],
            counts: mail.value.counts ?? {},
          });
          setError("");
        } else {
          const why =
            mail.status === "rejected"
              ? String(mail.reason?.message ?? mail.reason ?? "the request failed")
              : mail.value?.error;
          setError(why ?? "The mail tab could not be loaded.");
        }

        /* `events` is read defensively: loadCatalogue() returns
           { ok: true, cached: true } with NO events array on its cached path, so
           a naive `cat.events` silently produces an empty event filter — the
           dropdown would render with only "All events" and look like the
           catalogue has no events. */
        setEvents(Array.isArray(cat.value?.events) ? cat.value.events : []);
      }
    );
  }, [session.token]);

  useEffect(() => {
    reload();
  }, [reload]);

  // The four actions the screen performs, bound to the console's token. Held
  // here rather than on `session` so the component stays self-contained.
  const api = useMemo(
    () => ({
      upsertTemplate: (t) => staffUpsertTemplate(session.token, t),
      previewCampaign: (c) => staffPreviewCampaign(session.token, c),
      sendCampaign: (c) => staffSendCampaign(session.token, c),
      runSender: (opts) => staffRunMailSender(session.token, opts),
    }),
    [session.token]
  );

  const [template, setTemplate] = useState(blankTemplate);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [preview, setPreview] = useState(null);
  const [campaign, setCampaign] = useState({
    name: "",
    template_id: "",
    subject: "",
    body: "",
    event_id: "",
    status: "",
    method: "",
    college: "",
  });

  const isMaster = session.role === "master";
  const fields = state.fields ?? [];
  const templates = state.templates ?? [];
  const jobs = state.jobs ?? [];
  const counts = state.counts ?? {};

  const setT = (k) => (e) => setTemplate((t) => ({ ...t, [k]: e.target.value }));
  const setC = (k) => (e) => setCampaign((c) => ({ ...c, [k]: e.target.value }));

  /* Picking a template loads it into BOTH the editor and the composer. Two
     separate boxes that could disagree would let an operator send a bulk message
     from a template they are not looking at. */
  const pick = (t) => {
    setTemplate(t ? { ...blankTemplate, ...t } : blankTemplate);
    setCampaign((c) => ({
      ...c,
      template_id: t?.id ?? "",
      subject: t?.subject ?? "",
      body: t?.body ?? "",
    }));
  };

  /* Placeholders are INSERTED, not typed: the list is derived from the database
     (public.email_merge_fields), so the picker and the renderer cannot offer
     different fields and a typo cannot ship an email containing {{nmae}}. */
  const insert = (key) =>
    setTemplate((t) => ({ ...t, body: `${t.body}${t.body ? "\n" : ""}{{${key}}}` }));

  async function run(label, fn) {
    setBusy(true);
    setNotice(null);
    const result = await fn();
    setBusy(false);
    setNotice(
      result?.ok ? { kind: "ok", text: label } : { kind: "error", text: result?.error ?? error }
    );
    return result;
  }

  const saveTemplate = () =>
    run("Template saved.", () => api.upsertTemplate(template)).then((r) => {
      if (r?.ok) reload();
      return r;
    });

  const countAudience = () =>
    run("", () => api.previewCampaign(campaign)).then((r) => {
      if (r?.ok) setPreview(r.recipients ?? 0);
      return r;
    });

  const queueSend = () => {
    const n = preview ?? 0;
    // The confirm NAMES the number: "send?" beside a button that reaches 180
    // people is a question with no scale attached to it.
    if (!window.confirm(`Queue this for ${n} recipient${n === 1 ? "" : "s"}? This cannot be undone.`)) {
      return;
    }
    run("Queued. Run the sender to deliver it.", () => api.sendCampaign(campaign)).then((r) => {
      if (r?.ok) {
        setPreview(null);
        reload();
      }
      return r;
    });
  };
return (
    <section data-action="mail-manager">
      <div className="mb-5 flex flex-wrap items-center gap-5">
        <h2 className="font-display text-xl tracking-[0.14em] text-crystal">MAIL</h2>
        <ul className="flex flex-wrap gap-4 font-mono text-[11px] uppercase tracking-[0.2em]">
          {[
            ["queued", counts.queued, "text-lavender"],
            ["sending", counts.sending, "text-gold"],
            ["sent", counts.sent, "text-jade"],
            ["failed", counts.failed, "text-red-300"],
          ].map(([k, v, tone]) => (
            <li key={k} className={tone}>
              {k} {v ?? 0}
            </li>
          ))}
        </ul>
        <button
          type="button"
          data-action="mail-run-sender"
          disabled={busy}
          onClick={() => run("Sender run finished.", () => api.runSender()).then((r) => r?.ok && reload())}
          className="border border-line px-3 py-2 font-mono text-[10px] uppercase tracking-[0.2em] text-ash transition hover:border-lavender/50 disabled:opacity-50"
        >
          Run the sender now
        </button>
        {!isMaster ? (
          <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-ash">
            Templates only — sending to the roster is a master action
          </p>
        ) : null}
      </div>

{loading ? (
        <p className="mb-4 font-mono text-[11px] uppercase tracking-[0.25em] text-ash">
          Loading mail…
        </p>
      ) : null}

      {/* The error is shown INSTEAD of the composer, not above it. A mail tab that
          failed to load its templates must not offer a send button: the operator
          would be composing against nothing and queueing to an audience they
          cannot count. */}
      {error && !loading ? (
        <p role="alert" className="mb-4 border border-red-400/40 px-4 py-3 text-sm text-red-200">
          {error}
        </p>
      ) : null}

      {notice ? (
        <p
          role="status"
          className={`mb-4 border px-4 py-3 text-sm ${
            notice.kind === "ok"
              ? "border-lavender/30 text-crystal/80"
              : "border-red-400/40 text-red-200"
          }`}
        >
          {notice.text}
        </p>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
        <div className="border border-line p-4">
          <p className={label}>Templates</p>
          <ul className="mt-2 space-y-1">
            <li>
              <button
                type="button"
                onClick={() => pick(null)}
                className="w-full border border-line px-3 py-2 text-left font-mono text-[11px] uppercase tracking-[0.2em] text-ash transition hover:border-lavender/50"
              >
                + New
              </button>
            </li>
            {templates.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  data-action={`mail-template-${t.id}`}
                  onClick={() => pick(t)}
                  className={`w-full border px-3 py-2 text-left text-sm transition ${
                    template.id === t.id
                      ? "border-lavender/70 text-crystal"
                      : "border-line text-ash hover:border-lavender/50"
                  }`}
                >
                  {t.name}
                  {t.is_default ? (
                    <span className="ml-2 font-mono text-[10px] uppercase text-gold">default</span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div className="space-y-6">
          <div className="border border-line p-4">
            <p className={label}>Template</p>
            <div className="grid gap-3">
              <input data-edit-field="name" value={template.name} onChange={setT("name")} placeholder="Payment verified" className={input} />
              <input data-edit-field="subject" value={template.subject} onChange={setT("subject")} placeholder="Subject — {{name}} works here too" className={input} />
              <textarea
                data-edit-field="body"
                value={template.body}
                onChange={setT("body")}
                rows={9}
                placeholder="Hello {{name}},"
                className={`${input} font-mono text-[13px]`}
              />
            </div>

            <p className={`${label} mt-3`}>Merge fields</p>
            <ul className="flex flex-wrap gap-2">
              {fields.map((f) => (
                <li key={f.key}>
                  <button
                    type="button"
                    data-action={`mail-field-${f.key}`}
                    onClick={() => insert(f.key)}
                    title={`{{${f.key}}}`}
                    className="border border-lavender/40 px-2 py-1 font-mono text-[10px] text-lavender transition hover:border-lavender"
                  >
                    {f.label}
                  </button>
                </li>
              ))}
            </ul>

            <label className="mt-3 flex items-center gap-2 font-mono text-[11px] text-ash">
              <input
                type="checkbox"
                data-action="mail-default"
                checked={!!template.is_default}
                onChange={(e) => setTemplate((t) => ({ ...t, is_default: e.target.checked }))}
              />
              Send this when a registration is verified
            </label>

            <button
              type="button"
              data-action="mail-save"
              disabled={busy}
              onClick={saveTemplate}
              className="mt-4 border border-violet-bright/60 px-4 py-2 font-mono text-[11px] uppercase tracking-[0.2em] text-bone transition hover:border-violet-bright disabled:opacity-50"
            >
              Save template
            </button>
          </div>
{isMaster ? (
            <div className="border border-line p-4">
              <p className={label}>Bulk send</p>
              <div className="grid gap-3 sm:grid-cols-2">
                <input value={campaign.name} onChange={setC("name")} placeholder="What is this send about" className={input} />
                <select
                  value={campaign.template_id}
                  onChange={(e) => pick(templates.find((t) => t.id === e.target.value))}
                  className={input}
                >
                  <option value="">— pick a template —</option>
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
                {/* The three filters an ops lead actually asks in: which event,
                    whether it is paid, and how the money arrived. Each optional,
                    all combined with AND. */}
                <select value={campaign.event_id} onChange={setC("event_id")} className={input}>
                  <option value="">All events</option>
                  {(state.events ?? events ?? []).map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.title}
                    </option>
                  ))}
                </select>
                <select value={campaign.status} onChange={setC("status")} className={input}>
                  <option value="">Any payment status</option>
                  {PAY_STATUSES.map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
                <select value={campaign.method} onChange={setC("method")} className={input}>
                  <option value="">Any payment method</option>
                  <option value="utr">UPI / UTR</option>
                  <option value="cash">Cash</option>
                </select>
                <input value={campaign.college} onChange={setC("college")} placeholder="Any college" className={input} />
              </div>
              <input value={campaign.subject} onChange={setC("subject")} placeholder="Subject (from the template)" className={`${input} mt-3`} />
              <textarea
                value={campaign.body}
                onChange={setC("body")}
                rows={6}
                placeholder="Body (from the template)"
                className={`${input} mt-3 font-mono text-[13px]`}
              />

              <div className="mt-4 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  data-action="mail-preview"
                  disabled={busy}
                  onClick={countAudience}
                  className="border border-line px-4 py-2 font-mono text-[11px] uppercase tracking-[0.2em] text-ash transition hover:border-lavender/50 disabled:opacity-50"
                >
                  Preview recipients
                </button>
                {preview !== null ? (
                  <>
                    <span className="font-mono text-xs text-crystal/80">
                      {preview} recipient{preview === 1 ? "" : "s"}
                    </span>
                    <button
                      type="button"
                      data-action="mail-send"
                      disabled={busy || preview === 0}
                      onClick={queueSend}
                      className="border border-gold/60 px-4 py-2 font-mono text-[11px] uppercase tracking-[0.2em] text-gold transition hover:border-gold disabled:opacity-50"
                    >
                      Queue the send
                    </button>
                  </>
                ) : null}
              </div>
            </div>
          ) : null}

          <div className="border border-line p-4">
            <p className={label}>Recent messages</p>
            <ul className="mt-2 space-y-2">
              {jobs.length === 0 ? (
                <li className="font-mono text-[11px] text-ash">Nothing queued or sent yet.</li>
              ) : (
                jobs.map((j) => (
                  <li key={j.id} className="border-b border-line/50 pb-2 font-mono text-[11px]">
                    <span className={STATUS_TONE[j.status] ?? "text-ash"}>{j.status}</span>{" "}
                    <span className="text-crystal/70">{j.to_email}</span>
                    {j.attempts > 1 ? (
                      <span className="text-ash"> · attempt {j.attempts}</span>
                    ) : null}
                    {j.last_error ? (
                      <span className="block text-red-300/80">{j.last_error}</span>
                    ) : null}
                  </li>
                ))
              )}
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}
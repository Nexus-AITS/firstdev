/**
 * Where the roster is sent, and the keys that read it.
 *
 * Two things an operator needs that the rest of the console has no home for:
 *
 *   1. DESTINATIONS — paste a dashboard's endpoint plus its API secret, press
 *      SEND, and see what the destination answered. The secret is write-only: it
 *      goes to supabase_vault on save and is never rendered again, because there
 *      is nothing to render — only a masked preview comes back.
 *
 *   2. API KEYS — mint a credential a partner system can read the roster with.
 *      The plaintext is shown exactly once, at creation, for the same reason.
 *
 * WHY THE PUSH GOES TO A SERVERLESS FUNCTION
 *
 * The database has no pg_net on this project, so it cannot make the request. It
 * also should not hold the secret in a table: a destination's live API key is
 * outbound, which means it has to be recoverable, and "recoverable in a column"
 * is exactly what supabase_vault is for. /api/push-registrations asks the
 * database what to send, then delivers it.
 *
 * So this console tab is deliberately not a place where a third-party credential
 * is ever visible. It sends a destination id and gets back a status. That is a
 * security property, not an accident of the layout.
 */
import { useCallback, useEffect, useState } from "react";
import {
  loadPublicCatalogue,
  can as roleCan,
  staffDeleteDestination,
  staffListApiKeys,
  staffListDestinations,
  staffMintApiKey,
  staffPushRegistrations,
  staffRevokeApiKey,
  staffSetDashboardUrl,
  staffUpsertDestination,
} from "../../data/staff.js";

const inputClass =
  "w-full border border-line bg-void-raised px-3 py-2 font-mono text-sm text-bone outline-none transition focus:border-violet-bright";
const labelClass = "block font-mono text-[11px] uppercase tracking-[0.3em] text-ash";
const buttonClass =
  "border border-violet-bright/60 px-4 py-2 font-mono text-[11px] uppercase tracking-[0.2em] text-bone transition hover:bg-violet-bright/20 disabled:opacity-50";

const emptyDestination = {
  id: null,
  name: "",
  url: "",
  auth_header: "Authorization",
  auth_prefix: "Bearer ",
  api_secret: "",
  event_id: "",
  only_verified: true,
  is_active: true,
};

function Banner({ kind = "error", children }) {
  if (!children) return null;
  const tone =
    kind === "ok"
      ? "border-jade/50 bg-jade/10 text-jade"
      : "border-ember/50 bg-ember/10 text-ember";
  return (
    <p role="status" className={`border px-3 py-2 text-sm ${tone}`}>
      {children}
    </p>
  );
}

export default function DestinationManager({ session }) {
  const { token } = session;
  /* "manage_catalogue" is the master-only capability, reused here as the test
     for "may change where the roster goes". "manage_contacts" is the admin+
     capability, which covers reading the list and setting the dashboard link.
     The database re-checks both inside every RPC — the UI only decides what to
     show, never what is allowed. */
  const isMaster = roleCan(session.role, "manage_catalogue");
  const canEdit = roleCan(session.role, "manage_contacts");

  const [destinations, setDestinations] = useState([]);
  const [keys, setKeys] = useState([]);
  const [events, setEvents] = useState([]);
  const [form, setForm] = useState(emptyDestination);
  const [keyName, setKeyName] = useState("");
  const [keyScope, setKeyScope] = useState("read:verified");
  const [minted, setMinted] = useState(null);
  const [dashboard, setDashboard] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [ok, setOk] = useState(null);

  const set = (k) => (e) =>
    setForm((f) => ({
      ...f,
      [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value,
    }));

  const refresh = useCallback(async () => {
    const [dests, apiKeys, catalogue] = await Promise.all([
      staffListDestinations(token),
      staffListApiKeys(token),
      loadPublicCatalogue(),
    ]);
    setDestinations(dests.destinations ?? []);
    setKeys(apiKeys.keys ?? []);
    setEvents((catalogue?.events ?? []).map((e) => ({ value: e.id, label: e.title })));
  }, [token]);

  useEffect(() => {
    refresh().catch(() => {});
  }, [refresh]);

  async function save() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setOk(null);
    const result = await staffUpsertDestination(
      {
        id: form.id,
        name: form.name,
        url: form.url,
        auth_header: form.auth_header,
        auth_prefix: form.auth_prefix,
        // A blank secret on an edit means "keep the stored one" — see the RPC.
        api_secret: form.api_secret || null,
        event_id: form.event_id || null,
        only_verified: form.only_verified,
        is_active: form.is_active,
      },
      token
    );
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setForm(emptyDestination);
    setOk("Destination saved.");
    await refresh();
  }

  async function push(id) {
    if (busy) return;
    setBusy(true);
    setError(null);
    setOk(null);
    const result = await staffPushRegistrations(id, token);
    setBusy(false);
    if (!result.ok) {
      // The destination's own words, where there are any: "unauthorised" tells
      // an operator far more than "the send failed".
      setError(`${result.error}${result.status ? ` (HTTP ${result.status})` : ""}`);
    } else {
      setOk(
        `Sent ${result.count} registration(s). The destination answered HTTP ${result.status}.`
      );
    }
    await refresh();
  }

  async function remove(id) {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await staffDeleteDestination(id, token);
    setBusy(false);
    if (!result.ok) setError(result.error);
    await refresh();
  }

  async function mint() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setMinted(null);
    const result = await staffMintApiKey({ name: keyName, scopes: [keyScope] }, token);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setMinted(result.key);
    setKeyName("");
    await refresh();
  }

  async function revoke(id) {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await staffRevokeApiKey(id, token);
    setBusy(false);
    if (!result.ok) setError(result.error);
    await refresh();
  }

  async function saveDashboard(e) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await staffSetDashboardUrl(dashboard, token);
    setBusy(false);
    if (!result.ok) setError(result.error);
    else setOk("Dashboard link saved.");
  }


  return (
    <div className="flex flex-col gap-8">
      {error ? <Banner>{error}</Banner> : null}
      {ok ? <Banner kind="ok">{ok}</Banner> : null}

      <section>
        <h3 className="font-mono text-sm uppercase tracking-[0.3em] text-violet-bright">
          Destinations
        </h3>
        <p className="mt-2 max-w-2xl text-sm text-ash">
          Send the registration roster to another system. The secret is stored in
          the database&apos;s vault and is never shown again — only a masked
          preview comes back.
        </p>

        <ul className="mt-4 flex flex-col gap-3">
          {destinations.length === 0 ? (
            <li className="border border-line bg-void-raised px-3 py-3 font-mono text-sm text-ash">
              No destinations yet.
            </li>
          ) : null}
          {destinations.map((d) => (
            <li key={d.id} className="border border-line bg-void-raised px-3 py-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-mono text-sm text-bone">
                    {d.name}
                    {!d.is_active ? (
                      <span className="ml-2 text-[10px] uppercase tracking-[0.2em] text-ash">
                        switched off
                      </span>
                    ) : null}
                  </p>
                  <p className="truncate font-mono text-[11px] text-ash">{d.url}</p>
                  <p className="mt-1 font-mono text-[10px] text-ash">
                    {d.has_secret
                      ? `secret ${d.secret_preview ?? "(set)"} · ${d.auth_header}`
                      : "no secret"}{" "}
                    · {d.only_verified ? "verified only" : "includes unpaid"} ·{" "}
                    {d.event_id ? `event: ${d.event_id}` : "all events"}
                  </p>
                  {d.last_push_at ? (
                    <p className="mt-1 font-mono text-[10px] text-ash">
                      last send {String(d.last_push_at).slice(0, 16).replace("T", " ")} → HTTP{" "}
                      {d.last_push_status ?? "—"}
                      {d.last_push_count != null ? ` · ${d.last_push_count} sent` : ""}
                    </p>
                  ) : null}
                  {d.last_push_error ? (
                    <p className="mt-1 font-mono text-[10px] text-ember">{d.last_push_error}</p>
                  ) : null}
                </div>
                <div className="flex shrink-0 gap-2">
                  <button type="button" className={buttonClass} onClick={() => push(d.id)} disabled={busy}>
                    Send now
                  </button>
                  <button
                    type="button"
                    className={buttonClass}
                    onClick={() =>
                      setForm({
                        id: d.id,
                        name: d.name,
                        url: d.url,
                        auth_header: d.auth_header,
                        auth_prefix: d.auth_prefix,
                        api_secret: "",
                        event_id: d.event_id ?? "",
                        only_verified: d.only_verified,
                        is_active: d.is_active,
                      })
                    }
                  >
                    Edit
                  </button>
                  {isMaster ? (
                    <button type="button" className={buttonClass} onClick={() => remove(d.id)} disabled={busy}>
                      Remove
                    </button>
                  ) : null}
                </div>
              </div>
            </li>
          ))}
        </ul>


        {canEdit ? (
          <div className="mt-4 grid gap-3 border border-line bg-void-raised p-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <label className={labelClass} htmlFor="dest-name">Name</label>
              <input id="dest-name" className={`mt-1 ${inputClass}`} value={form.name} onChange={set("name")} placeholder="Hackathon results site" />
            </div>
            <div className="sm:col-span-2">
              <label className={labelClass} htmlFor="dest-url">Destination URL</label>
              <input id="dest-url" type="url" className={`mt-1 ${inputClass}`} value={form.url} onChange={set("url")} placeholder="https://example.com/api/registrations" />
            </div>
            <div>
              <label className={labelClass} htmlFor="dest-secret">API secret (write-only)</label>
              <input id="dest-secret" type="password" autoComplete="new-password" className={`mt-1 ${inputClass}`} value={form.api_secret} onChange={set("api_secret")} placeholder={form.id ? "Leave blank to keep the stored secret" : "sk_live_…"} />
            </div>
            <div>
              <label className={labelClass} htmlFor="dest-header">Auth header</label>
              <input id="dest-header" className={`mt-1 ${inputClass}`} value={form.auth_header} onChange={set("auth_header")} placeholder="Authorization" />
            </div>
            <div>
              <label className={labelClass} htmlFor="dest-prefix">Value prefix</label>
              <input id="dest-prefix" className={`mt-1 ${inputClass}`} value={form.auth_prefix} onChange={set("auth_prefix")} placeholder="Bearer " />
            </div>
            <div>
              <label className={labelClass} htmlFor="dest-event">Limit to one event</label>
              <select id="dest-event" className={`mt-1 ${inputClass}`} value={form.event_id} onChange={set("event_id")}>
                <option value="">All events</option>
                {events.map((e) => (
                  <option key={e.value} value={e.value}>{e.label}</option>
                ))}
              </select>
            </div>
            <div className="flex items-end gap-4">
              <label className="flex items-center gap-2 font-mono text-[11px] text-bone">
                <input type="checkbox" checked={form.only_verified} onChange={set("only_verified")} />
                Verified payments only
              </label>
              <label className="flex items-center gap-2 font-mono text-[11px] text-bone">
                <input type="checkbox" checked={form.is_active} onChange={set("is_active")} />
                Active
              </label>
            </div>
            <div className="sm:col-span-2">
              <button type="button" className={buttonClass} onClick={save} disabled={busy}>
                {form.id ? "Save changes" : "Add destination"}
              </button>
            </div>
          </div>
        ) : null}
      </section>

      {/* ---------- the participant's onward link ---------- */}
      {canEdit ? (
        <section>
          <h3 className="font-mono text-sm uppercase tracking-[0.3em] text-violet-bright">
            Continue with dashboard
          </h3>
          <p className="mt-2 max-w-2xl text-sm text-ash">
            Where a participant continues once their payment is verified. An
            event&apos;s own team link is used first when it has one; this is the
            site-wide default.
          </p>
          <form className="mt-3 flex flex-wrap items-end gap-3" onSubmit={saveDashboard}>
            <div className="min-w-[18rem] flex-1">
              <label className={labelClass} htmlFor="dash-url">Dashboard URL</label>
              <input id="dash-url" type="url" className={`mt-1 ${inputClass}`} value={dashboard} onChange={(e) => setDashboard(e.target.value)} placeholder="https://…" />
            </div>
            <button type="submit" className={buttonClass} disabled={busy}>Save link</button>
          </form>
        </section>
      ) : null}


      {/* ---------- partner API keys ---------- */}
      {isMaster ? (
        <section>
          <h3 className="font-mono text-sm uppercase tracking-[0.3em] text-violet-bright">
            Partner API keys
          </h3>
          <p className="mt-2 max-w-2xl text-sm text-ash">
            A key lets an external system read the roster over{" "}
            <code className="text-bone">GET /api/registrations</code>. Only a hash
            is stored, so a key shown here once cannot be shown again.
          </p>

          {minted ? (
            <div className="mt-3 border border-jade/50 bg-jade/10 p-3">
              <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-jade">
                Copy this now — it is not recoverable
              </p>
              <code className="mt-2 block break-all font-mono text-sm text-bone">{minted}</code>
              <button type="button" className={`mt-2 ${buttonClass}`} onClick={() => setMinted(null)}>
                I have copied it
              </button>
            </div>
          ) : null}

          <div className="mt-3 flex flex-wrap items-end gap-3">
            <div>
              <label className={labelClass} htmlFor="key-name">Key name</label>
              <input id="key-name" className={`mt-1 ${inputClass}`} value={keyName} onChange={(e) => setKeyName(e.target.value)} placeholder="Hackathon site" />
            </div>
            <div>
              <label className={labelClass} htmlFor="key-scope">Scope</label>
              <select id="key-scope" className={`mt-1 ${inputClass}`} value={keyScope} onChange={(e) => setKeyScope(e.target.value)}>
                <option value="read:verified">Verified participants only</option>
                <option value="read:all">Everyone, including unpaid</option>
              </select>
            </div>
            <button type="button" className={buttonClass} onClick={mint} disabled={busy}>
              Create key
            </button>
          </div>

          <ul className="mt-4 flex flex-col gap-2">
            {keys.map((k) => (
              <li key={k.id} className="flex flex-wrap items-center justify-between gap-3 border border-line bg-void-raised px-3 py-2">
                <div>
                  <p className="font-mono text-sm text-bone">{k.name}</p>
                  <p className="font-mono text-[10px] text-ash">
                    {k.key_prefix}… · {(k.scopes ?? []).join(", ")} ·{" "}
                    {k.is_active
                      ? k.last_used_at
                        ? `last used ${String(k.last_used_at).slice(0, 10)}`
                        : "never used"
                      : "revoked"}
                  </p>
                </div>
                {k.is_active ? (
                  <button type="button" className={buttonClass} onClick={() => revoke(k.id)} disabled={busy}>
                    Revoke
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}


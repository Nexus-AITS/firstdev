/**
 * Staff authentication — deliberately separate from the participant's Supabase
 * Auth session.
 *
 * The participant signs in with Google and gets a Supabase session. Staff sign in
 * with a username and password and get an OPAQUE TOKEN that lives only in this
 * module. They share no table, no session store and no identity provider, so
 * there is no path by which a Google login reaches the roster — which is exactly
 * what "no social login on the admin page" has to mean to be worth anything.
 *
 * Consequence worth stating: staff requests run as the `anon` database role and
 * carry their identity in the X-Nexus-Staff-Token header. RLS resolves that
 * header to a staff row on every request, so a 60-minute session really expires
 * in 60 minutes — the browser cannot extend it, because it has nothing to
 * extend. The token is only a pointer; the session row is the truth.
 *
 * The token is kept in sessionStorage, not localStorage: closing the tab signs
 * the operator out, which is the behaviour an unattended desk needs.
 */
import { getAuthClient } from "../config/supabase.js";

const TOKEN_KEY = "nexus.staff.token.v1";
/** Used only to render a countdown; the database is the authority on expiry. */
const EXPIRY_KEY = "nexus.staff.expires.v1";

export const ROLE_META = {
  master: {
    label: "Master administrator",
    can: [
      "read",
      "verify",
      "reject",
      "remove",
      "manage_staff",
      "edit_pricing",
      "view_audit",
      "manage_catalogue",
      "manage_contacts",
      // PERMANENT removal. Its own capability rather than a reuse of "remove",
      // which is the roster's soft delete: keeping them apart means a master can
      // be given the one without the other, and the UI can say "delete" only
      // where the database's staff_at_least('master') check will agree. The two
      // must be changed together - if you widen this, widen the RPC too.
      "delete_catalogue",
    ],
    blurb:
      "Full control: verify or reject payments, remove registrations, manage staff, set prices, edit the event and bundle catalogue, and permanently delete an event, bundle or contact that was never real.",
  },
  admin: {
    label: "Administrator",
    // Contact details are ADMIN+, not master-only: they are what a participant
    // reads when something has gone wrong, and the team that verifies payments
    // is the team that answers the phone. Matches the RPC's own
    // staff_at_least('admin') gate — if you want masters only, change both.
    // No "delete_catalogue": an admin may publish a channel and retire it, but
    // erasing one is a master's decision.
    can: ["read", "verify", "reject", "view_audit", "manage_contacts"],
    blurb:
      "Accept or reject participants, review the audit log, and publish the contact details on the public contact page. Cannot remove registrations, manage staff, change prices, or delete anything.",
  },
  coordinator: {
    label: "Coordinator",
    can: ["read"],
    blurb: "Read and search the roster. Cannot change anything.",
  },
};

/** Single place the UI asks "may this role do that?" — the DB enforces it too. */
export const can = (role, action) => Boolean(ROLE_META[role]?.can.includes(action));

/* ---------- token storage ---------- */

function readStored() {
  try {
    const token = sessionStorage.getItem(TOKEN_KEY);
    const expiresAt = Number(sessionStorage.getItem(EXPIRY_KEY) || 0);
    return token ? { token, expiresAt } : null;
  } catch {
    // Private mode / storage disabled — the session simply will not persist
    // across a reload, which is the safer failure.
    return null;
  }
}

function writeStored(token, expiresAt) {
  try {
    sessionStorage.setItem(TOKEN_KEY, token);
    sessionStorage.setItem(EXPIRY_KEY, String(expiresAt));
  } catch {
    /* non-fatal: the session lives in memory for this page load */
  }
}

function clearStored() {
  try {
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(EXPIRY_KEY);
  } catch {
    /* nothing to clear */
  }
}

/** In-memory mirror so reads are synchronous and React can subscribe. */
let current = readStored();
const listeners = new Set();

function publish(next) {
  current = next;
  for (const fn of listeners) fn(next);
}

export function subscribeStaff(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export const getStoredStaff = () => current;

/* ---------- requests ---------- */

/**
 * Call PostgREST as a staff member.
 *
 * The staff token rides as a custom header; the anon key is still required
 * because that is the only key the browser has, and it grants nothing on its
 * own — RLS is the gate.
 *
 * Exported because pricing.js reuses it for the PUBLIC pricing read: a price
 * needs no session, so it passes `staffToken: null` and relies on the pricing
 * table's public SELECT policy. That is the one place outside the console that
 * touches this transport, and it is why the function is named for what it does
 * rather than for the console it was written for.
 */
export async function staffFetch(path, { method = "GET", body, staffToken, headers = {} } = {}) {
  const supabase = await getAuthClient();
  if (!supabase) {
    return { ok: false, status: 0, data: null, error: "The NEXUS database is not configured." };
  }
  const token = staffToken === undefined ? current?.token : staffToken;
  const res = await fetch(`${supabase.supabaseUrl}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: supabase.supabaseKey,
      Authorization: `Bearer ${supabase.supabaseKey}`,
      ...(token ? { "X-Nexus-Staff-Token": token } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { ok: res.ok, status: res.status, data, headers: res.headers, error: res.ok ? null : data };
}

async function rpc(name, params, staffToken) {
  const res = await staffFetch(`rpc/${name}`, { method: "POST", body: params, staffToken });
  // `ok` is the OPERATION's outcome, not the HTTP envelope's.
  //
  // Every staff_* RPC reports a refusal by returning HTTP 200 with a body of
  // {"ok": false, "error": "..."} - a raised exception would be a 4xx. That is
  // the right shape: "you are not a master", "no active event called X" and
  // "another live bundle already offers exactly this" are all answers, not
  // transport failures, and the message is written for the operator.
  //
  // Keying on the HTTP status alone reported success for a save the database
  // threw away: the console said a new bundle was created, cleared the form,
  // and reloaded - and nothing was in the database. Every refusal path in the
  // console went through that. The body is the authority; the status only says
  // whether we got far enough to read it.
  const body = res.data;
  const refused = body !== null && typeof body === "object" && body.ok === false;
  return { ok: res.ok && !refused, body, status: res.status };
}

/**
 * The shared client, for the handful of calls that run as the PARTICIPANT.
 *
 * Kept separate from staffFetch on purpose. staffFetch sends the anon key and an
 * X-Nexus-Staff-Token header; the participant's identity comes from the Supabase
 * Auth session, which the client attaches on its own. A call that needs the
 * participant therefore has to go through the SDK rather than raw fetch, or the
 * database sees an anonymous caller and refuses it.
 */
async function participantClient() {
  const supabase = await getAuthClient();
  if (!supabase) return { error: "The NEXUS database is not reachable from this deployment." };
  return { supabase };
}


/* ---------- the session API ---------- */

/**
 * Sign in. Returns { ok } or { ok: false, error } with a message safe to show —
 * the database answers identically for an unknown username and a wrong
 * password, so this form is not a username oracle.
 */
export async function staffLogin(username, password) {
  const result = await rpc("staff_login", {
    p_username: String(username ?? "").trim(),
    p_password: String(password ?? ""),
    p_agent: typeof navigator === "undefined" ? null : navigator.userAgent,
  });

  if (!result.body?.ok) {
    return { ok: false, error: result.body?.error ?? "Sign-in failed. Try again." };
  }

  const session = {
    token: result.body.token,
    username: result.body.username,
    fullName: result.body.full_name || result.body.username,
    role: result.body.role,
    expiresAt: new Date(result.body.expires_at).getTime(),
  };
  writeStored(session.token, session.expiresAt);
  publish(session);
  return { ok: true, session };
}

/** Sign out. Revokes this session server-side, so the token dies immediately. */
export async function staffLogout() {
  await rpc("staff_logout", {});
  clearStored();
  publish(null);
  return { ok: true };
}

/**
 * Re-resolve the stored token against the database.
 *
 * Called on mount so a page reload does not blindly trust sessionStorage: the
 * token might have expired, been revoked, or belong to a since-deactivated
 * account. The database is asked, not assumed.
 */
export async function staffResume() {
  if (!current?.token) return { ok: false, session: null };
  const res = await rpc("staff_session", {});
  const rows = Array.isArray(res.body) ? res.body : [];
  if (!rows.length) {
    clearStored();
    publish(null);
    return { ok: false, session: null };
  }
  const row = rows[0];
  const session = {
    token: current.token,
    username: row.username,
    fullName: row.full_name || row.username,
    role: row.role,
    expiresAt: new Date(row.expires_at).getTime(),
  };
  writeStored(session.token, session.expiresAt);
  publish(session);
  return { ok: true, session };
}

/** Milliseconds left, or 0. Drives the countdown; the DB enforces the real end. */
export function staffMsRemaining(now = Date.now()) {
  if (!current) return 0;
  return Math.max(0, current.expiresAt - now);
}

/* ---------- data ---------- */

/** Rows are a window onto a table, never the table. PostgREST caps a response
 *  at `max-rows`; without a Range header every list below would silently stop
 *  at that cap and an operator would read "this is all of them" as truth. */
export const DEFAULT_PAGE_SIZE = 25;
/** Guards the pager: a page size is operator input like any other, and an
 *  unbounded one is the same mistake this whole layer exists to remove. */
export const MAX_PAGE_SIZE = 200;
/** The sizes the console offers. 200 is included so the pricing tab can ask for
 *  a single window covering the whole catalogue. */
export const PAGE_SIZES = [10, 25, 50, 100, 200];

/** Quote a value so PostgREST treats it as one literal.
 *
 *  Without the quotes a search term containing a comma or a bracket is parsed
 *  as filter syntax: typing `Ann,Smith` would silently become two predicates
 *  instead of one search. Backslashes and double quotes are escaped, and the
 *  whole filter is then URL-encoded by `qs()` below, which is also what keeps
 *  the `%` wildcards in `ilike` from being mangled in transit — Cloudflare
 *  answers an unencoded `%` with a 500 error page before PostgREST sees it. */
function q(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Compose `?select=...&order=...` with optional server-side filters.
 *  Every filter is a server-side predicate on purpose: filtering 200 rows in
 *  the browser and then paging them would page a *filtered client list*, so
 *  page 2 would silently be page 2 of the wrong set. */
function qs(select, order, filters = {}) {
  const params = new URLSearchParams();
  params.set("select", select);
  if (order) params.set("order", order);
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null || value === "" || value === "all") continue;
    params.set(key, value);
  }
  return params.toString();
}

/** Ask PostgREST for the exact total alongside the page. `Prefer: count=exact`
 *  makes it return `Content-Range: 0-24/137`, so the pager knows how many pages
 *  exist without a second round trip. */
function withCount(res) {
  const range = res.headers?.get?.("Content-Range") ?? "";
  const total = Number(range.split("/")[1]);
  return Number.isFinite(total) ? total : null;
}

/** Shared shape: one page of rows plus the total that matches the filters.
 *  `page` is 1-based because that is what a human reads off the pager, and
 *  `pageCount` keeps the arithmetic out of every tab. */
function paged(res, { page, pageSize, empty = [] }) {
  // 416 is PostgREST's "Range Not Satisfiable": the requested window starts
  // past the end of the result set. That is not a failure to report, it is the
  // honest answer to "what is on page 99" — which is nothing. Treating it as an
  // error would paint the console red after a delete emptied the last page.
  if (!res.ok && res.status !== 416) {
    return { ok: false, data: empty, total: null, page, pageSize, pageCount: 1, error: res.error };
  }
  const rows = Array.isArray(res.data) ? res.data : [];
  const total = withCount(res);
  // A count we do not have is not the same as a count of zero: fall back to
  // "there may be more" so the pager stays usable rather than lying.
  const pageCount = total == null ? 1 : Math.max(1, Math.ceil(total / pageSize));
  return { ok: true, data: rows, total, page, pageSize, pageCount, error: null };
}

/** Clamp operator input into something a database should be asked for. */
export function normalizePage({ page = 1, pageSize = DEFAULT_PAGE_SIZE } = {}) {
  const size = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(pageSize) || DEFAULT_PAGE_SIZE));
  const n = Math.max(1, Number(page) || 1);
  return { page: n, pageSize: size };
}

export async function staffListRegistrations(token, options = {}) {
  const { page, pageSize } = normalizePage(options);
  const { query, status, event, fromDate, toDate } = options;
  const term = String(query ?? "").trim();

  const filters = {};
  if (status && status !== "all") filters.payment_status = `eq.${status}`;

  /* The event filter is a real JOIN, not a LIKE on the free-text
     purchase_label. The label is prose the browser wrote, and matching on prose
     is how a filter starts lying about who is in a room: bundle #01 and #02
     both contain NEXUS BREACH, so a text search would return everyone who
     bought either.

     `!inner` in the select below is what makes the JOIN drop non-matching
     parents; filtering on `registration_events.event_id` is what makes it
     selective. A plain (left) embed would filter the CHILD and still return
     every parent with a null child array — i.e. the whole roster, unchanged. */
  if (event && event !== "all") {
    filters["registration_events.event_id"] = `eq.${event}`;
  }

  /* Day boundaries, in Asia/Kolkata, because that is the event's own timezone.
     A UTC `created_at=gte` would cut the day at 05:30 IST and quietly drop
     everyone who registered between midnight and half past five — which is
     exactly the row someone is chasing at 9am. `<input type="date">` gives
     YYYY-MM-DD, so the offset is appended here rather than in the view.

     The two bounds go into ONE `and=(...)` group. They cannot be two separate
     `created_at` params: URLSearchParams.set on the same key overwrites, so the
     second bound would silently replace the first and the range would collapse
     to a single instant. */
  const range = [];
  if (fromDate) range.push(`created_at.gte.${fromDate}T00:00:00+05:30`);
  // `to` is INCLUSIVE, so the last day needs its own end-of-day bound. An `lte`
  // on a midnight timestamp would include almost nothing from that day.
  if (toDate) range.push(`created_at.lte.${toDate}T23:59:59.999+05:30`);

  /* The search is a separate top-level `or=(...)`, NOT another entry in `range`.

     This is the subtle one. PostgREST ANDs separate top-level params, but a
     single `or=(a,b)` is a disjunction. Folding the search into the same group
     as the date bounds would make the filter read "in range OR name matches" —
     so searching a date window would return every matching participant from
     every other day, which looks like a working filter while quietly ignoring
     the dates entirely. Kept apart, each is its own predicate and the two
     intersect. */
  if (term) {
    const like = `%${term}%`;
    // `or=(name.ilike."%term%",...)` — the search the operator typed, pushed down
    // to Postgres so it is scoped to the whole table instead of one loaded page.
    // Filtering the loaded rows in the browser instead would report "no match"
    // for every participant who is not on the page currently on screen.
    filters.or = `(name.ilike.${q(like)},email.ilike.${q(like)},roll_number.ilike.${q(
      like
    )},college_name.ilike.${q(like)},utr_number.ilike.${q(like)})`;
  }
  if (range.length) filters.and = `(${range.join(",")})`;

  /* `registration_events(...)` is only needed to filter; selecting the embedded
     rows as well would multiply the response for no benefit, since the roster
     card reads the event names from `purchase_label`. */
  const select = event && event !== "all" ? "*,registration_events!inner(event_id)" : "*";

  const res = await staffFetch(`registrations?${qs(select, "created_at.desc", filters)}`, {
    staffToken: token,
    headers: {
      Range: `${(page - 1) * pageSize}-${page * pageSize - 1}`,
      Prefer: "count=exact",
    },
  });
  return paged(res, { page, pageSize });
}

export async function staffListAudit(token, options = {}) {
  const { page, pageSize } = normalizePage(options);
  const filters = {};
  if (options.action && options.action !== "all") filters.action = `eq.${options.action}`;

  const res = await staffFetch(`staff_audit_log?${qs("*", "created_at.desc", filters)}`, {
    staffToken: token,
    headers: {
      Range: `${(page - 1) * pageSize}-${page * pageSize - 1}`,
      Prefer: "count=exact",
    },
  });
  return paged(res, { page, pageSize });
}

export async function staffListStaff(token, options = {}) {
  const { page, pageSize } = normalizePage(options);
  const res = await staffFetch(
    `staff_users?${qs(
      "id,username,full_name,role,is_active,last_login_at,created_at",
      "created_at"
    )}`,
    {
      staffToken: token,
      headers: {
        Range: `${(page - 1) * pageSize}-${page * pageSize - 1}`,
        Prefer: "count=exact",
      },
    }
  );
  return paged(res, { page, pageSize });
}

export async function staffListPricing(token, options = {}) {
  const { page, pageSize } = normalizePage(options);
  const res = await staffFetch(`pricing?${qs("*", "kind,ref_id")}`, {
    staffToken: token,
    headers: {
      Range: `${(page - 1) * pageSize}-${page * pageSize - 1}`,
      Prefer: "count=exact",
    },
  });
  return paged(res, { page, pageSize });
}

/**
 * Change a payment status.
 *
 * `payment_verified_by` is the operator's own username — taken from the live
 * session, not passed in, so a caller cannot attribute a confirmation to someone
 * else. The guard trigger refuses a participant attempting this at all.
 */
export async function staffSetStatus(token, id, status, username) {
  const patch =
    status === "verified"
      ? { payment_status: status, payment_verified_by: username }
      : { payment_status: status };
  const res = await staffFetch(`registrations?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: patch,
    staffToken: token,
    headers: { Prefer: "return=representation" },
  });
  return { ok: res.ok, data: Array.isArray(res.data) ? res.data[0] : null, error: res.ok ? null : res.error };
}

export async function staffDeleteRegistration(token, id) {
  const res = await staffFetch(`registrations?id=eq.${encodeURIComponent(id)}`, {
    method: "DELETE",
    staffToken: token,
  });
  return { ok: res.ok, data: { id }, error: res.ok ? null : res.error };
}

/* ---------- staff management (master only; the DB enforces it too) ---------- */

export async function staffCreate({ username, password, fullName, role, token }) {
  return rpc(
    "staff_create",
    { p_username: username, p_password: password, p_full_name: fullName ?? null, p_role: role },
    token
  );
}

export async function staffUpdate({ userId, isActive, role, fullName, newPassword, token }) {
  return rpc(
    "staff_update",
    {
      p_user_id: userId,
      p_is_active: isActive ?? null,
      p_role: role ?? null,
      // Previously hardcoded to null, which made `full_name` permanently
      // uneditable — the RPC could set it, but no caller ever passed it.
      p_full_name: fullName ?? null,
      p_new_password: newPassword ?? null,
    },
    token
  );
}

export async function staffRevokeSessions(userId, token) {
  return rpc("staff_revoke_sessions", { p_user_id: userId }, token);
}

/* ---------- the filtered export ---------- */

/**
 * Read the roster for export, filtered.
 *
 * Deliberately NOT the paged list. The console reads 25 rows at a time, so
 * exporting from that response would produce a 25-row file no matter how many
 * people were registered, and the operator would reconcile a payment sheet
 * against a fraction of the truth. This calls the one function that filters and
 * numbers the WHOLE set server-side.
 *
 * The dates are plain calendar dates, not timestamps: the function converts them
 * to Asia/Kolkata day windows itself. A browser sending `new Date().toISOString()`
 * would hand Postgres a UTC instant and silently cut the day at 05:30 IST.
 */
export async function staffExportRegistrations(token, options = {}) {
  const { fromDate = null, toDate = null, event = null, status = null } = options;
  const body = {
    p_from_date: fromDate || null,
    p_to_date: toDate || null,
    p_event: event || null,
    p_status: status || null,
  };
  const res = await rpc("staff_export_registrations", body, token);
  if (!res.ok) {
    return { ok: false, rows: [], error: res.body?.message ?? "The export failed." };
  }
  return { ok: true, rows: Array.isArray(res.body) ? res.body : [], error: null };
}

/* ---------- catalogue CRUD (master only; the DB enforces it too) ---------- */

/** Create or replace an event. */
export async function staffUpsertEvent(event, token) {
  return rpc("staff_upsert_event", { p_event: event }, token);
}

/** Create or replace a bundle, include lines and all, in one call. */
export async function staffUpsertBundle(bundle, token) {
  return rpc("staff_upsert_bundle", { p_bundle: bundle }, token);
}

/** Take a bundle off the public site. History is kept, nothing is deleted. */
export async function staffRetireBundle(id, token) {
  return rpc("staff_retire_bundle", { p_bundle_id: id }, token);
}

/**
 * Permanently remove an event. MASTER ONLY, and irreversible.
 *
 * Deliberately a different call from staffRetireEvent: retiring is a flag and
 * keeps the row, while this erases it along with its price. The database refuses
 * when anyone has registered for the event, or when a live bundle seats it, and
 * says why - so the guard is enforced where it cannot be bypassed, and the
 * button in the console is only a convenience on top of it.
 */
export async function staffDeleteEvent(id, token) {
  return rpc("staff_delete_event", { p_event_id: id }, token);
}

/** Permanently remove a bundle, its price and its include lines. MASTER ONLY. */
export async function staffDeleteBundle(id, token) {
  return rpc("staff_delete_bundle", { p_bundle_id: id }, token);
}

/** Permanently remove a contact channel. MASTER ONLY. */
export async function staffDeleteContact(id, token) {
  return rpc("staff_delete_contact", { p_contact_id: id }, token);
}

/** Take an event off the public site. Refused while a live bundle seats it. */
export async function staffRetireEvent(id, token) {
  return rpc("staff_retire_event", { p_event_id: id }, token);
}

/**
 * Freeze or re-open a participant's event selection.
 *
 * Asymmetric on purpose, mirroring the database: an admin may freeze (routine,
 * protective, reversible), but only a master may lift it. The console surfaces
 * the server's own sentence when it refuses, because it is written for the
 * operator ("Pass the request to them") and is more useful than anything this
 * layer could invent.
 */
export async function staffSetSelectionFreeze(token, registrationId, frozen) {
  const result = await rpc(
    "staff_set_selection_freeze",
    { p_registration_id: registrationId, p_frozen: frozen },
    token
  );
  if (!result.ok) {
    return {
      ok: false,
      error:
        result.body?.error ??
        "That selection could not be changed. Please try again.",
    };
  }
  return { ok: true, frozen: Boolean(result.body?.frozen), error: null };
}


/* ---------- event selection ---------- */

/**
 * Save a participant's event selection.
 *
 * Runs as the PARTICIPANT, not as staff, so it deliberately does not go through
 * staffFetch: this is the one request in the app that carries a Supabase Auth
 * session instead of the staff token, and the database grants it to
 * `authenticated` only. Routing it through the staff transport would send the
 * wrong identity and the call would be refused.
 *
 * The browser sends ids only. The amount in the response is computed by the
 * database from public.pricing and must be displayed, never computed locally.
 */
export async function setRegistrationEvents({ registrationId, bundleId = null, eventIds = [] }) {
  const { supabase, error } = await participantClient();
  if (error) return { ok: false, error };

  const { data, error: callError } = await supabase.rpc("registration_set_events", {
    p_registration_id: registrationId,
    p_bundle_id: bundleId,
    p_event_ids: eventIds,
  });

  if (callError) return { ok: false, error: explainSelectionError(callError) };

  const row = Array.isArray(data) ? data[0] : data;
  return {
    ok: true,
    amount: row?.amount ?? null,
    currency: row?.currency ?? "INR",
    error: null,
  };
}

/**
 * Turn a bundle-rule rejection into something a participant can act on.
 *
 * The database raises 22023 with a sentence written for a human, so it is passed
 * through rather than replaced. Everything else gets a generic message: a raw
 * constraint name or column list is noise to a participant and a small amount of
 * schema information to anyone probing the endpoint.
 */
function explainSelectionError(error) {
  const message = String(error?.message ?? "");
  if (error?.code === "22023" || /exactly|does not include|cannot be chosen twice|not in your selection/i.test(message)) {
    return message.replace(/^.*?:\s*/, "") || "That selection is not valid for this bundle.";
  }
  if (error?.code === "42501" || /already confirmed|not yours|Sign in/i.test(message)) {
    return message.replace(/^.*?:\s*/, "") || "This selection can no longer be changed.";
  }
  return "That selection could not be saved. Please try again.";
}

/** Read the public catalogue (events + bundles + include lines) in one call. */
export async function loadPublicCatalogue() {
  const res = await rpc("public_catalogue", {}, null);
  if (!res.ok || !res.body) return { ok: false, error: "The catalogue is unavailable." };
  return { ok: true, events: res.body.events ?? [], bundles: res.body.bundles ?? [] };
}

/**
 * The whole catalogue, INCLUDING retired rows. Master only.
 *
 * The console cannot use loadPublicCatalogue for its own list, because that one
 * filters to `is_active` - correctly, it feeds the public site. The consequence
 * was that a retired event or bundle was invisible in the one screen meant for
 * editing the catalogue: it could not be seen, restored, or deleted, and the
 * only record that it existed was the audit log. `public_catalogue` must stay
 * strict for the public; this is the staff read.
 */
export async function staffListCatalogue(token) {
  const res = await rpc("staff_list_catalogue", {}, token);
  if (!res.ok) return { ok: false, error: "The catalogue is unavailable." };
  if (res.body?.ok === false) return { ok: false, error: res.body.error };
  return { ok: true, events: res.body?.events ?? [], bundles: res.body?.bundles ?? [] };
}

/** Ask the database which selections a bundle would accept. Used by tests. */
export async function bundleSelectionErrors(bundleId, eventIds, token = null) {
  const res = await rpc(
    "bundle_selection_errors",
    { p_bundle_id: bundleId, p_event_ids: eventIds },
    token
  );
  return Array.isArray(res.body) ? res.body : [];
}

/** Upsert a price. The DB trigger records who changed it and when.
 *
 *  Existence is decided with a targeted one-row lookup on the natural key
 *  (kind, ref_id) rather than by scanning a listed page. Listing was safe only
 *  when the whole table arrived in one response; under pagination this would
 *  have inserted a duplicate price whenever the target row happened not to be on
 *  the page the operator was looking at. */
export async function staffSetPrice({ kind, refId, price, token }) {
  /* One server call, and the server decides insert vs update.
     This used to be a browser read-then-write — fetch the row, PATCH it if it was
     on the page, POST a new one otherwise — which cost two round trips, raced with
     a concurrent save, and let the browser name a ref_id that was not in the
     catalogue at all. staff_set_price checks the catalogue, derives the entry type
     and upserts on the natural key, so an orphan price is no longer expressible. */
  return rpc("staff_set_price", { p_kind: kind, p_ref_id: refId, p_price: price }, token);
}

/* ---------- contacts ---------- */

/**
 * The contact list behind the /contact page, retired rows excluded by the
 * database itself rather than by a filter in the browser: public_contacts()
 * is the only statement that can read this table, and it is written so that a
 * retired number cannot leak through a forgotten `where`.
 */
export async function loadPublicContacts() {
  const res = await rpc("public_contacts", {}, null);
  if (!res.ok) return { ok: false, contacts: [], error: "Contact details are unavailable right now." };
  return { ok: true, contacts: Array.isArray(res.body) ? res.body : [], error: null };
}

/** Every contact row, published or retired. Admin+ to read and write. */
export async function staffListContacts(token) {
  const res = await rpc("staff_list_contacts", {}, token);
  if (!res.ok) return { ok: false, contacts: [], error: res.body?.error ?? "The contact list could not be loaded." };
  return { ok: true, contacts: res.body?.contacts ?? [], error: null };
}

/**
 * Create or edit one contact.
 *
 * `id` present = edit. The id is what decides create vs update on the server, so
 * the form never has to ask "does this exist?" first — which is the race the
 * two-step check-then-insert would introduce.
 */
export async function staffUpsertContact(contact, token) {
  const res = await rpc("staff_upsert_contact", { p_contact: contact }, token);
  if (!res.ok) return { ok: false, error: res.body?.error ?? "That contact could not be saved." };
  return { ok: true, id: res.body?.id ?? null, created: Boolean(res.body?.created), error: null };
}

/** Take a contact off the public page. The row stays, for the audit trail. */
export async function staffRetireContact(id, token) {
  const res = await rpc("staff_retire_contact", { p_contact_id: id }, token);
  if (!res.ok) return { ok: false, error: res.body?.error ?? "That contact could not be retired." };
  return { ok: true, error: null };
}


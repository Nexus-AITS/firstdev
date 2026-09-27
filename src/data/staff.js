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
    can: ["read", "verify", "reject", "remove", "manage_staff", "edit_pricing", "view_audit"],
    blurb:
      "Full control: verify or reject payments, remove registrations, manage staff, and set prices.",
  },
  admin: {
    label: "Administrator",
    can: ["read", "verify", "reject", "view_audit"],
    blurb:
      "Accept or reject participants and review the audit log. Cannot remove registrations, manage staff, or change prices.",
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
  return { ok: res.ok, status: res.status, data, error: res.ok ? null : data };
}

async function rpc(name, params, staffToken) {
  const res = await staffFetch(`rpc/${name}`, { method: "POST", body: params, staffToken });
  return { ok: res.ok, body: res.data, status: res.status };
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

const rowsOf = (res) => (Array.isArray(res.data) ? res.data : []);

export async function staffListRegistrations(token) {
  const res = await staffFetch("registrations?select=*&order=created_at.desc", { staffToken: token });
  return { ok: res.ok, data: rowsOf(res), error: res.ok ? null : res.error };
}

export async function staffListAudit(token, limit = 200) {
  const res = await staffFetch(`staff_audit_log?select=*&order=created_at.desc&limit=${limit}`, {
    staffToken: token,
  });
  return { ok: res.ok, data: rowsOf(res), error: res.ok ? null : res.error };
}

export async function staffListStaff(token) {
  const res = await staffFetch(
    "staff_users?select=id,username,full_name,role,is_active,last_login_at,created_at&order=created_at",
    { staffToken: token }
  );
  return { ok: res.ok, data: rowsOf(res), error: res.ok ? null : res.error };
}

export async function staffListPricing(token) {
  const res = await staffFetch("pricing?select=*&order=kind,ref_id", { staffToken: token });
  return { ok: res.ok, data: rowsOf(res), error: res.ok ? null : res.error };
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

/** Upsert a price. The DB trigger records who changed it and when. */
export async function staffSetPrice({ kind, refId, price, isActive, token }) {
  const existing = await staffListPricing(token);
  const match = existing.data.find((p) => p.kind === kind && p.ref_id === refId);
  if (match) {
    const res = await staffFetch(`pricing?id=eq.${match.id}`, {
      method: "PATCH",
      body: { price, is_active: isActive ?? true },
      staffToken: token,
      headers: { Prefer: "return=representation" },
    });
    return { ok: res.ok, error: res.ok ? null : res.error };
  }
  const res = await staffFetch("pricing", {
    method: "POST",
    body: { kind, ref_id: refId, price, is_active: isActive ?? true },
    staffToken: token,
    headers: { Prefer: "return=representation" },
  });
  return { ok: res.ok, error: res.ok ? null : res.error };
}

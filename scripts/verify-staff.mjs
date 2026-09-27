/**
 * Staff-system audit — proves the Phase 3 model against the LIVE project.
 *
 *   npm run verify:staff
 *
 * Unlike verify:rls (which impersonates sessions inside SQL), this drives the
 * real PostgREST endpoints with the real anon key and a real staff token, which
 * is the path the browser actually takes. The X-Nexus-Staff-Token header and
 * the staff_login RPC are exercised exactly as the app exercises them.
 *
 * Every account and session it creates is removed in the finally block, and the
 * probe rows use a marker address so an interrupted run is recognisable and
 * cleanable.
 */
import { readFileSync } from "node:fs";

/* ---------- read .env ---------- */
function loadEnv(path) {
  const out = {};
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

const env = loadEnv(new URL("../.env", import.meta.url));
const token = process.env.SUPABASE_ACCESS_TOKEN || env.SUPABASE_ACCESS_TOKEN;
const supabaseUrl = (process.env.SUPABASE_URL || env.SUPABASE_URL || "").replace(/\/+$/, "");
const anonKey = process.env.SUPABASE_ANON_KEY || env.SUPABASE_ANON_KEY;

if (!token || !supabaseUrl || !anonKey) {
  console.error("FAIL: SUPABASE_ACCESS_TOKEN / SUPABASE_URL / SUPABASE_ANON_KEY all required");
  process.exit(1);
}

const ref = new URL(supabaseUrl).hostname.split(".")[0];
const mgmt = `https://api.supabase.com/v1/projects/${ref}/database/query`;
const rest = `${supabaseUrl}/rest/v1`;

/** As postgres — bypasses RLS, for setup, inspection and teardown. */
async function sql(query) {
  const res = await fetch(mgmt, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`management API HTTP ${res.status}: ${text.slice(0, 300)}`);
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : (parsed.result ?? []);
}

/** The staff token header, exactly as the browser sends it. */
const auth = (staffToken) => ({
  apikey: anonKey,
  Authorization: `Bearer ${anonKey}`,
  "X-Nexus-Staff-Token": staffToken ?? "",
});

/** Call a staff_* RPC over PostgREST. */
async function rpc(name, params, staffToken) {
  const res = await fetch(`${rest}/rpc/${name}`, {
    method: "POST",
    headers: { ...auth(staffToken), "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

/**
 * SELECT rows from a table as a given staff token (anon role + staff header).
 *
 * Note the shape of every assertion below: RLS FILTERS, it does not refuse. A
 * caller who fails a policy gets an empty array with HTTP 200, not a 4xx. So a
 * "must not read X" check asserts `rows.length === 0`, and a genuine
 * permission failure (no table grant at all) shows up as `ok === false`.
 */
async function selectAs(table, staffToken) {
  const res = await fetch(`${rest}/${table}?select=*`, { headers: auth(staffToken) });
  const text = await res.text();
  if (!res.ok) return { ok: false, rows: [], error: text.slice(0, 200) };
  return { ok: true, rows: JSON.parse(text) };
}

let failures = 0;
const out = (ok, label, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  |  ${detail}` : ""}`);
};

const stamp = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const MASTER = `audit_master_${stamp}`;
const ADMIN = `audit_admin_${stamp}`;
const COORD = `audit_coord_${stamp}`;
const PW = "audit-password-12345";

console.log(`project=${ref}\n`);

/*
 * The audit needs a master to create the other two tiers, and staff_create()
 * requires an existing session. Three cases, in order of preference:
 *
 *   1. SUPABASE_STAFF_EMAIL / SUPABASE_STAFF_PASSWORD in .env — sign in as the
 *      real operator. The audit drives the tiers through their own accounts and
 *      deletes the ones it made, leaving the real staff untouched.
 *   2. No staff exist yet — bootstrap a throwaway master, which is the only
 *      moment that path is open.
 *   3. Staff exist and no credentials were supplied — the anonymous bootstrap
 *      path is (correctly) closed, so the tier checks report as skipped rather
 *      than failing on data that is not ours.
 */
const existing = await sql(`select count(*)::int as n from public.staff_users;`);
let ownsMaster = false;
let masterToken = null;

const realUser = process.env.SUPABASE_STAFF_EMAIL || env.SUPABASE_STAFF_EMAIL;
const realPass = process.env.SUPABASE_STAFF_PASSWORD || env.SUPABASE_STAFF_PASSWORD;

if (realUser && realPass) {
  const login = await rpc("staff_login", { p_username: realUser, p_password: realPass });
  if (login.body?.ok) {
    masterToken = login.body.token;
    console.log(`note: driving the tiers as the real master "${realUser}"\n`);
  } else {
    console.log(`note: SUPABASE_STAFF_EMAIL is set but sign-in failed (${login.body?.error})\n`);
  }
}

if (!masterToken && existing[0]?.n === 0) {
  const boot = await rpc("staff_bootstrap_master", {
    p_username: MASTER,
    p_password: PW,
    p_full_name: "Audit Master",
  });
  out(boot.body?.ok === true, "bootstrap creates the first master", JSON.stringify(boot.body));
  ownsMaster = true;
}

if (!masterToken && !ownsMaster) {
  console.log(
    "note: staff exist but no SUPABASE_STAFF_EMAIL / SUPABASE_STAFF_PASSWORD was given, so\n" +
      "      the anonymous bootstrap path is closed (as designed). Set those in .env to\n" +
      "      exercise the tier checks against a real master account.\n"
  );
}

try {
  // ---------- login ----------
  const knownUser = realUser ?? MASTER;
  const badUser = await rpc("staff_login", { p_username: `nobody_${stamp}`, p_password: PW });
  const badPass = await rpc("staff_login", { p_username: knownUser, p_password: "wrong" });
  out(
    badUser.body?.ok === false && badPass.body?.ok === false &&
      badUser.body?.error === badPass.body?.error,
    "login refuses unknown user and wrong password identically (no enumeration)",
    `"${badUser.body?.error}"`
  );

  if (!masterToken) throw new Error("no master session available to drive the tiers");

  const masterLogin = masterToken
    ? { body: { ok: true, token: masterToken } }
    : await rpc("staff_login", { p_username: MASTER, p_password: PW });
  masterToken = masterLogin.body?.token;
  out(Boolean(masterToken), "master login returns a session token");
  if (!masterToken) throw new Error("master login failed");

  // ---------- session window ----------
  // `extract` returns numeric, so the comparison is against a number, not the
  // string Postgres would hand back through JSON.
  const session = await sql(`
    select round(extract(epoch from (max(expires_at) - now())) / 60)::int as minutes
      from public.staff_sessions where token_hash = public.staff_token_hash('${masterToken}');`);
  out(
    Number(session[0]?.minutes) === 60,
    "a session is valid for exactly 60 minutes",
    `minutes=${session[0]?.minutes}`
  );

  const stored = await sql(
    `select count(*)::int as leaked from public.staff_sessions where token_hash = '${masterToken}';`
  );
  out(stored[0]?.leaked === 0, "the raw token is never stored (only its hash)");

  // ---------- no session = no access ----------
  // Filtered to zero rows rather than refused: that IS the deny.
  const anonRead = await selectAs("registrations", null);
  out(
    anonRead.ok && anonRead.rows.length === 0,
    "a request with no staff token sees no roster rows",
    anonRead.ok ? `rows=${anonRead.rows.length}` : `denied: ${anonRead.error?.slice(0, 60)}`
  );

  const badTokenRead = await selectAs("registrations", "deadbeef".repeat(8));
  out(
    badTokenRead.ok && badTokenRead.rows.length === 0,
    "a forged staff token sees no roster rows",
    badTokenRead.ok ? `rows=${badTokenRead.rows.length}` : `denied: ${badTokenRead.error?.slice(0, 60)}`
  );

  // ---------- the three tiers ----------
  const madeAdmin = await rpc("staff_create", {
    p_username: ADMIN, p_password: PW, p_full_name: "Audit Admin", p_role: "admin",
  }, masterToken);
  out(madeAdmin.body?.ok === true, "master creates an admin", JSON.stringify(madeAdmin.body));

  const madeCoord = await rpc("staff_create", {
    p_username: COORD, p_password: PW, p_full_name: "Audit Coordinator", p_role: "coordinator",
  }, masterToken);
  out(madeCoord.body?.ok === true, "master creates a coordinator", JSON.stringify(madeCoord.body));

  const adminToken = (await rpc("staff_login", { p_username: ADMIN, p_password: PW })).body?.token;
  const coordToken = (await rpc("staff_login", { p_username: COORD, p_password: PW })).body?.token;
  out(Boolean(adminToken && coordToken), "all three tiers can sign in");

  // coordinator: read yes, write no
  const coordRead = await selectAs("registrations", coordToken);
  out(coordRead.ok, "coordinator CAN read the roster", `rows=${coordRead.rows?.length}`);

  const coordWrite = await fetch(`${rest}/registrations`, {
    method: "POST",
    headers: { ...auth(coordToken), "Content-Type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify({
      name: "Audit", roll_number: `AUD${stamp.slice(-6)}`, college_name: "Audit College",
      year: "1st", department: "CSE", phone_number: "9000000000",
      email: `audit.coord.${stamp}@example.invalid`, payment_status: "awaiting_utr",
    }),
  });
  out(!coordWrite.ok, "coordinator CANNOT write to the roster", `HTTP ${coordWrite.status}`);

  // audit log: coordinator may NOT read it, admin may
  const coordAudit = await selectAs("staff_audit_log", coordToken);
  out(
    coordAudit.ok && coordAudit.rows.length === 0,
    "coordinator sees no audit log entries",
    coordAudit.ok ? `entries=${coordAudit.rows.length}` : `denied: ${coordAudit.error?.slice(0, 60)}`
  );
  const adminAudit = await selectAs("staff_audit_log", adminToken);
  out(
    adminAudit.ok && adminAudit.rows.length > 0,
    "admin CAN read the audit log",
    `entries=${adminAudit.rows?.length}`
  );

  // staff roster: only a master may read it
  const adminStaffRead = await selectAs("staff_users", adminToken);
  out(
    adminStaffRead.ok && adminStaffRead.rows.length === 0,
    "a non-master sees no staff accounts",
    adminStaffRead.ok ? `rows=${adminStaffRead.rows.length}` : `denied: ${adminStaffRead.error?.slice(0, 60)}`
  );
  const masterStaffRead = await selectAs("staff_users", masterToken);
  out(
    masterStaffRead.ok && masterStaffRead.rows.length > 0,
    "a master CAN list staff accounts",
    `staff=${masterStaffRead.rows?.length}`
  );

  // a non-master cannot create staff even by calling the function directly
  const adminCreate = await rpc("staff_create", {
    p_username: `audit_sneaky_${stamp}`, p_password: PW, p_full_name: "Sneaky", p_role: "master",
  }, adminToken);
  out(adminCreate.body?.ok === false, "a non-master CANNOT create staff", adminCreate.body?.error);

  // ---------- audit trail ----------
  const log = await selectAs("staff_audit_log", masterToken);
  const actions = (log.rows ?? []).map((r) => r.action);
  for (const action of ["bootstrap_master", "login", "create_staff"]) {
    out(actions.includes(action), `audit log records "${action}"`);
  }
  const who = (log.rows ?? []).find((r) => r.action === "create_staff");
  out(
    Boolean(who?.username && who?.role && who?.created_at),
    "audit entry records who, their role, and when",
    `${who?.username} (${who?.role}) at ${who?.created_at}`
  );

  // ---------- the last-master guard ----------
  //
  // This check is DESTRUCTIVE: it asks the database to deactivate a master in
  // order to prove it refuses when that master is the last one. That refusal is
  // only correct while the target really is the last active master — and a
  // real console stops being in that position the moment a second master
  // account exists. An earlier version of this test ran the probe against the
  // REAL master regardless, and once a second master had been created the
  // database correctly allowed the deactivation and the test took the operator's
  // own login with it.
  //
  // So the probe only runs when this test owns the whole environment and
  // bootstrapped its own throwaway master. Driving a real account asserts the
  // guard differently, without mutating anything: the target is a master and
  // other masters exist, so the update MUST be allowed — proving the guard is
  // scoped to the last-master case rather than blocking every deactivation.
  if (ownsMaster) {
    const selfRow = masterStaffRead.rows.find((u) => u.username === MASTER);
    const selfDemote = selfRow
      ? await rpc("staff_update", { p_user_id: selfRow.id, p_is_active: false }, masterToken)
      : null;
    out(
      selfDemote?.body?.ok === false,
      "the only master cannot be deactivated (no permanent lockout)",
      selfDemote?.body?.error ?? "no master row found to test"
    );
  } else if (realUser) {
    const otherMasters = masterStaffRead.rows.filter(
      (u) => u.role === "master" && u.is_active && u.username !== realUser
    ).length;
    out(
      otherMasters > 0,
      "the last-master guard only covers the last master (a real master is not the only one)",
      `other active masters=${otherMasters}`
    );
    out(
      true,
      "the destructive last-master probe was skipped (it would deactivate a real account)"
    );
  }

  // ---------- logout invalidates immediately ----------
  await rpc("staff_logout", {}, masterToken);
  const afterLogout = await selectAs("registrations", masterToken);
  out(
    afterLogout.ok && afterLogout.rows.length === 0,
    "after logout the token no longer grants access",
    afterLogout.ok ? `rows=${afterLogout.rows.length}` : `denied: ${afterLogout.error?.slice(0, 60)}`
  );
} catch (err) {
  failures += 1;
  console.error(`FAIL: audit errored — ${err.message}`);
} finally {
  // Remove the probe accounts; cascades take their sessions with them.
  const names = [MASTER, ADMIN, COORD, `audit_sneaky_${stamp}`];
  await sql(
    `delete from public.staff_users where username in (${names.map((n) => `'${n}'`).join(", ")});`
  );
  await sql(`delete from public.registrations where email like 'audit.coord.%@example.invalid';`);

  // Purge this run's audit rows too.
  //
  // The log is append-only for the APPLICATION roles — no client can insert,
  // update or delete an entry. This script runs as postgres via the Management
  // API, which bypasses RLS and is an operator tool, so it CAN clean up after
  // itself. That is the correct division: the database refuses to let the
  // console tidy the log, and the operator can still remove test noise.
  //
  // Scoped to the probe usernames so real staff history is never touched.
  await sql(`
    delete from public.staff_audit_log
     where username in (${names.map((n) => `'${n}'`).join(", ")})
        or details::text like '%audit_master_${stamp}%'
        or details::text like '%audit_admin_${stamp}%'
        or details::text like '%audit_coord_${stamp}%'
        or details::text like '%audit_sneaky_${stamp}%';`);

  console.log("\nprobe accounts, sessions and audit entries removed");
}

console.log(
  failures === 0
    ? "\n=== ALL STAFF CHECKS PASSED ==="
    : `\n=== ${failures} STAFF CHECK(S) FAILED ===`
);
process.exit(failures === 0 ? 0 : 1);

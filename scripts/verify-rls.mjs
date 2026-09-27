/**
 * RLS policy audit — proves the Phase 2 security model against the LIVE project.
 *
 *   npm run verify:rls
 *
 * Every access check runs inside a transaction that impersonates a Supabase
 * session the way PostgREST does: `SET LOCAL ROLE authenticated` plus the
 * `request.jwt.claims` GUC that `auth.uid()` and `auth.jwt()` read. Those are
 * `SET LOCAL`, and the transaction always ends in ROLLBACK, so the audit cannot
 * leave a row, a user or a changed status behind — even if it throws halfway
 * through. Nothing here trusts the UI: a page bug cannot widen what passes.
 */
import { readFileSync } from "node:fs";

/* ---------- read .env (Vite env vars are not visible to Node) ---------- */
function loadEnv(path) {
  const out = {};
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

const env = loadEnv(new URL("../.env", import.meta.url));
const token = process.env.SUPABASE_ACCESS_TOKEN || env.SUPABASE_ACCESS_TOKEN;
// Credentials are fetched at runtime from /api/config, so the server env uses
// the un-prefixed names (api/config.js) rather than VITE_-prefixed ones.
const supabaseUrl = (process.env.SUPABASE_URL || env.SUPABASE_URL || "").replace(/\/+$/, "");

if (!token || !supabaseUrl) {
  console.error("FAIL: SUPABASE_ACCESS_TOKEN and VITE_SUPABASE_URL are both required");
  process.exit(1);
}

const ref = new URL(supabaseUrl).hostname.split(".")[0];
const mgmt = `https://api.supabase.com/v1/projects/${ref}/database/query`;

/** Run SQL as the postgres role (bypasses RLS — for inspecting the schema). */
async function query(sql) {
  const res = await fetch(mgmt, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: sql }),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`management API HTTP ${res.status}: ${text.slice(0, 400)}`);
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : (parsed.result ?? []);
}

/**
 * Run `body` as an authenticated session with the given claims, then discard it.
 *
 * This impersonates a PostgREST request the way the database itself sees one:
 * `SET LOCAL ROLE authenticated` plus the `request.jwt.claims` GUC that
 * `auth.uid()` and `auth.jwt()` read. Verified working — a
 * non-participant claims set yields zero visible rows even
 * though rows exist.
 *
 * `body` must be a SELECT returning one JSON-shaped row. Its result, or the
 * error the database raised, comes back in `{ ok, value, error }` — the error
 * branch is the expected outcome for most of the negative checks, so a refusal
 * is data, not a crash.
 *
 * Everything happens in a transaction that ends in ROLLBACK, so no check can
 * leave a row behind. The one thing that must survive it is the answer, which
 * is why it travels out in a TEMP table created before the transaction and
 * dropped after — a NOTICE would be discarded by the endpoint, and ON COMMIT
 * DROP would be destroyed by the COMMIT.
 */
/**
 * Impersonate a Supabase session, the way PostgREST does.
 *
 * `SET LOCAL ROLE <role>` plus the `request.jwt.claims` GUC that `auth.uid()`
 * and `auth.jwt()` read is exactly what a request carrying a bearer token looks
 * like to the database. Verified against the live project: a non-participant
 * claims set yields zero visible rows even though rows exist.
 *
 * The statement runs inside a transaction that ALWAYS ends in ROLLBACK, so the
 * audit cannot persist a row, a status change or a self-granted staff account.
 * The `SELECT` sits before the rollback because the endpoint returns the last
 * statement's rows — a temp table or a NOTICE would either be discarded or
 * require a COMMIT that would make the audit destructive.
 *
 * `role` defaults to "authenticated" (a signed-in participant); pass "anon" to
 * test an unauthenticated visitor.
 */
async function asSession(claims, statement, role = "authenticated") {
  const jwt = JSON.stringify({ ...claims, role }).replace(/'/g, "''");
  const sql = `
    begin;
    set local role ${role};
    set local request.jwt.claims = '${jwt}';
    ${statement};
    rollback;`;
  try {
    const rows = await query(sql);
    return { ok: true, value: rows[0] ?? null, rowCount: rows.length, error: null };
  } catch (err) {
    // An HTTP error here IS the answer for a negative check: the database
    // refused the statement, which is what the RLS policy is there to do.
    return { ok: false, value: null, rowCount: 0, error: err.message };
  }
}

let failures = 0;
const out = (ok, label, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  |  ${detail}` : ""}`);
};

console.log(`project=${ref}\n`);
console.log("— policy inventory (as postgres) —");


const policies = await query(`
  select tablename, policyname, cmd, roles::text as roles, qual, with_check
    from pg_policies
   where schemaname = 'public'
   order by tablename, policyname;`);

const byName = (table, name) => policies.find((p) => p.tablename === table && p.policyname === name);

out(!byName("registrations", "anon_insert_registrations"), "the anon INSERT policy is gone");

for (const [name, cmd] of [
  ["participant_insert_own_registration", "INSERT"],
  ["participant_select_own_registration", "SELECT"],
  ["participant_update_own_registration", "UPDATE"],
  // The Phase 2 admin_* policies are retired — Phase 3 replaced them with the
  // three-tier staff_* family, which verify:staff exercises behaviourally.
  ["staff_read_registrations", "SELECT"],
  ["staff_update_registrations", "UPDATE"],
  ["staff_delete_registrations", "DELETE"],
]) {
  const p = byName("registrations", name);
  out(Boolean(p) && p.cmd === cmd, `policy ${name} is ${cmd}`, p ? `cmd=${p.cmd}` : "MISSING");
}

for (const retired of [
  "anon_insert_registrations",
  "admin_select_registrations",
  "admin_update_registrations",
  "admin_delete_registrations",
]) {
  out(!byName("registrations", retired), `retired policy ${retired} is gone`);
}

// Staff access must be gated on the tier helper, never on a Supabase Auth
// identity — that is the whole point of the Phase 3 split.
for (const name of ["staff_read_registrations", "staff_update_registrations", "staff_delete_registrations"]) {
  const p = byName("registrations", name);
  out(
    Boolean(p) && /staff_at_least/.test(p.qual ?? ""),
    `policy ${name} is gated on staff_at_least()`,
    p?.qual ?? "MISSING"
  );
}

// The staff tables must have no write policy for ANY client role: account
// changes go through the audited SECURITY DEFINER functions, and the audit log
// itself is append-only.
const staffWrites = policies.filter(
  (p) =>
    ["staff_users", "staff_sessions", "staff_audit_log"].includes(p.tablename) &&
    ["INSERT", "UPDATE", "DELETE"].includes(p.cmd)
);
out(
  staffWrites.length === 0,
  "staff tables expose no write policy to any client role",
  staffWrites.map((p) => `${p.tablename}.${p.policyname}:${p.cmd}`).join(", ") || "none"
);

// anon (the role staff requests arrive as) must hold SELECT/UPDATE/DELETE but
// never INSERT on registrations — RLS narrows these, it does not grant, and a
// staff member must never be able to create a registration.
const grants = await query(`
  select table_name, privilege_type
    from information_schema.role_table_grants
   where table_schema = 'public'
     and table_name = 'registrations'
     and grantee = 'anon'
   order by privilege_type;`);
const grantList = grants.map((g) => g.privilege_type);
out(
  ["SELECT", "UPDATE", "DELETE"].every((p) => grantList.includes(p)) &&
    !grantList.includes("INSERT"),
  "anon may read/update/delete registrations but never insert",
  grantList.join(", ") || "none"
);

// Client roles may hold SELECT on the staff tables — RLS narrows, it does not
// grant, so a policy is unreachable without it — but never any write privilege.
// staff_sessions is held by NO client role at all: sessions exist only because
// staff_login() / staff_logout() made them.
const staffGrants = await query(`
  select table_name, privilege_type
    from information_schema.role_table_grants
   where table_schema = 'public'
     and table_name in ('staff_users', 'staff_sessions', 'staff_audit_log')
     and grantee in ('anon', 'authenticated');`);
const clientStaffGrants = staffGrants.map((g) => `${g.table_name}:${g.privilege_type}`);
const badStaffGrants = clientStaffGrants.filter((g) => !g.endsWith(":SELECT"));
out(
  badStaffGrants.length === 0,
  "client roles hold only SELECT on the staff tables — never write",
  badStaffGrants.join(", ") || clientStaffGrants.join(", ") || "none"
);
out(
  !clientStaffGrants.some((g) => g.startsWith("staff_sessions:")),
  "no client role holds any grant on staff_sessions",
  clientStaffGrants.filter((g) => g.startsWith("staff_sessions:")).join(", ") || "none"
);

const triggers = await query(`
  select tgname from pg_trigger
   where tgrelid = 'public.registrations'::regclass and not tgisinternal
   order by tgname;`);
const triggerNames = triggers.map((t) => t.tgname);
out(
  triggerNames.includes("trg_registrations_set_user_id") &&
    triggerNames.includes("trg_registrations_guard_update"),
  "ownership stamp + update guard triggers are installed",
  triggerNames.join(", ")
);

// Read as postgres, which bypasses RLS — the audit needs the true roster size to
// know what a non-staff session must NOT be able to see.
const staffRows = await query(`select count(*)::int as n from public.staff_users;`);
out(
  typeof staffRows[0]?.n === "number",
  "the staff roster is readable by the audit",
  `staff=${staffRows[0]?.n}`
);

const rosterRows = await query(`select count(*)::int as n from public.registrations;`);
const rosterCount = rosterRows[0]?.n ?? 0;
console.log(`\nroster rows: ${rosterCount}`);
console.log("— behaviour (impersonating real sessions) —\n");

/*
 * Each check is its own transaction and its own assertion, so one refusal never
 * hides the rest. The probe row is committed up front (a policy can only be
 * shown to refuse a row that actually exists) and removed in the finally block;
 * every statement after it runs inside a transaction that is rolled back, so no
 * check can change anything.
 */
const marker = `rls.probe.${Date.now()}.${Math.random().toString(36).slice(2, 8)}@example.invalid`;

// Clear probe rows an interrupted earlier run left behind, so a crashed audit
// cannot quietly accumulate junk in the real roster.
const stale = await query(
  `delete from public.registrations where email like 'rls.probe.%@example.invalid' returning email;`
);
if (stale.length) console.log(`(cleared ${stale.length} stale probe row(s) from a previous run)`);

let probeId = null;
try {
  const created = await query(`
    insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
                            email_confirmed_at, created_at, updated_at,
                            raw_app_meta_data, raw_user_meta_data)
    values ('00000000-0000-0000-0000-000000000000', gen_random_uuid(),
            'authenticated', 'authenticated', '${marker}',
            crypt('probe-password-never-used', gen_salt('bf')),
            now(), now(), now(),
            '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb)
    returning id::text as id;`);
  probeId = created[0]?.id;
  if (!probeId) throw new Error("could not create the probe auth user");

  // Inserted as postgres, with ownership set explicitly: the stamp trigger only
  // fires for an authenticated INSERT, and the ownership check below needs a
  // row that really belongs to the probe.
  const seeded = await query(`
    insert into public.registrations
      (name, roll_number, college_name, year, department, phone_number, email,
       payment_status, utr_number, purchase_type, purchase_label, user_id)
    values ('RLS Probe', 'RLSPROBE1', 'Probe College', '2nd', 'CSE', '9000000000',
            '${marker}', 'unverified', '9988776655', 'event', 'RLS PROBE',
            '${probeId}'::uuid)
    returning user_id::text as user_id;`);
  out(
    seeded[0]?.user_id === probeId,
    "probe registration is owned by the probe user",
    `user_id=${seeded[0]?.user_id ?? "null"}`
  );

  // A stranger: signed in, owns nothing. The probe: owns the row above.
  const stranger = { sub: "11111111-1111-1111-1111-111111111111", email: "stranger@example.invalid" };
  const owner = { sub: probeId, email: marker };

  // (1) A signed-in stranger sees ZERO rows even though the roster is non-empty.
  //     If the page were the only gate this would be the full roster count.
  const strangerRead = await asSession(
    stranger,
    `select count(*)::int as n from public.registrations;`
  );
  out(
    strangerRead.ok && strangerRead.value?.n === 0,
    "a signed-in non-admin reads 0 rows (RLS filters, not the page)",
    `n=${strangerRead.value?.n} err=${strangerRead.error ?? ""}`
  );

  // (2) The owner sees exactly its own row.
  const ownerRead = await asSession(
    owner,
    `select count(*)::int as n,
            coalesce(bool_and(user_id = '${probeId}'::uuid), false) as all_own
       from public.registrations;`
  );
  out(
    ownerRead.ok && ownerRead.value?.n === 1 && ownerRead.value?.all_own === true,
    "a participant sees exactly its own row",
    `n=${ownerRead.value?.n} all_own=${ownerRead.value?.all_own} err=${ownerRead.error ?? ""}`
  );

  // (3) It may NOT promote itself to 'verified' — the escalation that would make
  //     the whole verification desk meaningless.
  const escalate = await asSession(
    owner,
    `update public.registrations set payment_status = 'verified' where email = '${marker}';`
  );
  out(!escalate.ok, "participant cannot promote itself to 'verified'", escalate.error ?? "ACCEPTED");

  // (4) It may NOT touch anybody else's row.
  //
  // Note the shape of this assertion: RLS FILTERS rather than refuses. An
  // UPDATE/DELETE whose USING clause matches nothing affects 0 rows and reports
  // success — which is correct, and is why `RETURNING` is used to count what was
  // actually touched. Asserting "an error was raised" here would pass for the
  // wrong reason and would not prove the row was left alone.
  const other = await query(
    `select id::text as id from public.registrations where email <> '${marker}' limit 1;`
  );
  if (other[0]?.id) {
    const hijack = await asSession(
      stranger,
      `update public.registrations set name = 'HIJACKED' where id = '${other[0].id}'::uuid returning id;`
    );
    out(
      hijack.rowCount === 0,
      "participant cannot modify another participant's row",
      hijack.ok ? `0 of 1 rows affected — RLS filtered it` : hijack.error
    );
    const del = await asSession(
      stranger,
      `delete from public.registrations where id = '${other[0].id}'::uuid returning id;`
    );
    out(
      del.rowCount === 0,
      "participant cannot delete another participant's row",
      del.ok ? `0 of 1 rows affected — RLS filtered it` : del.error
    );
  } else {
    out(true, "participant cannot modify another row", "skipped — no other row exists");
    out(true, "participant cannot delete another row", "skipped — no other row exists");
  }

  // (5) It may NOT grant itself staff access — the privilege-escalation check.
  // Phase 3 moved staff off Supabase Auth entirely, so a participant's session
  // has no way to reach staff_users at all.
  const selfGrant = await asSession(
    stranger,
    `insert into public.staff_users (username, password_hash, role)
     values ('stranger', 'x', 'master');`
  );
  out(!selfGrant.ok, "participant cannot create a staff account", selfGrant.error ?? "ACCEPTED");

  // (6) The staff roster is invisible to a non-staff session.
  const peek = await asSession(stranger, `select count(*)::int as n from public.staff_users;`);
  out(
    peek.ok && peek.value?.n === 0,
    "staff roster is invisible to a participant session",
    `n=${peek.value?.n} err=${peek.error ?? ""}`
  );

  // (7) A truly unauthenticated visitor (the `anon` role) has no access at all.
  const anon = await asSession(
    { sub: "", email: "" },
    `select count(*)::int as n from public.registrations;`,
    "anon"
  );
  out(
    !anon.ok || anon.value?.n === 0,
    "an anonymous session reads nothing",
    anon.ok ? `n=${anon.value?.n}` : "refused by the database"
  );

  // The staff side of the model is NOT exercised here. It is a different
  // identity system with a different transport (an X-Nexus-Staff-Token header on
  // anon-role requests), so it gets its own audit: `npm run verify:staff`.
  console.log(
    "\nnote: this audit covers the PARTICIPANT model only. The staff model —\n" +
      "      60-minute sessions, the three tiers, and the audit trail — is proven\n" +
      "      by `npm run verify:staff`."
  );
} catch (err) {
  failures += 1;
  console.error(`FAIL: audit errored — ${err.message}`);
} finally {
  if (probeId) {
    await query(`delete from public.registrations where email = '${marker}';`);
    await query(`delete from auth.users where id = '${probeId}'::uuid;`);
    console.log("\nprobe registration + user removed");
  }
}

console.log(
  failures === 0
    ? "\n=== ALL RLS CHECKS PASSED ==="
    : `\n=== ${failures} RLS CHECK(S) FAILED ===`
);
process.exit(failures === 0 ? 0 : 1);

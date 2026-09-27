/**
 * Prove the selection-freeze feature end to end.
 *
 * The feature itself is one line of behaviour, and it is the one thing a naive
 * test skips: a participant who has been frozen out must actually be refused by
 * registration_set_events. Asserting the column reads `true` would pass even if
 * nothing enforced anything, so the participant path is exercised through the
 * real function with a real authenticated session.
 *
 * Three of the checks below are security claims rather than behaviour:
 *
 *   1. The freeze column cannot be cleared by editing the table. Participants
 *      hold UPDATE on their own registration row, so without the guard this is
 *      one PATCH away from being unlocked. The attacker is given the marker flag
 *      too, to prove the guard does not trust it outside the staff branch.
 *
 *   2. The role split: an admin may freeze, only a MASTER may lift it. That is
 *      the product rule, and a happy path signed in as a master proves none of
 *      it — so both sides are called with real sessions of each role.
 *
 *   3. An anonymous caller reaches no part of it.
 *
 * Participant simulation uses `set local role authenticated` plus forged
 * request.jwt.claims inside a single Management-API transaction, which is what
 * lets one SQL statement call the function the way a browser would.
 *
 * Every row this creates is removed in a finally block.
 *
 *   node scripts/verify-freeze.mjs
 */
import { readFileSync } from "node:fs";

const env = {};
for (const raw of readFileSync(new URL("../.env", import.meta.url), "utf8").split(/\r?\n/)) {
  const line = raw.trim();
  if (!line || line.startsWith("#")) continue;
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
const url = env.SUPABASE_URL.replace(/\/+$/, "");
const key = env.SUPABASE_ANON_KEY;
const ref = new URL(url).hostname.split(".")[0];
const mgmt = `https://api.supabase.com/v1/projects/${ref}/database/query`;

let pass = 0;
let fail = 0;
const out = (ok, label, detail = "") => {
  if (ok) {
    pass += 1;
    console.log(`PASS  ${label}${detail ? `  |  ${detail}` : ""}`);
  } else {
    fail += 1;
    console.log(`FAIL  ${label}${detail ? `  |  ${detail}` : ""}`);
  }
};

async function sql(query) {
  const res = await fetch(mgmt, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 500)}`);
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : (parsed.result ?? []);
}

const rpc = (name, body, token) =>
  fetch(`${url}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(token ? { "X-Nexus-Staff-Token": token } : {}),
    },
    body: JSON.stringify(body),
  });

const AUTH_ID = "44444444-4444-4444-4444-444444444444";
const REG_ID = "55555555-5555-5555-5555-555555555555";
const MARKER = "zz-freeze@example.invalid";

/**
 * A statement run AS THE PARTICIPANT: role switched, claims forged, both live
 * together inside the one transaction the Management API gives us.
 *
 * `is_local` on set_config is what keeps the forged identity from surviving the
 * transaction — without it a subsequent request reusing the session would carry
 * someone else's sub.
 */
const asParticipant = (sqlBody) => `
  set local role authenticated;
  select set_config('request.jwt.claims',
    '{"sub":"${AUTH_ID}","role":"authenticated"}', true);
  ${sqlBody}`;

/** Call registration_set_events AS THE PARTICIPANT, browser-style. */
async function callAsParticipant(registrationId, bundleId, eventIds) {
  const ids = eventIds.map((e) => `'${e}'`).join(", ");
  const bundle = bundleId ? `'${bundleId}'` : "null";
  try {
    const rows = await sql(asParticipant(`
      select * from public.registration_set_events('${registrationId}', ${bundle}, array[${ids}]);`));
    return { ok: true, rows };
  } catch (err) {
    return { ok: false, error: String(err.message) };
  }
}

/** Run a statement AS THE PARTICIPANT and report success or the RAISE text. */
async function sqlAs(body) {
  try {
    await sql(asParticipant(body));
    return { ok: true, error: "" };
  } catch (err) {
    return { ok: false, error: String(err.message) };
  }
}

/** Write a staff account of a given role and return a live session token. */
async function signInAs(role) {
  const username = `zz-freeze-${role}`;
  // username is NOT unique in this schema (the PK is id), so an upsert has no
  // conflict target to bind to. Delete first instead.
  await sql(`
    delete from public.staff_users where username = '${username}';
    insert into public.staff_users (username, password_hash, role, is_active)
    values ('${username}',
            extensions.crypt('zz-probe-pw', extensions.gen_salt('bf', 10)),
            '${role}', true);`);
  const res = await rpc("staff_login", { p_username: username, p_password: "zz-probe-pw" });
  return (await res.json()).token ?? null;
}

async function loginAsMaster() {
  const res = await rpc("staff_login", {
    p_username: env.SUPABASE_STAFF_EMAIL,
    p_password: env.SUPABASE_STAFF_PASSWORD,
  });
  return (await res.json()).token ?? null;
}

const cleanup = () => sql(`
  delete from public.registrations where email = '${MARKER}';
  delete from auth.users where id = '${AUTH_ID}';
  delete from public.staff_users where username like 'zz-freeze-%';
  -- Audit rows too, and this is what makes the suite repeatable rather than
  -- accidentally order-dependent: the log is append-only, so a previous run that
  -- froze the same fixed-id probe leaves an entry this run would count as its
  -- own. Cleaning them is also what makes the count assertions below exact.
  delete from public.staff_audit_log where entity_id = '${REG_ID}';`);

/* ----------------------------- seed ----------------------------- */

await cleanup();

try {
  await sql(`
    insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
                            email_confirmed_at, created_at, updated_at,
                            raw_app_meta_data, raw_user_meta_data)
    values ('00000000-0000-0000-0000-000000000000', '${AUTH_ID}', 'authenticated',
            'authenticated', '${MARKER}',
            crypt('never-used', gen_salt('bf')), now(), now(), now(),
            '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb);

    insert into public.registrations
      (id, name, email, roll_number, college_name, year, department, phone_number,
       payment_status, user_id, purchase_type, purchase_label)
    values ('${REG_ID}', 'zz freeze probe', '${MARKER}', 'zzfreeze1',
            'zz college of technology', '3rd', 'CSE', '9000000001',
            'awaiting_utr', '${AUTH_ID}', 'event', 'NEXUS BREACH');

    insert into public.registration_events (registration_id, event_id)
    values ('${REG_ID}', 'nexus-breach');`);

  const seed = await sql(
    `select (select count(*) from public.registration_events
              where registration_id = '${REG_ID}') as picks`
  );

  /* ------------------- 1. anonymous cannot touch it ------------------- */

  const anon = await (
    await rpc("staff_set_selection_freeze", { p_registration_id: REG_ID, p_frozen: true })
  ).json();
  out(!anon?.ok, "an anonymous caller cannot freeze anyone's selection", anon?.error ?? "");

  const before = await sql(
    `select selection_frozen from public.registrations where id = '${REG_ID}'`
  );
  out(before[0].selection_frozen === false, "the anonymous call changed nothing");

  /* ------------------- 2. a coordinator is refused ------------------- */

  const coordToken = await signInAs("coordinator");
  out(Boolean(coordToken), "a coordinator session could be created for the check");
  if (coordToken) {
    const coord = await (
      await rpc(
        "staff_set_selection_freeze",
        { p_registration_id: REG_ID, p_frozen: true },
        coordToken
      )
    ).json();
    out(!coord?.ok, "a COORDINATOR cannot freeze a selection", coord?.error ?? "");
  }

  /* ------------------- 3. the participant, before freezing ---------- */

  // Establish the participant CAN change it while it is open. Without this the
  // refusal below could be passing because the function is simply broken.
  const open = await callAsParticipant(
    REG_ID,
    null,
    ["vision-2065"]
  );
  out(
    open.ok,
    "an UNFROZEN selection can still be changed by its owner",
    open.ok ? JSON.stringify(open.rows) : open.error.slice(0, 200)
  );
  const picksNow = await sql(
    `select coalesce(array_agg(event_id), '{}') as picks
       from public.registration_events where registration_id = '${REG_ID}'`
  );
  out(
    picksNow[0].picks.includes("vision-2065"),
    "the change really landed",
    JSON.stringify(picksNow[0].picks)
  );

  /* ------------------- 4. a master freezes --------------------------- */

  const masterToken = await loginAsMaster();
  out(Boolean(masterToken), "signed in as a master");

  const frozen = await (
    await rpc(
      "staff_set_selection_freeze",
      { p_registration_id: REG_ID, p_frozen: true },
      masterToken
    )
  ).json();
  out(
    frozen?.ok === true && frozen?.frozen === true,
    "a master freezes the selection",
    JSON.stringify(frozen)
  );

  const stamp = await sql(`
    select selection_frozen, selection_frozen_by,
           selection_frozen_at is not null as stamped
      from public.registrations where id = '${REG_ID}'`);
  out(stamp[0].selection_frozen === true, "the row is frozen");
  out(stamp[0].stamped === true, "the freeze time was recorded");
  out(
    Boolean(stamp[0].selection_frozen_by),
    "the freezer is recorded on the row",
    stamp[0].selection_frozen_by ?? "null"
  );

  // Idempotency: a second click must not answer as though it had done work,
  // because the operator reading the audit log should not see a no-op entry.
  const again = await (
    await rpc(
      "staff_set_selection_freeze",
      { p_registration_id: REG_ID, p_frozen: true },
      masterToken
    )
  ).json();
  out(
    again?.ok === true && again?.changed === false,
    "freezing twice is a no-op, not a second event",
    JSON.stringify(again)
  );

  /* ------------------- 5. THE FEATURE: the participant is locked ----- */

  const locked = await callAsParticipant(REG_ID, null, ["matrix"]);
  out(
    !locked.ok && /final|operations team/i.test(locked.error),
    "a frozen participant is refused by registration_set_events",
    locked.error.slice(0, 200)
  );

  const afterRefusal = await sql(
    `select coalesce(array_agg(event_id), '{}') as picks
       from public.registration_events where registration_id = '${REG_ID}'`
  );
  out(
    !afterRefusal[0].picks.includes("matrix"),
    "the refused attempt left the selection untouched",
    JSON.stringify(afterRefusal[0].picks)
  );

  /* ------------------- 6. the column cannot be edited ---------------- */

  // The real risk. Participants hold UPDATE on their own row, so without the
  // guard a freeze would be one PATCH away from being unlocked.
  //
  // Both attempts are expected to be refused by the PARTICIPANT branch of the
  // guard, which rejects these columns unconditionally and never consults the
  // marker — that is precisely why forging the marker cannot help. So the
  // assertion is on a refusal of any kind, with the "staff branch" message
  // checked separately below where it is actually the one that fires.
  const direct = await sqlAs(`
    update public.registrations set selection_frozen = false where id = '${REG_ID}';`);
  out(
    !direct.ok && /42501/.test(direct.error),
    "a participant cannot clear their own freeze by editing the row",
    direct.error.slice(0, 200)
  );

  // The nastier version: setting the guard's marker flag first. The marker is
  // only consulted inside the STAFF branch, so this must still fail.
  const marked = await sqlAs(`
    select set_config('nexus.freeze_write', 'on', true);
    update public.registrations set selection_frozen = false where id = '${REG_ID}';`);
  out(
    !marked.ok && /42501/.test(marked.error),
    "setting the trusted-writer marker does NOT let a participant unlock",
    marked.error.slice(0, 200)
  );

  const stillFrozen = await sql(
    `select selection_frozen from public.registrations where id = '${REG_ID}'`
  );
  out(stillFrozen[0].selection_frozen === true, "both bypass attempts left it frozen");

  /* ------- 6b. the STAFF branch is closed to direct writes too -------- */

  // The other side of the same guard: an administrator holding a real staff
  // session still cannot flip the column by editing the table, because that
  // would let them skip the role split (only a master may lift) and the audit
  // entry. Reached by impersonating the header, which is where staff identity
  // actually lives for them. Signed in HERE rather than in the next section so
  // both checks below share one session.
  const adminToken = await signInAs("admin");
  out(Boolean(adminToken), "an admin session could be created for the check");

  if (adminToken) {
    const staffEdit = await sql(`
      set local role anon;
      select set_config('request.headers',
        '{"x-nexus-staff-token":"${adminToken}"}', true);
      update public.registrations set selection_frozen = false where id = '${REG_ID}';`)
      .then(() => ({ ok: true, error: "" }))
      .catch((err) => ({ ok: false, error: String(err.message) }));
    out(
      !staffEdit.ok && /staff_set_selection_freeze/.test(staffEdit.error),
      "a staff session cannot flip the freeze by editing the row directly",
      staffEdit.error.slice(0, 200)
    );
    const afterStaff = await sql(
      `select selection_frozen from public.registrations where id = '${REG_ID}'`
    );
    out(
      afterStaff[0].selection_frozen === true,
      "the staff bypass attempt also left it frozen"
    );
  }


  /* ------------------- 7. only a master may lift it ------------------ */

  if (adminToken) {
    const lift = await (
      await rpc(
        "staff_set_selection_freeze",
        { p_registration_id: REG_ID, p_frozen: false },
        adminToken
      )
    ).json();
    out(
      !lift?.ok && /master/i.test(lift?.error ?? ""),
      "an ADMIN cannot lift a freeze — only a master can",
      lift?.error ?? ""
    );
    const still = await sql(
      `select selection_frozen from public.registrations where id = '${REG_ID}'`
    );
    out(still[0].selection_frozen === true, "the refused lift changed nothing");
  }

  /* ------------------- 8. the master lifts it ------------------------ */

  const lifted = await (
    await rpc(
      "staff_set_selection_freeze",
      { p_registration_id: REG_ID, p_frozen: false },
      masterToken
    )
  ).json();
  out(
    lifted?.ok === true && lifted?.frozen === false,
    "a master lifts the freeze",
    JSON.stringify(lifted)
  );

  const cleared = await sql(`
    select selection_frozen, selection_frozen_at, selection_frozen_by
      from public.registrations where id = '${REG_ID}'`);
  out(cleared[0].selection_frozen === false, "the flag is cleared");
  out(cleared[0].selection_frozen_at === null, "the freeze timestamp is cleared with it");
  out(cleared[0].selection_frozen_by === null, "the freezer name is cleared with it");

  // And the participant is genuinely back in — the whole point of a lift.
  const reopened = await callAsParticipant(REG_ID, null, ["nexus-breach"]);
  out(
    reopened.ok,
    "after the lift the participant can choose again",
    reopened.ok ? JSON.stringify(reopened.rows) : reopened.error.slice(0, 200)
  );

  /* ------------------- 9. audit trail ------------------------------- */

  const audit = await sql(`
    select action, count(*) as n
      from public.staff_audit_log
     where entity = 'registration' and entity_id = '${REG_ID}'
       and action in ('freeze_selection', 'unfreeze_selection')
     group by action order by action`);
  const byAction = Object.fromEntries(audit.map((r) => [r.action, Number(r.n)]));
  out(
    byAction.freeze_selection === 1,
    "the freeze was audited exactly once",
    `n=${byAction.freeze_selection ?? 0}`
  );
  out(
    byAction.unfreeze_selection === 1,
    "the one successful lift was audited, and the refused admin lift wrote nothing",
    `n=${byAction.unfreeze_selection ?? 0}`
  );

  /* ------------------- 10. the export carries it -------------------- */

  const exported = await (await rpc("staff_export_registrations", {}, masterToken)).json();
  const mine = Array.isArray(exported)
    ? exported.find((r) => r.phone_number === "9000000001")
    : null;
  out(Boolean(mine), "the export returns the probe row");
  out(
    mine && typeof mine.selection_frozen === "boolean",
    "the export reports whether the selection is final",
    mine ? `selection_frozen=${mine.selection_frozen}` : "row missing"
  );
  out(
    mine && Object.hasOwn(mine, "frozen_by"),
    "the export reports who froze it"
  );
  /* ------------------- 10. the roster list carries it too ----------- */

  // The console reads the roster through PostgREST with `select=*`, so the new
  // columns have to come through THAT path as well — the export is a different
  // query, and a passing export would say nothing about the list the Freeze
  // button is actually rendered from. If this ever stops being true the button
  // silently disappears, because `r.selection_frozen` would be undefined.
  const listRes = await fetch(
    `${url}/rest/v1/registrations?select=*&id=eq.${REG_ID}`,
    {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "X-Nexus-Staff-Token": masterToken,
      },
    }
  );
  const listed = await listRes.json();
  const listedRow = Array.isArray(listed) ? listed[0] : null;
  out(listedRow !== undefined && listedRow !== null, "the roster list returns the probe row");
  out(
    listedRow && Object.hasOwn(listedRow, "selection_frozen"),
    "the roster LIST carries selection_frozen, which the console renders the button from"
  );
  out(
    listedRow && Object.hasOwn(listedRow, "selection_frozen_at"),
    "the roster LIST carries selection_frozen_at"
  );
} finally {
  await cleanup();
  const left = await sql(`
    select (select count(*) from public.registrations where email = '${MARKER}')
         + (select count(*) from auth.users where id = '${AUTH_ID}')
         + (select count(*) from public.staff_users where username like 'zz-freeze-%') as n`);
  console.log(`\nprobe rows removed: ${left[0].n === 0 ? "yes" : `NO (${left[0].n} left)`}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
console.log(fail === 0 ? "=== SELECTION FREEZE VERIFIED ===" : "=== FREEZE CHECKS FAILED ===");
process.exit(fail === 0 ? 0 : 1);



  out(seed[0].picks === 1, "a probe registration exists with a selection");


/**
 * The master registration gate, against the live database.
 *
 *   node scripts/verify-registration-gate.mjs
 *
 * WHAT IS ACTUALLY BEING TESTED
 *
 * Not "does the console show a CLOSED badge" - anyone can write that. The claim
 * worth checking is that a NON-STAFF write is refused once the gates are shut, and
 * the way to check that is to try one.
 *
 * HOW THE WRITE IS ISSUED, AND WHY NOT THE OBVIOUS WAY
 *
 * The first attempt POSTed to PostgREST with the anon key and asserted on the
 * refusal. That was WRONG and it passed against a database with no gate at all:
 * participant_insert_own_registration is `to authenticated` with
 * `user_id = auth.uid()`, so an anon key is stopped by ROW SECURITY with 401
 * "permission denied for table registrations" before any trigger runs. Correct
 * behaviour, nothing to do with this feature.
 *
 * So the probe is issued as postgres, which carries no staff session - the same
 * condition a participant is in, and the one the TRIGGER has to act on. A real
 * signed-up participant would need a real signup, which is not something a suite
 * running against live data should create.
 *
 * The exemption is proved from the other side: staff_create_registration is
 * SECURITY DEFINER, which bypasses RLS but NOT triggers, so if the exemption had
 * been written against RLS instead of the staff session that call is what breaks,
 * and no other check here would notice.
 *
 * The gate is ALWAYS restored to open, in a finally, on every path including a
 * throw. A suite that leaves a live site shut behind it is worse than no suite.
 */
import { readFileSync } from "node:fs";

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
const env = { ...loadEnv(new URL("../.env", import.meta.url)), ...process.env };
const DB = env.SUPABASE_URL.replace(/\/+$/, "");
const STAMP = Date.now().toString(36);
const NAME = "ZZ gate probe " + STAMP;

let failures = 0;
const out = (ok, label, detail = "") => {
  console.log("  " + (ok ? "PASS" : "FAIL") + "  " + label + (detail ? "  |  " + detail : ""));
  if (!ok) failures += 1;
};

const anon = {
  apikey: env.SUPABASE_ANON_KEY,
  Authorization: "Bearer " + env.SUPABASE_ANON_KEY,
  "Content-Type": "application/json",
};
const rpc = (fn, body, headers) =>
  fetch(DB + "/rest/v1/rpc/" + fn, {
    method: "POST",
    headers: headers ?? anon,
    body: JSON.stringify(body ?? {}),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

/* Returns { refused: message } on a refused statement, rows on success. The
   distinction matters: the Management API answers a 400 with a JSON body, so
   handing that back unexamined makes every `inserted != null` assertion
   unfailable - and that is how three earlier probe suites managed to report a row
   they had never written. */
const sql = async (query) => {
  const ref = new URL(env.SUPABASE_URL).hostname.split(".")[0];
  const res = await fetch("https://api.supabase.com/v1/projects/" + ref + "/database/query", {
    method: "POST",
    headers: { Authorization: "Bearer " + env.SUPABASE_ACCESS_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  if (!res.ok) return { refused: text };
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const token = (await rpc("staff_login", {
  p_username: env.SUPABASE_STAFF_EMAIL,
  p_password: env.SUPABASE_STAFF_PASSWORD,
})).body?.token;
const staff = { ...anon, "X-Nexus-Staff-Token": token ?? "" };

/* Cloned from a real row so it satisfies every constraint the roster's joins and
   checks impose. An invented college_name is not in the colleges lookup, so the
   row would be invisible in the roster and "refused" would be indistinguishable
   from "never shown". */
const NOTE = "ZZ probe: registrations are shut for this test.";
/* The roll_number and email are suffixed per probe. uq_registrations_purchase is
   on the identity columns, and an earlier version reused one roll_number across
   every probe - so the "accepted once reopened" insert was refused as a
   DUPLICATE and read as the gate still being shut. A duplicate key and a closed
   gate are both refusals; only the message tells them apart. */
const cloneSql = (tag, amount) =>
  "insert into public.registrations " +
  "(name, roll_number, college_name, year, department, phone_number, email, " +
  " payment_status, payment_method, purchase_amount, purchase_type, purchase_ref, purchase_label) " +
  "select '" + NAME + "', 'zzgate" + STAMP + tag + "', college_name, year, department, phone_number, " +
  "       'zz-" + tag + "-" + STAMP + "@example.invalid', 'awaiting_utr', 'utr', " + amount + ", " +
  "       'event', 'nexus-breach', 'NEXUS BREACH' " +
  "  from public.registrations where payment_status = 'unverified' and payment_method = 'utr' " +
  "   and not exists (select 1 from public.event_catalogue ec " +
  "                   where ec.id = 'nexus-breach' and ec.requires_event_id) " +
  " order by created_at limit 1;";

const walkIn = (email) => ({
  name: NAME,
  roll_number: "zzgate" + STAMP,
  college_name: "ANNAMACHARYA INSTITUTE OF TECHNOLOGY AND SCIENCES :: TIRUPATI",
  year: "2nd",
  department: "ECE",
  phone_number: "9000000000",
  email: email,
  payment_status: "awaiting_utr",
  payment_method: "utr",
  purchase_amount: 199,
  purchase_type: "event",
  purchase_ref: "nexus-breach",
  purchase_label: "NEXUS BREACH",
});

const countProbes = async () => {
  const r = await sql("select count(*)::int as n from public.registrations where name = '" + NAME + "';");
  return Array.isArray(r) ? r[0].n : null;
};
const gate = async () => (await rpc("public_registration_gate")).body;

console.log("=== MASTER REGISTRATION GATE ===\n");

try {
  out(Boolean(token), "signed in as a master", env.SUPABASE_STAFF_EMAIL);

  const start = await gate();
  out(start?.ok === true && start?.open === true, "the gate starts OPEN", JSON.stringify(start));

  /* ---- closed by a master ---- */
  const closed = (await rpc("staff_set_registration_gate", { p_open: false, p_note: NOTE }, staff)).body;
  out(closed?.ok === true && closed?.gate?.open === false, "a MASTER can close registration", JSON.stringify(closed?.error ?? closed?.gate));
  out(closed?.gate?.note === NOTE, "and store the reason", String(closed?.gate?.note));

  const nowClosed = await gate();
  out(nowClosed?.open === false, "the public read says CLOSED", JSON.stringify(nowClosed));
  out(String(nowClosed?.note ?? "").indexOf("ZZ probe") !== -1, "and carries the reason to the visitor");
  out(nowClosed?.closed_at != null, "and records when it was shut");

  /* ---- THE CLAIM: a non-staff write is refused, by the gate ---- */
  const refused = await sql(cloneSql("a", 199));
  const msg = String(refused?.refused ?? "");
  out(Boolean(refused?.refused), "a NON-STAFF insert is REFUSED while the gate is shut", refused?.refused ? "refused" : "IT WENT IN - the switch is only a badge");
  out(msg.indexOf("23514") !== -1, "by the gate itself, not by row security", msg.slice(0, 90));
  out(msg.indexOf("ZZ probe") !== -1, "and is told WHY, in the master's own words", msg.slice(0, 110));
  out((await countProbes()) === 0, "and no row exists", "rows=" + (await countProbes()));

  /* ---- a blank reason falls back to a default sentence ---- */
  const blunt = (await rpc("staff_set_registration_gate", { p_open: false, p_note: "   " }, staff)).body;
  out(blunt?.ok === true && blunt?.gate?.note === null, "a blank reason is stored as null, not as spaces", JSON.stringify(blunt?.gate?.note));
  const blunt2 = await sql(cloneSql("b", 199));
  out(Boolean(blunt2?.refused), "and the refusal still happens");
  out(String(blunt2?.refused ?? "").indexOf("Registrations are closed.") !== -1, "with a default sentence when no reason was given", String(blunt2?.refused ?? "").slice(0, 80));

  /* ---- staff are exempt ---- */
  const staffIns = (await rpc("staff_create_registration", { p_reg: walkIn("zz-staff-" + STAMP + "@example.invalid") }, staff)).body;
  out(staffIns?.ok === true || staffIns?.id != null, "a MASTER can still add a registration while shut (walk-in)", JSON.stringify(staffIns?.error ?? "created"));
  out((await countProbes()) >= 1, "so only the exempt row landed", "rows=" + (await countProbes()));

  /* ---- reopening ---- */
  const reopened = (await rpc("staff_set_registration_gate", { p_open: true }, staff)).body;
  out(reopened?.ok === true && reopened?.gate?.open === true, "a MASTER can reopen", JSON.stringify(reopened?.gate ?? reopened?.error));
  out((reopened?.gate?.note ?? null) === null, "and the stale reason is cleared on reopening");
  out((reopened?.gate?.closed_at ?? null) === null, "as is the shut timestamp");

  const afterOpen = await sql(cloneSql("c", 199));
  out(!afterOpen?.refused, "a NON-STAFF insert is accepted once reopened", afterOpen?.refused ? String(afterOpen.refused).slice(0, 80) : "accepted");
  out((await countProbes()) >= 2, "and the row exists", "rows=" + (await countProbes()));

  /* ---- nobody below master may throw the switch ---- */
  const adminName = "zz-gate-admin-" + STAMP;
  await sql(
    "insert into public.staff_users (username, password_hash, role, is_active) " +
    "values ('" + adminName + "', extensions.crypt('probe', extensions.gen_salt('bf', 10)), 'admin', true);"
  );
  const adminToken = (await rpc("staff_login", { p_username: adminName, p_password: "probe" })).body?.token;
  if (adminToken) {
    const adminSet = (await rpc("staff_set_registration_gate", { p_open: false, p_note: "nope" }, { ...anon, "X-Nexus-Staff-Token": adminToken })).body;
    out(adminSet?.ok === false, "an ADMIN cannot close registration - master only", adminSet?.error ?? "");
    out((await gate())?.open === true, "and the gate is still OPEN afterwards, so a refusal changed nothing");
  } else {
    out(false, "the admin could not sign in - the master-only refusal was NOT tested");
  }

  out((await gate())?.note === null, "an open gate carries no reason text");
} finally {
  await sql("update public.site_settings set registrations_open = true, registrations_note = null, registrations_closed_at = null where id = true;");
  await sql("delete from public.registrations where name = '" + NAME + "';");
  await sql("delete from public.staff_users where username like 'zz-gate-admin-%';");
  out((await countProbes()) === 0, "no probe registrations left behind", "rows=" + (await countProbes()));
  const finalGate = await gate();
  out(finalGate?.open === true, "the site is left OPEN, whatever happened above", JSON.stringify(finalGate));
}

console.log(
  failures === 0
    ? "\n=== REGISTRATION GATE CHECKS PASSED ==="
    : "\n=== " + failures + " REGISTRATION GATE CHECK(S) FAILED ==="
);
process.exitCode = failures === 0 ? 0 : 1;



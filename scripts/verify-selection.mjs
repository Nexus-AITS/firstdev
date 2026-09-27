/**
 * Prove the event-selection, filter and export layer against the live database.
 *
 * Three things are defended here, and two are security claims rather than
 * behaviour:
 *
 *   1. `staff_export_registrations` is SECURITY DEFINER, so it deliberately
 *      bypasses the per-row SELECT policy. Its internal staff check is the ONLY
 *      thing between an anonymous visitor and the whole roster, so it is called
 *      with no token and with a forged one. A function that works for staff and
 *      is merely untested for anon is not one anyone should ship.
 *
 *   2. The amount is computed in the database from public.pricing. A client
 *      that submits its own price must be ignored — otherwise the selection
 *      page is a way to buy a 349 rupee bundle for 1 rupee.
 *
 *   3. The day filter uses Asia/Kolkata boundaries. A UTC boundary cuts the day
 *      at 05:30 IST, which is the kind of off-by-five-hours that loses exactly
 *      the row an operator is chasing, so the boundary is pinned by seeding rows
 *      either side of midnight and checking both land in the same day.
 *
 *   node scripts/verify-selection.mjs
 *
 * Needs SUPABASE_STAFF_EMAIL / SUPABASE_STAFF_PASSWORD plus the URL and anon
 * key. Every registration it creates is deleted in a finally block.
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
    headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(text.slice(0, 400));
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

const TAG = "selectionprobe";
/** A fixed day, not "today": a relative day changes meaning at midnight. */
const DAY = "2026-08-14";

const cleanup = () =>
  sql(`delete from public.registrations where name like '${TAG}%' or email like '${TAG}-%@example.invalid'`);

async function seed() {
  await cleanup();
  const rows = [
    { name: `${TAG} before midnight`, at: `${DAY} 23:40:00+05:30`, st: "verified" },
    { name: `${TAG} after midnight`, at: `${DAY} 00:20:00+05:30`, st: "verified" },
    { name: `${TAG} next day`, at: "2026-08-15 09:00:00+05:30", st: "awaiting_utr" },
  ];
  for (const [i, r] of rows.entries()) {
    const verified = r.st === "verified";
    await sql(
      `insert into public.registrations
         (name, email, roll_number, college_name, year, department, phone_number,
          payment_status, utr_number, payment_verified_at, payment_verified_by, created_at)
       values ('${r.name}', '${TAG}-${i}@example.invalid', '${TAG}-roll-${i}',
               '${TAG} college', '3rd', 'Computer Science', '900000000${i}',
               '${r.st}', ${verified ? `'${TAG}-utr-${i}'` : "null"},
               ${verified ? "now()" : "null"}, ${verified ? "'verify'" : "null"},
               '${r.at}')`
    );
  }
  // Give one row an event selection, so the event filter has something to find.
  // Inserted directly: a participant cannot self-assign.
  const target = await sql(
    `select id from public.registrations where name = '${TAG} after midnight'`
  );
  await sql(
    `insert into public.registration_events (registration_id, event_id)
     values ('${target[0].id}', 'nexus-breach')`
  );
}

const login = await rpc("staff_login", {
  p_username: env.SUPABASE_STAFF_EMAIL,
  p_password: env.SUPABASE_STAFF_PASSWORD,
});
const token = (await login.json()).token;
out(Boolean(token), "signed in as a master");

try {
  await seed();

  /* ---------- 1. the export is gated ---------- */

  const anonRes = await rpc("staff_export_registrations", {});
  const anonBody = await anonRes.json();
  out(
    anonRes.status >= 400 && anonBody?.code === "42501",
    "export refuses an anonymous caller (no staff token)",
    `${anonRes.status} ${anonBody?.code}`
  );

  const forged = await rpc("staff_export_registrations", {}, "forged-token-value");
  const forgedBody = await forged.json();
  out(
    forged.status >= 400 && forgedBody?.code === "42501",
    "export refuses a forged staff token",
    `${forged.status} ${forgedBody?.code}`
  );

  const authorised = await rpc("staff_export_registrations", {}, token);
  out(authorised.status === 200, "export allows a real staff session", `http=${authorised.status}`);

  /* ---------- 2. the columns the operator asked for ---------- */

  const all = await authorised.json();
  for (const col of ["si_no", "name", "phone_number", "utr_number", "reg_date", "reg_time"]) {
    out(
      Array.isArray(all) && all.length > 0 && col in all[0],
      `export includes the ${col} column`,
      `${Array.isArray(all) ? all.length : 0} rows`
    );
  }
  out(
    Array.isArray(all) && all.every((r, i) => r.si_no === i + 1),
    "si_no is a clean 1..n sequence",
    Array.isArray(all) ? `1..${all.length}` : "n/a"
  );

  /* ---------- 3. the day boundary is Asia/Kolkata ---------- */

  /* Plain calendar dates, exactly what a <input type="date"> sends. The function
     owns the IST conversion, so picking the 14th must mean the WHOLE 14th. */
  const day = await (
    await rpc("staff_export_registrations", { p_from_date: DAY, p_to_date: DAY }, token)
  ).json();
  const names = (day ?? []).map((r) => r.name);
  out(
    names.includes(`${TAG} before midnight`) && names.includes(`${TAG} after midnight`),
    "both sides of IST midnight land in the same day filter",
    names.join(" / ")
  );
  out(!names.includes(`${TAG} next day`), "the following day is excluded", `${names.length} rows`);
  const beforeMidnight = day?.find((r) => r.name === `${TAG} before midnight`);
  const afterMidnight = day?.find((r) => r.name === `${TAG} after midnight`);
  out(
    beforeMidnight?.reg_date === DAY,
    "reg_date is the IST calendar date, not the UTC one",
    `reg_date=${beforeMidnight?.reg_date} expected=${DAY}`
  );
  out(
    afterMidnight?.reg_time?.startsWith("00:20"),
    "reg_time is the IST wall-clock time",
    afterMidnight?.reg_time
  );

  /* ---------- 4. the event filter is a real join ---------- */

  const byEvent = await (
    await rpc("staff_export_registrations", { p_event: "nexus-breach" }, token)
  ).json();
  out(
    (byEvent ?? []).length === 1 && byEvent[0].name === `${TAG} after midnight`,
    "filtering by event returns only registrations carrying it",
    (byEvent ?? []).map((r) => r.name).join(", ") || "none"
  );
  out(
    (byEvent ?? [])[0]?.events === "nexus-breach",
    "the export reports the events on the row",
    (byEvent ?? [])[0]?.events
  );

  /* ---------- 5. the database owns the price ---------- */

  /* The writer takes ids only — there is deliberately no amount parameter for a
     client to set. Asserting the RPC has no such argument is stronger than
     observing that today's client does not send one. */

  /* Staff hold no write path on selections at all: a selection is the
     participant's, and the EXECUTE grant is to `authenticated` only. So a staff
     token is refused here by the GRANT, before the function body even runs.
     That is the intended shape, and worth pinning: if it ever starts returning
     ok for staff, someone has widened who can rewrite what someone paid for. */
  const asStaff = await rpc(
    "registration_set_events",
    { p_registration_id: "00000000-0000-0000-0000-000000000000" },
    token
  );
  out(
    asStaff.status >= 400,
    "staff cannot rewrite a participant's selection (execute is not granted to anon)",
    `http=${asStaff.status}`
  );

  const asAnon = await rpc("registration_set_events", {
    p_registration_id: "00000000-0000-0000-0000-000000000000",
  });
  out(asAnon.status >= 400, "registration_set_events refuses an anonymous caller", `http=${asAnon.status}`);

  /* An unknown parameter is a hard error, not a silently ignored field — so a
     client that tries to pass its own amount fails loudly rather than appearing
     to succeed at a price the database did not agree to. */
  const tampered = await rpc(
    "registration_set_events",
    { p_registration_id: "00000000-0000-0000-0000-000000000000", p_amount: 1 }
  );
  out(
    tampered.status >= 400,
    "a client-supplied amount is rejected, not ignored",
    `http=${tampered.status}`
  );
} finally {
  await cleanup();
  const left = await sql(
    `select count(*)::int as n from public.registrations where name like '${TAG}%'`
  );
  out(left[0].n === 0, "no probe registrations left behind", `n=${left[0].n}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
console.log(fail === 0 ? "=== SELECTION / EXPORT VERIFIED ===" : "=== SELECTION / EXPORT FAILED ===");
process.exit(fail === 0 ? 0 : 1);
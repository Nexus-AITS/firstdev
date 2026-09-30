/**
 * One person, several purchases: the roster and the spreadsheet must show ALL of
 * them, each with its own amount, and each verifiable on its own.
 *
 *   node scripts/verify-multi-purchase.mjs      (or: npm run verify:multi)
 *
 * WHY THIS EXISTS
 *
 * Two unique indexes once said "one registration per human", so a second
 * purchase had nowhere to go. The wizard did not refuse it - findMine(email)
 * matched the first row whatever was being bought, and finalize() attached the
 * new reference to it. So buying a bundle and then an event produced ONE row:
 * the bundle, carrying the event's UTR. A live row ended up internally
 * inconsistent, saying purchase_type 'bundle' while its purchase_ref held an
 * event id, which also made its profile resume link point at a bundle that did
 * not contain the event.
 *
 * Migration ...023 replaced those indexes with a per-purchase key, so this file
 * pins the result end to end through the STAFF side, which is where the damage
 * was visible:
 *
 *   1. both purchases exist as their own rows, each with its own amount
 *   2. the export returns BOTH, with their amounts as numbers
 *   3. each row is verified independently and does not disturb the other
 *   4. the same purchase twice is still refused - the rule that should have
 *      survived all along
 *
 * Everything it creates is removed in the finally block.
 */
import { readFileSync } from "node:fs";

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
const url = (env.SUPABASE_URL || "").replace(/\/+$/, "");
const key = env.SUPABASE_ANON_KEY;
const ref = new URL(url).hostname.split(".")[0];
const mgmt = `https://api.supabase.com/v1/projects/${ref}/database/query`;
const PROBE = "zz-multi-probe";
const EMAIL = `${PROBE}@example.com`;

let pass = 0;
let fail = 0;
function out(ok, label, detail = "") {
  if (ok) {
    pass += 1;
    console.log(`PASS  ${label}${detail ? `  |  ${detail}` : ""}`);
  } else {
    fail += 1;
    console.log(`FAIL  ${label}${detail ? `  |  ${detail}` : ""}`);
  }
}

async function sql(query) {
  const res = await fetch(mgmt, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(60_000),
  });
  const parsed = JSON.parse(await res.text());
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

const cleanup = () => sql(`delete from public.registrations where email = '${EMAIL}'`);

/* The rows are inserted already holding a payment reference, the state a
 * participant reaches by finishing the wizard. That is not a shortcut: two CHECK
 * constraints make a row with no reference un-verifiable - chk_registrations_utr_state
 * requires a reference before anything but `awaiting_utr`, and
 * chk_registrations_verified_at requires a timestamp once it IS verified. A probe
 * row without one could never be confirmed, so the test would be asserting
 * against a state no real participant can reach. */
const insert = (type, ref, utr) =>
  sql(
    `insert into public.registrations
       (name, email, roll_number, college_name, year, department, phone_number,
        payment_status, utr_number, purchase_type, purchase_ref)
     values ('Multi Probe', '${EMAIL}', '21ZZM01', 'ZZ Institute', '2nd', 'CSE',
             '9000000123', 'unverified', '${utr}', '${type}', '${ref}')`
  );

try {
  await cleanup();

  const login = await rpc("staff_login", {
    p_username: env.SUPABASE_STAFF_EMAIL,
    p_password: env.SUPABASE_STAFF_PASSWORD,
  });
  const token = (await login.json()).token;
  if (!token) throw new Error("could not sign in as a master");
  out(true, "signed in as a master");

  // A REAL bundle and a REAL event, so the rows are the shape a participant's
  // would be rather than something only a test can produce.
  const pick = (await sql(
    `select id from public.event_catalogue
      where is_active and entry_type = 'individual' order by id limit 1`
  ))[0];
  const bundle = (await sql(`select id from public.bundle_catalogue order by id limit 1`))[0];
  out(
    Boolean(pick && bundle),
    "found a real event and a real bundle to buy",
    `${pick?.id} / ${bundle?.id}`
  );

  // purchase_amount is filled by the trigger from ...020, not written here. That
  // is deliberate: the test asserts the trigger did it, so a change that stops
  // filling it fails here rather than in a spreadsheet somebody notices at month
  // end.
  await insert("bundle", bundle.id, "MPB0000001");
  await insert("event", pick.id, "MPE0000001");

  const rows = await sql(
    `select id, purchase_type, purchase_ref, purchase_label, purchase_amount
       from public.registrations where email = '${EMAIL}' order by created_at`
  );
  out(rows.length === 2, "one person, two purchases -> two rows", `rows=${rows.length}`);
  out(
    rows.every((r) => Number(r.purchase_amount) > 0),
    "and BOTH rows carry the amount paid",
    rows.map((r) => `${r.purchase_type}=${r.purchase_amount}`).join(" ")
  );
  out(
    new Set(rows.map((r) => r.purchase_type)).size === 2,
    "each row is labelled from its OWN purchase",
    rows.map((r) => r.purchase_label).join(" | ")
  );

  // What the spreadsheet receives.
  const exportRes = await rpc(
    "staff_export_registrations",
    { p_from_date: null, p_to_date: null, p_event: "all", p_status: "all" },
    token
  );
  const exported = await exportRes.json();
  const mine = (Array.isArray(exported) ? exported : []).filter((r) => r.email === EMAIL);
  out(
    mine.length === 2,
    "the EXPORT returns both purchases, not one row per person",
    `exported=${mine.length}`
  );
  out(
    mine.length === 2 &&
      mine.every((r) => typeof r.purchase_amount === "number" && r.purchase_amount > 0),
    "each exported row carries its amount as a NUMBER, so Excel can total it",
    mine.map((r) => `${r.purchase_label}=${r.purchase_amount}`).join(" | ")
  );

  // Each verified on its own - the other half of the report. Verification is a
  // PATCH on the row rather than an RPC (staffSetStatus in staff.js is exactly
  // this), so the test issues the same request: staff token, Prefer
  // return=representation, and the verified-by stamp the console sends.
  for (const row of rows) {
    const res = await fetch(`${url}/rest/v1/registrations?id=eq.${encodeURIComponent(row.id)}`, {
      method: "PATCH",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "X-Nexus-Staff-Token": token,
        Prefer: "return=representation",
      },
      body: JSON.stringify({ payment_status: "verified", payment_verified_by: "multi-probe" }),
    });
    const body = await res.json();
    out(
      res.ok && Array.isArray(body) && body.length === 1,
      `verifying the ${row.purchase_type} row succeeds`,
      res.ok ? "ok" : JSON.stringify(body).slice(0, 110)
    );
  }
  const verified = await sql(
    `select purchase_type, payment_status
       from public.registrations where email = '${EMAIL}' order by created_at`
  );
  out(
    verified.length === 2 && verified.every((r) => r.payment_status === "verified"),
    "BOTH rows end up verified",
    verified.map((r) => `${r.purchase_type}=${r.payment_status}`).join(" ")
  );

  // The rule that should have survived all along. Asserted on the ROW COUNT
  // rather than on the insert throwing: the Management API answers a constraint
  // violation with 400 and a message, and whether that surfaces as a thrown error
  // or a returned body is a detail of the transport. What matters is that the
  // third row did not land.
  const before = (await sql(
    `select count(*)::int as n from public.registrations where email = '${EMAIL}'`
  ))[0].n;
  await insert("event", pick.id, "MPE0000002").catch(() => {});
  const stillTwo = await sql(
    `select count(*)::int as n from public.registrations where email = '${EMAIL}'`
  );
  out(
    stillTwo[0].n === before,
    "but buying the SAME event twice is still refused",
    `rows stayed at ${stillTwo[0].n}`
  );
} catch (err) {
  fail += 1;
  console.log(`FAIL  suite aborted  |  ${String(err.message).slice(0, 300)}`);
} finally {
  await cleanup();
  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
}
process.exit(fail ? 1 : 0);


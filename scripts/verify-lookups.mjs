/**
 * The college / department lists, the money totals, and the per-event roster.
 *
 *   node scripts/verify-lookups.mjs      (or: npm run verify:lookups)
 *
 * Colleges and departments are DATA now, not text a participant types. That is
 * only worth something if four things hold, and each failed once while this was
 * being built:
 *
 *   1. the registration form can read the list with NO staff session - it
 *      renders for a signed-out visitor
 *   2. RLS actually lets it. The tables came up with RLS enabled and no policy,
 *      which is the quiet failure: public_lookups answered ok:true with two
 *      EMPTY lists. No error anywhere, just a dropdown rendering nothing -
 *      indistinguishable from "no colleges exist yet"
 *   3. a master can add, and the same name in a different CASE does not become a
 *      second row - that collision is what the feature exists to prevent
 *   4. retiring removes it from the form but keeps the row, because
 *      registrations store the name as text and deleting would change nobody's
 *
 * The finance split and the event roster are checked for SHAPE, not for a
 * particular number: the totals move every time a real payment arrives, and a
 * test asserting "received is 299" would fail the moment one did.
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
const PROBE = "ZZ Verify College";

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

const names = (list) => (list ?? []).map((r) => String(r.name).toLowerCase());
const countProbe = async () =>
  (await sql(`select count(*)::int as n from public.colleges where lower(btrim(name)) = lower('${PROBE}')`))[0].n;

try {
  await sql(`delete from public.colleges where lower(btrim(name)) = lower('${PROBE}')`);

  const login = await rpc("staff_login", {
    p_username: env.SUPABASE_STAFF_EMAIL,
    p_password: env.SUPABASE_STAFF_PASSWORD,
  });
  const token = (await login.json()).token;
  if (!token) throw new Error("could not sign in as a master");
  out(true, "signed in as a master");

  /* 1 & 2 - the form's read, with no staff session */
  const publicRes = await rpc("public_lookups", {}, null);
  const publicBody = await publicRes.json();
  out(publicRes.status === 200 && publicBody?.ok === true, "public_lookups answers with no staff session", `HTTP ${publicRes.status}`);
  // The silent one: ok:true, two empty lists, RLS filtering everything. The
  // seeded rows are the proof, because they exist whether or not they arrive.
  const seeded = (await sql(`select count(*)::int as n from public.colleges where is_active`))[0].n;
  out(
    seeded > 0 && names(publicBody?.colleges).length === seeded,
    "…and returns the SEEDED colleges, not an empty list",
    `table=${seeded} returned=${names(publicBody?.colleges).length}`
  );
  out(Array.isArray(publicBody?.departments), "…and a departments array", `count=${names(publicBody?.departments).length}`);

  /* 3 - adding, and the duplicate that must not become a second row */
  const addBody = await (await rpc("staff_upsert_lookup", { p_kind: "college", p_name: PROBE, p_id: null }, token)).json();
  out(addBody?.ok === true, "a master can add a college", JSON.stringify(addBody).slice(0, 80));

  const afterAdd = await (await rpc("public_lookups", {}, null)).json();
  out(names(afterAdd.colleges).includes(PROBE.toLowerCase()), "…and it appears on the form at once");

  await rpc("staff_upsert_lookup", { p_kind: "college", p_name: "zz verify college", p_id: null }, token);
  out((await countProbe()) === 1, "the same name in a different CASE does not become a second row", `rows=${await countProbe()}`);

  out((await (await rpc("staff_upsert_lookup", { p_kind: "college", p_name: "X", p_id: null }, token)).json())?.ok === false, "a one-character name is refused");
  out((await (await rpc("staff_upsert_lookup", { p_kind: "drop table", p_name: "anything", p_id: null }, token)).json())?.ok === false, "an unknown list is refused, not assembled into a table name");

  /* 4 - retire: off the form, row kept */
  const probeRow = ((await (await rpc("staff_list_lookups", {}, token)).json()).colleges ?? [])
    .find((r) => String(r.name).toLowerCase() === PROBE.toLowerCase());
  out(Boolean(probeRow), "the console's own list includes the new college");

  const retireRes = await rpc("staff_retire_lookup", { p_kind: "college", p_id: probeRow.id }, token);
  const retiredNow = (await sql(`select is_active from public.colleges where id = '${probeRow.id}'`))[0];
  out(
    retiredNow?.is_active === false,
    "a master can retire it",
    // The ROW is the assertion, not the response envelope. The call may answer
    // with a bare object or an array depending on how the function is reached,
    // and a test that reads the envelope reports a failure for a retire that
    // visibly happened - which is worse than no test at all.
    `response=${(await retireRes.text()).slice(0, 60)}`
  );
  const afterRetire = await (await rpc("public_lookups", {}, null)).json();
  const kept = (await sql(`select count(*)::int as n from public.colleges where id = '${probeRow.id}'`))[0].n;
  out(
    !names(afterRetire.colleges).includes(PROBE.toLowerCase()) && kept === 1,
    "retiring takes it OFF the form but KEEPS the row",
    `onForm=${names(afterRetire.colleges).includes(PROBE.toLowerCase())} inTable=${kept}`
  );

  /* the money split - shape, not a number */
  const fin = await (await rpc("staff_finance_summary", {}, token)).json();
  out(fin?.ok === true, "the finance summary answers");
  const money = (x) => x && typeof x.count === "number" && typeof x.amount === "number";
  out(
    money(fin?.to_verify) && money(fin?.received) && money(fin?.awaiting_utr),
    "to verify, received and awaiting are each count + amount",
    JSON.stringify({ to_verify: fin?.to_verify, received: fin?.received })
  );
  out(
    Number.isInteger(fin?.rejected) && Number.isInteger(fin?.unpriced),
    "rejected and unpriced are reported, so a missing price is visible",
    `rejected=${fin?.rejected} unpriced=${fin?.unpriced}`
  );

  /* the per-event roster */
  const event = (await sql(
    `select ec.id from public.event_catalogue ec
       join public.registration_events re on re.event_id = ec.id group by 1 limit 1`
  ))[0];
  if (event) {
    const ev = await (await rpc("staff_list_event_registrations", { p_event_id: event.id }, token)).json();
    out(ev?.ok === true, "the per-event roster answers", ev?.title ?? "");
    out(
      typeof ev?.registered === "number" && Array.isArray(ev.rows) && ev.rows.length === ev.registered,
      "its list length matches the SAME count the card shows",
      `registered=${ev?.registered} rows=${ev?.rows?.length}`
    );
    out("cap" in (ev ?? {}) && "seats_left" in (ev ?? {}), "and it carries the cap and seats left", `cap=${ev?.cap} left=${ev?.seats_left}`);
  } else {
    out(true, "no event has registrations yet, so the per-event roster has nothing to compare");
  }
} catch (err) {
  fail += 1;
  console.log(`FAIL  suite aborted  |  ${String(err.message).slice(0, 300)}`);
} finally {
  await sql(`delete from public.colleges where lower(btrim(name)) = lower('${PROBE}')`);
  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
}
process.exit(fail ? 1 : 0);

  (await sql(`select count(*)::int as n from public.colleges where lower(btrim(name)) = lower('${PROBE}')`))[0].n;

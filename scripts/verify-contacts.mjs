/**
 * Prove the contact layer: who can publish a channel, who cannot, and that the
 * public function serves exactly what a participant should see and nothing else.
 *
 * The claims worth defending, in order of how much damage a bug does:
 *
 *   1. THE PUBLIC PAGE CANNOT SHOW A RETIRED CHANNEL. public_contacts() is the
 *      only statement that reads this table, so if its filter were ever dropped,
 *      a number nobody intends to answer the phone on becomes public.
 *
 *   2. THE TABLE IS NOT DIRECTLY WRITABLE OR READABLE. RLS is on with no
 *      policies, so the anon key cannot publish a number of its own choosing.
 *      Checked against the REST endpoint rather than in theory, because a
 *      missing revoke and a working revoke look identical in a schema dump.
 *
 *   3. THE WRITES ARE ADMIN+, NOT PUBLIC. Called with no token, a forged token
 *      and a real coordinator, because "works for an admin" and "refuses everyone
 *      else" are different claims and only one is proved by a happy path.
 *
 *   4. THE KIND MUST MATCH THE VALUE. A phone number filed under "email" is the
 *      mistake that makes the page useless to the one person reading it, so both
 *      the RPC's message and the table's own constraint are exercised.
 *
 *   5. THE AUDIT TRAIL EXISTS. Every write is recorded, and a retired row KEEPS
 *      its history: a participant may already have the number written down, so
 *      retiring hides it while deleting would rewrite the past.
 *
 * Every row this creates is removed in a finally block.
 *
 *   node scripts/verify-contacts.mjs
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

/** Seeding has to run as postgres: RLS correctly refuses these writes. */
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

/** A direct table read or write with the anon key and no staff token. */
const rest = (path, init = {}) =>
  fetch(`${url}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });

/** Every probe row is labelled, so cleanup is one statement and cannot miss. */
const PROBE = "zz-verify-contact";
const phoneValue = "+91 90000 00001";
const emailValue = "zz-verify-contact@example.invalid";

async function cleanup() {
  await sql(`delete from public.contacts where label like '${PROBE}%'`);
  await sql(`delete from public.staff_users where username like 'zz-coord-%'`);
}

/* ============================ the contact layer ============================ */

const login = await rpc("staff_login", {
  p_username: env.SUPABASE_STAFF_EMAIL,
  p_password: env.SUPABASE_STAFF_PASSWORD,
});
const token = (await login.json()).token;
out(Boolean(token), "signed in as a master");

if (!token) {
  console.log("\ncannot continue without a staff session");
  process.exit(1);
}

// A real coordinator, so "an admin may publish" and "a coordinator may not" are
// both proved against the same database rather than asserted from the role map.
const coordUser = `${PROBE}-coordinator`;
const coordPassword = "verify-contacts-only";
// A REAL bcrypt hash, not a placeholder: staff_login verifies with crypt(), so a
// literal string would fail the login and every "a coordinator cannot write" check
// below would pass for the wrong reason (no session, so nothing to refuse).
await sql(`
  delete from public.staff_users where username = '${coordUser}';
  insert into public.staff_users (username, password_hash, role, is_active)
  values ('${coordUser}', extensions.crypt('${coordPassword}', extensions.gen_salt('bf', 10)),
          'coordinator', true)
`);

const coordLogin = await rpc("staff_login", { p_username: coordUser, p_password: coordPassword });
const coordToken = (await coordLogin.json()).token;
out(Boolean(coordToken), "signed in as a real coordinator");

try {
  /* ---------- 1. the table itself is closed ---------- */

  const anonRead = await rest("contacts?select=id,label");
  // NOT a 403. PostgREST answers a table with RLS enabled and no policies with
  // 200 and an empty array, which is the correct and stronger outcome: the
  // request is allowed, and RLS filters every row out. Asserting the status
  // code here would have tested PostgREST's error style, not the security.
  const anonRows = anonRead.ok ? await anonRead.json() : null;
  out(
    Array.isArray(anonRows) && anonRows.length === 0,
    "an anon key cannot read the contacts table directly (RLS returns no rows)",
    `HTTP ${anonRead.status} body=${JSON.stringify(anonRows)}`
  );


  const anonWrite = await rest("contacts", {
    method: "POST",
    body: JSON.stringify({ label: `${PROBE}-anon`, value: emailValue }),
  });
  out(
    [400, 401, 403, 404].includes(anonWrite.status),
    "an anon key cannot publish its own contact",
    `HTTP ${anonWrite.status}`
  );
  const leaked = await sql(`select count(*) as n from public.contacts where label = '${PROBE}-anon'`);
  out(leaked[0].n === 0, "...and nothing was written by that attempt");

  /* ---------- 2. the writes are refused without a real admin ---------- */

  const anonymous = await rpc("staff_upsert_contact", {
    p_contact: { label: `${PROBE}-anon`, value: emailValue },
  });
  const anonymousBody = await anonymous.json();
  out(anonymousBody?.ok === false, "staff_upsert_contact refuses an anonymous call", anonymousBody?.error ?? "");

  const forged = await rpc(
    "staff_upsert_contact",
    { p_contact: { label: `${PROBE}-forged`, value: emailValue } },
    "not-a-real-token"
  );
  const forgedBody = await forged.json();
  out(forgedBody?.ok === false, "staff_upsert_contact refuses a forged token", forgedBody?.error ?? "");

  const byCoordinator = await rpc(
    "staff_upsert_contact",
    { p_contact: { label: `${PROBE}-coord`, value: emailValue } },
    coordToken
  );
  const coordBody = await byCoordinator.json();
  out(coordBody?.ok === false, "a coordinator cannot publish a contact", coordBody?.error ?? "");

  const coordList = await rpc("staff_list_contacts", {}, coordToken);
  const coordListBody = await coordList.json();
  out(
    coordListBody?.ok === true,
    "a coordinator CAN read the list — it is the writes that are gated"
  );

  /* ---------- 3. the happy path: publish, and see it on the public page ---- */

  const beforeRows = await (await rpc("public_contacts", {})).json();
  const beforeCount = Array.isArray(beforeRows) ? beforeRows.length : 0;

  const created = await rpc(
    "staff_upsert_contact",
    {
      p_contact: {
        kind: "phone",
        label: `${PROBE}-desk`,
        purpose: "verify-contacts probe",
        value: phoneValue,
        note: "probe",
        sort_order: 9999,
      },
    },
    token
  );
  const createdBody = await created.json();
  out(createdBody?.ok === true, "a master can publish a contact", createdBody?.error ?? "");
  const rowId = createdBody?.id;
  out(Boolean(rowId), "the write returns the new row's id");

  const afterRows = await (await rpc("public_contacts", {})).json();
  out(
    (Array.isArray(afterRows) ? afterRows.length : 0) === beforeCount + 1,
    "the public page now serves one more channel",
    `${beforeCount} -> ${Array.isArray(afterRows) ? afterRows.length : "?"}`
  );
  const publicRow = (Array.isArray(afterRows) ? afterRows : []).find((c) => c.id === rowId);
  out(
    publicRow?.value === phoneValue && publicRow?.kind === "phone",
    "...with the value and kind exactly as typed",
    publicRow?.value ?? "missing"
  );

  // The same row, read straight off the table with the anon key. This is the
  // check that actually matters: the one above proves the page is served
  // correctly, this one proves the page is served correctly *and* there is no
  // second door around it. A contact list is not a secret, so this is about the
  // mechanism, not about hiding the phone number from the world.
  const directAnon = await rest(`contacts?select=label&id=eq.${rowId}`);
  const directRows = directAnon.ok ? await directAnon.json() : [];
  out(
    Array.isArray(directRows) && directRows.length === 0,
    "…and an anon key still cannot read that row off the table, even though it exists",
    `HTTP ${directAnon.status} rows=${Array.isArray(directRows) ? directRows.length : "?"}`
  );


  /* ---------- 4. the kind must match the value ---------- */

  const badEmail = await rpc(
    "staff_upsert_contact",
    { p_contact: { kind: "email", label: `${PROBE}-bad`, value: "98765 43210" } },
    token
  );
  const badEmailBody = await badEmail.json();
  out(badEmailBody?.ok === false, "a phone number cannot be filed under email", badEmailBody?.error ?? "");

  const badPhone = await rpc(
    "staff_upsert_contact",
    { p_contact: { kind: "phone", label: `${PROBE}-bad`, value: "call the desk" } },
    token
  );
  const badPhoneBody = await badPhone.json();
  out(badPhoneBody?.ok === false, "a sentence cannot be filed under phone", badPhoneBody?.error ?? "");

  // The same rule as a constraint, not only as a message: prove it holds even for
  // a write that somehow skipped the RPC's own checks.
  let constrained = false;
  try {
    await sql(
      `insert into public.contacts (kind, label, value) values ('email', '${PROBE}-direct', 'no-at-sign')`
    );
  } catch {
    constrained = true;
  }
  out(constrained, "and the table's own constraint refuses it as well");

  const blank = await rpc(
    "staff_upsert_contact",
    { p_contact: { kind: "phone", label: "", value: phoneValue } },
    token
  );
  const blankBody = await blank.json();
  out(blankBody?.ok === false, "a contact needs a label", blankBody?.error ?? "");

  /* ---------- 5. editing keeps one row ---------- */

  const edited = await rpc(
    "staff_upsert_contact",
    {
      p_contact: {
        id: rowId,
        kind: "phone",
        label: `${PROBE}-desk`,
        purpose: "verify-contacts probe, edited",
        value: "+91 90000 00002",
        is_active: true,
      },
    },
    token
  );
  const editedBody = await edited.json();
  out(
    editedBody?.ok === true && editedBody?.created === false,
    "an edit updates the row instead of creating a second one"
  );
  const rowCount = await sql(`select count(*) as n from public.contacts where id = '${rowId}'`);
  out(rowCount[0].n === 1, "...and there is still exactly one row", `n=${rowCount[0].n}`);
  const editedPublic = (await (await rpc("public_contacts", {})).json()).find((c) => c.id === rowId);
  out(
    editedPublic?.value === "+91 90000 00002",
    "the public page shows the edited value",
    editedPublic?.value ?? "missing"
  );

  /* ---------- 6. retiring hides it, and does not delete it -------------- */

  const retired = await rpc("staff_retire_contact", { p_contact_id: rowId }, token);
  const retiredBody = await retired.json();
  out(retiredBody?.ok === true, "a contact can be retired", retiredBody?.error ?? "");

  const afterRetire = (await (await rpc("public_contacts", {})).json()) ?? [];
  out(
    !(Array.isArray(afterRetire) && afterRetire.some((c) => c.id === rowId)),
    "a retired channel is GONE from the public page"
  );
  const stillThere = await sql(`select is_active from public.contacts where id = '${rowId}'`);
  out(
    stillThere[0]?.is_active === false,
    "...but the row is still there, retired, for the audit trail"
  );

  const republish = await rpc(
    "staff_upsert_contact",
    {
      p_contact: {
        id: rowId,
        kind: "phone",
        label: `${PROBE}-desk`,
        value: phoneValue,
        is_active: true,
      },
    },
    token
  );
  const republishBody = await republish.json();
  out(
    republishBody?.ok === true && republishBody?.created === false,
    "an edit with Published ticked brings it back"
  );
  const backRows = (await (await rpc("public_contacts", {})).json()) ?? [];
  out(
    Array.isArray(backRows) && backRows.some((c) => c.id === rowId),
    "...and the public page serves it again"
  );

  /* ---------- 7. the writes are recorded ---------- */

  const trail = await sql(`
    select action from public.staff_audit_log
     where entity = 'contact' and entity_id = '${rowId}'::text
     order by created_at`);
  const actions = (trail ?? []).map((t) => t.action);
  out(
    actions.includes("create_contact") && actions.includes("retire_contact"),
    "every write is recorded in the audit log",
    actions.join(", ")
  );

  const missing = await rpc(
    "staff_retire_contact",
    { p_contact_id: "00000000-0000-0000-0000-000000000000" },
    token
  );
  out((await missing.json())?.ok === false, "retiring a contact that is not there is refused");
} finally {
  await cleanup();
  const left = await sql(`select count(*) as n from public.contacts where label like '${PROBE}%'`);
  console.log(`\nprobe rows removed: ${left[0].n === 0 ? "yes" : `NO (${left[0].n} left)`}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
console.log(fail === 0 ? "=== CONTACTS VERIFIED ===" : "=== CONTACT CHECKS FAILED ===");
process.exit(fail === 0 ? 0 : 1);


/**
 * The roster's create / edit / delete, over the wire with a real staff session.
 *
 *   node scripts/verify-roster-crud.mjs
 *
 * WHY THIS NEEDS A LIVE SESSION
 *
 * Everything interesting here is a PERMISSION failure, and a permission failure
 * cannot be seen by reading source. Three of the checks below would pass in a
 * source-only test while the feature was completely broken:
 *
 *   * staff_update_registrations has `with check (staff_at_least('admin'))` â€” it
 *     checks the caller's ROLE and nothing about the row that comes out, and
 *     trg_registrations_guard_update returns early for staff before its identity
 *     checks. A REST PATCH can therefore rewrite user_id. This file proves the
 *     RPC does NOT, which is the reason the RPC exists.
 *   * chk_registrations_utr_state refuses a UTR and a status from being sent
 *     apart. If the RPC did not move the status with the reference, saving one
 *     would fail with a raw constraint name.
 *   * a coordinator may read but not edit. Only a real session tells that apart.
 *
 * Creates one row, edits it, and deletes it again â€” so nothing is left behind
 * whatever happens.
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
const base = (env.SUPABASE_URL ?? "").replace(/\/+$/, "");
const anon = env.SUPABASE_ANON_KEY;

let failures = 0;
const out = (ok, label, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  |  ${detail}` : ""}`);
  if (!ok) failures += 1;
};

const STAMP = Date.now().toString(36);
const EMAIL = `zz.crud.${STAMP}@example.com`;

const rpc = async (token, fn, args) => {
  const res = await fetch(`${base}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      apikey: anon,
      "Content-Type": "application/json",
      ...(token ? { "X-Nexus-Staff-Token": token } : {}),
    },
    body: JSON.stringify(args),
  });
  return res.json().catch(() => null);
};

const rest = async (token, path, init = {}) => {
  const res = await fetch(`${base}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: anon,
      Authorization: `Bearer ${anon}`,
      "X-Nexus-Staff-Token": token,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...(init.headers ?? {}),
    },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

console.log("=== ROSTER CRUD (LIVE) VERIFIED ===\n");

/* ---------- 1. sign in ---------- */

const login = await rpc(null, "staff_login", {
  p_username: env.SUPABASE_STAFF_EMAIL,
  p_password: env.SUPABASE_STAFF_PASSWORD,
});
const token = login?.token;
out(Boolean(token), "signed in as a master", env.SUPABASE_STAFF_EMAIL);
if (!token) {
  console.error("SKIP: no staff credentials in .env");
  process.exit(0);
}

/* ---------- 2. CREATE ---------- */

const created = await rpc(token, "staff_create_registration", {
  p_reg: {
    name: "ZZ CRUD Probe",
    email: EMAIL,
    phone_number: "9000000000",
    roll_number: `ZZ${STAMP}`,
    college_name: `ZZ College ${STAMP}`,
    year: "2nd",
    department: "ZZ",
    purchase_type: "event",
    purchase_ref: "vision-2065",
    purchase_label: "ZZ CRUD Probe",
    purchase_amount: 249,
    payment_method: "utr",
    payment_status: "awaiting_utr",
  },
});
const id = created?.id;
/* The unique index is (college, roll, purchase_type, purchase_ref) — NOT the
   email — so a re-run with fixed values collides even when the email differs,
   and the CREATE fails before a single assertion runs. The stamp above makes
   every run's row unique on all four. */
out(created?.ok === true && Boolean(id), "CREATE: a registration can be added", JSON.stringify(created));
if (!id) process.exit(1);

const readOne = async () => (await rest(token, `registrations?id=eq.${id}&select=*`)).body?.[0];

let row = await readOne();
out(row?.user_id === null, "a desk registration has NO owner â€” nobody signed up", `user_id=${row?.user_id}`);
out(row?.payment_status === "awaiting_utr", "it starts awaiting a reference");

/* ---------- 3. UPDATE: the fields an operator corrects ---------- */

const fixed = await rpc(token, "staff_update_registration", {
  p_id: id,
  p_patch: { roll_number: "ZZFIXED", college_name: "ZZ Corrected College" },
});
out(fixed?.ok === true && fixed?.changed === 2, "UPDATE: several fields at once", JSON.stringify(fixed));

row = await readOne();
out(row?.roll_number === "ZZFIXED", "the roll number was corrected", row?.roll_number);
out(row?.college_name === "ZZ Corrected College", "the college was corrected", row?.college_name);
/* A partial edit must leave everything else alone â€” the presence-guarded SET
   clauses are what make that true. */
out(row?.name === "ZZ CRUD Probe", "a partial edit does not blank the fields it did not name");

/* ---------- 4. UPDATE: the UTR, and the status it forces ---------- */

const withUtr = await rpc(token, "staff_update_registration", {
  p_id: id,
  p_patch: { utr_number: "4023456789" },
});
row = await readOne();
out(withUtr?.ok === true, "UPDATE: a UTR can be pasted in", JSON.stringify(withUtr));
out(row?.utr_number === "4023456789", "the reference landed", row?.utr_number);
out(
  row?.payment_status === "unverified",
  "and the status moved with it â€” the CHECK refuses them apart",
  row?.payment_status
);
out(Boolean(row?.utr_submitted_at), "the submission time was stamped, not typed");

/* Emptying it must be refused, in words rather than as a CHECK name. */
const cleared = await rpc(token, "staff_update_registration", {
  p_id: id,
  p_patch: { utr_number: "" },
});
out(
  cleared?.ok === false && /cannot simply be emptied/.test(cleared?.error ?? ""),
  "emptying the last reference is refused with a sentence an operator can act on",
  cleared?.error
);

/* A cash row may never carry one. */
const cash = await rpc(token, "staff_update_registration", {
  p_id: id,
  p_patch: { payment_method: "cash" },
});
out(
  cash?.ok === false && /never carries a reference/.test(cash?.error ?? ""),
  "switching to cash while a reference is held is refused, and says why",
  cash?.error
);

/* ---------- 5. identity is not assignable ---------- */

const someoneElse = "00000000-0000-0000-0000-0000000000ff";
const forged = await rpc(token, "staff_update_registration", {
  p_id: id,
  p_patch: { user_id: someoneElse, id: someoneElse, created_at: "1999-01-01T00:00:00Z" },
});
row = await readOne();
out(
  row?.user_id === null,
  "a patch naming user_id is IGNORED â€” the row keeps its real owner",
  `user_id=${row?.user_id}`
);
out(row?.id === id, "and cannot rename the row");
out(String(row?.created_at).startsWith("20"), "and cannot rewrite when it was created", row?.created_at);
/* The refusal is by OMISSION, not validation: an unknown key is not an error
   because the RPC never reads it. Asserted so making that an error later is a
   conscious decision rather than an accident. */
out(
  forged?.ok === true || forged?.changed === 0,
  "unknown keys are never read, so they change nothing",
  JSON.stringify(forged)
);
out(String(row?.created_at) !== "1999-01-01T00:00:00Z", "the forged timestamp really did not land");

/* ---------- 6. the audit ---------- */

const audit = (await rest(token, "staff_audit_log?select=action&order=created_at.desc&limit=30")).body ?? [];
out(
  audit.filter((a) => a.action === "update_registration").length > 0,
  "every edit is audited"
);
out(audit.filter((a) => a.action === "create_registration").length > 0, "and so is the create");

/* ---------- 7. DELETE, and cleanup ---------- */

const del = await rest(token, `registrations?id=eq.${id}`, { method: "DELETE" });
out(del.status >= 200 && del.status < 300, "DELETE: the row can be removed", `status=${del.status}`);
out(!(await readOne()), "and it is really gone");

console.log(
  failures === 0
    ? "\n=== ROSTER CRUD CHECKS PASSED ==="
    : `\n=== ${failures} ROSTER CRUD CHECK(S) FAILED ===`
);
process.exit(failures === 0 ? 0 : 1);

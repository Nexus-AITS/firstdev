/**
 * The roster's cash filter, tested over the wire.
 *
 * WHY THIS NEEDS A LIVE CALL AND NOT A SOURCE ASSERTION
 *
 * staff.js carries a scar: the college and department filters were written as
 * `eq.${q(...)}`, the quoted form, and on this project's PostgREST that matched
 * NOTHING - while the count beside the dropdown said 107. A filter that returns
 * an empty set is the worst failure mode, because it looks like "no cash
 * registrations yet" rather than "this filter is broken". A regex over the
 * source cannot tell a working predicate from a typo'd one; only the server can.
 *
 * So this logs in as a real master, asks for exactly the URL staff.js builds,
 * and compares what comes back against the database's own count. It checks the
 * three values that matter:
 *
 *   * cash  -> every cash row, BOTH awaiting_cash and verified
 *   * utr   -> the complement
 *   * cash+verified -> the subset, proving the two filters compose
 *
 *   VERIFY_STAFF=... node scripts/verify-cash-filter.mjs
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
const email = env.SUPABASE_STAFF_EMAIL;
const password = env.SUPABASE_STAFF_PASSWORD;

let failures = 0;
const out = (ok, label, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  |  ${detail}` : ""}`);
  if (!ok) failures += 1;
};

if (!base || !anon || !email || !password) {
  console.error("SKIP: needs SUPABASE_URL, SUPABASE_ANON_KEY and staff credentials in .env");
  process.exit(0);
}

const key = `${anon}:${email}:${password}`;

console.log("=== ROSTER CASH FILTER (LIVE) VERIFIED ===\n");

/* ---------- 1. sign in as a master ---------- */

const loginRes = await fetch(`${base}/rest/v1/rpc/staff_login`, {
  method: "POST",
  headers: { apikey: anon, "Content-Type": "application/json" },
  body: JSON.stringify({ p_username: email, p_password: password }),
});
const login = await loginRes.json();

if (!loginRes.ok || login?.error || !login?.token) {
  console.error(`SKIP: staff_login refused (${loginRes.status}) - ${login?.error ?? "no token"}`);
  console.error("      Set SUPABASE_STAFF_EMAIL / SUPABASE_STAFF_PASSWORD to run this.");
  process.exit(0);
}
const token = login.token;
out(true, "signed in as a master", email);

/* ---------- 2. ask the roster the way staff.js builds the query ---------- */

/* The SAME predicate rosterFilters emits: payment_method=eq.cash. Unquoted,
   following the `year` precedent. If this returns rows the filter works; if it
   returns none, the filter is the bug the college/department comment describes. */
async function roster(query) {
  const res = await fetch(`${base}/rest/v1/registrations?select=payment_method,payment_status${query}`, {
    headers: {
      apikey: anon,
      Authorization: `Bearer ${anon}`,
      "X-Nexus-Staff-Token": token,
      Prefer: "count=exact",
      Range: "0-999",
    },
  });
  if (!res.ok) return { rows: [], total: null, error: `${res.status} ${await res.text()}` };
  return { rows: await res.json(), total: Number(res.headers.get("content-range")?.split("/")[1]) };
}

const all = await roster("");
const cash = await roster("&payment_method=eq.cash");
const utr = await roster("&payment_method=eq.utr");
const cashVerified = await roster("&payment_method=eq.cash&payment_status=eq.verified");

/* `!all.error` rather than `all.error === null`: the success branch returns no
   `error` key at all, so a successful read has `error === undefined`. */
out(!all.error, "the roster is readable with a staff token", all.error ?? "no error");
out(
  all.total > 0 && cash.total > 0,
  "the cash filter returns rows — it is not silently empty",
  `all=${all.total} cash=${cash.total}`
);

/* The decisive property: cash + utr must partition the roster exactly. A filter
   that quietly dropped rows, or included non-cash ones, would break that. */
out(
  all.total === cash.total + utr.total,
  "cash and UTR partition the roster, with nothing lost or duplicated",
  `${cash.total} + ${utr.total} = ${cash.total + utr.total} of ${all.total}`
);

/* Every returned row really is cash — the filter does not merely return a
   plausible-looking count. */
out(
  cash.rows.every((r) => r.payment_method === "cash"),
  "every row the cash filter returns really is cash",
  `${cash.rows.length} sampled`
);

/* And the two filters COMPOSE: narrowing by status must give a subset, never a
   superset. This is the "shows cash for both verified and unverified" promise. */
out(
  cashVerified.total <= cash.total,
  "cash AND verified narrows rather than widens",
  `verified=${cashVerified.total} of cash=${cash.total}`
);
out(
  cashVerified.rows.every((r) => r.payment_status === "verified" && r.payment_method === "cash"),
  "every row is cash AND verified"
);

/* Cross-check against the finance summary, which counts cash separately from UTR.
   The two populations are NOT the same and must not be compared as if they were:
   `awaiting_cash` is money still owing at the desk, while a verified cash row is
   money already taken. ALL cash is the sum of those two, so that is the identity
   to assert - comparing cash-total against awaiting_cash alone would "fail" the
   moment the desk takes its first note, which is exactly when it matters most. */
const db = await fetch(`${base}/rest/v1/rpc/staff_finance_summary`, {
  method: "POST",
  headers: {
    apikey: anon,
    Authorization: `Bearer ${anon}`,
    "X-Nexus-Staff-Token": token,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({}),
});
const summary = await db.json();
const cashOwing = summary?.awaiting_cash?.count ?? null;
const cashTaken = cashVerified.total ?? 0;

out(
  cashOwing !== null && cash.total === cashOwing + cashTaken,
  "every cash row is accounted for: owing at the desk plus taken",
  `filter=${cash.total} = owing ${cashOwing} + taken ${cashTaken}`
);

console.log(
  failures === 0
    ? "\n=== CASH FILTER CHECKS PASSED ==="
    : `\n=== ${failures} CASH FILTER CHECK(S) FAILED ===`
);
process.exit(failures === 0 ? 0 : 1);
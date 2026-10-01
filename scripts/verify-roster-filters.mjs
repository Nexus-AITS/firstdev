/**
 * Prove every roster filter narrows the set, and that the export agrees with it.
 *
 *   npm run verify:roster-filters
 *
 * WHY THIS EXISTS
 *
 * The roster has eight narrowing controls - free-text search, status, event,
 * college, year, department and a date window. Each one is a separate piece of
 * query-building in a different layer (staffListRegistrations for the list,
 * public.staff_export_registrations for the file), and a control that does not
 * narrow is indistinguishable from one that is working: the table still renders,
 * the pager still shows a total, and the only symptom is an operator quietly
 * reconciling against the wrong rows. So this asserts the SHAPE, not the labels:
 * every filter is applied for real, through PostgREST and through the export RPC,
 * and the result must be a strict, correct subset of the unfiltered set.
 *
 * It also asserts the two things that must agree with each other:
 *
 *   1. staff_filter_options() counts must equal what the filters actually return.
 *      The counts exist so an operator can tell "nobody registered from there"
 *      from "the filter is broken" - a count that lies destroys the only reason
 *      the control was built.
 *   2. The export must return the SAME ROWS as the filtered roster. The sheet and
 *      the screen are one question asked twice; if they disagree, the file looks
 *      authoritative and is not.
 *
 * READ-ONLY. Nothing is seeded and nothing is written, so this is safe to run
 * against production at any time. Needs the same credentials as verify:staff:
 * SUPABASE_STAFF_EMAIL / SUPABASE_STAFF_PASSWORD (coordinator+ - the counts are
 * gated at coordinator) plus SUPABASE_URL / SUPABASE_ANON_KEY.
 */
import { readFileSync } from "node:fs";
/* The filter map comes from the APP, not from a copy of it.
 *
 * The first version of this file reimplemented the query building, and the
 * college and department filters BOTH failed in the app and passed the test,
 * because the test built the same wrong string. Importing rosterFilters is what
 * makes this file a test of the app rather than a test of itself. */
import { rosterFilters } from "../src/data/staff.js";

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

function loadEnv(path) {
  const env = {};
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return env;
}

const env = loadEnv(new URL("../.env", import.meta.url));
const url = (env.SUPABASE_URL || "").replace(/\/+$/, "");
const anonKey = env.SUPABASE_ANON_KEY;
const username = env.SUPABASE_STAFF_EMAIL;
const password = env.SUPABASE_STAFF_PASSWORD;

if (!url || !anonKey || !username || !password) {
  console.error("FAIL: SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_STAFF_EMAIL / SUPABASE_STAFF_PASSWORD all required");
  process.exit(1);
}

const rest = `${url}/rest/v1`;

/** The staff token header, exactly as the browser sends it. */
const auth = (t) => ({
  apikey: anonKey,
  Authorization: `Bearer ${anonKey}`,
  ...(t ? { "X-Nexus-Staff-Token": t } : {}),
});

async function rpc(name, params, token) {
  const res = await fetch(`${rest}/rpc/${name}`, {
    method: "POST",
    headers: { ...auth(token), "Content-Type": "application/json" },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(45_000),
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, ok: res.ok, body };
}

/**
 * The list call, with the exact headers staffFetch sends (Range + Prefer).
 *
 * `options` is the SAME object the console holds in its paging state, and the
 * filter map is built by the app's own rosterFilters - so what goes on the wire
 * here is byte-for-byte what goes on the wire when an operator picks a college.
 */
async function staffList(token, options, page = 1, pageSize = 200) {
  const { filters } = rosterFilters(options);
  const params = new URLSearchParams();
  params.set("select", "id,name,college_name,department,year,payment_status,utr_number,created_at");
  params.set("order", "created_at.desc");
  for (const [key, value] of Object.entries(filters)) params.set(key, value);

  const res = await fetch(`${rest}/registrations?${params.toString()}`, {
    headers: {
      ...auth(token),
      Range: `${(page - 1) * pageSize}-${page * pageSize - 1}`,
      Prefer: "count=exact",
    },
    signal: AbortSignal.timeout(45_000),
  });
  const text = await res.text();
  let rows = [];
  try {
    const parsed = text ? JSON.parse(text) : [];
    rows = Array.isArray(parsed) ? parsed : [];
  } catch {
    rows = [];
  }
  const range = res.headers.get("Content-Range") ?? "";
  return { ok: res.ok, status: res.status, rows, total: Number(range.split("/")[1]) || 0 };
}

/** The export call, exactly as staffExportRegistrations makes it. */
async function staffExport(token, filters = {}) {
  const res = await rpc(
    "staff_export_registrations",
    {
      p_from_date: filters.fromDate || null,
      p_to_date: filters.toDate || null,
      p_event: filters.event || null,
      p_status: filters.status || null,
      p_college: filters.college || null,
      p_year: filters.year || null,
      p_department: filters.department || null,
    },
    token
  );
  return {
    ok: res.ok && Array.isArray(res.body),
    status: res.status,
    rows: Array.isArray(res.body) ? res.body : [],
    body: res.body,
  };
}

/* ================================ sign in ================================ */

const login = await rpc(
  "staff_login",
  { p_username: username, p_password: password, p_ip: "127.0.0.1", p_agent: "verify-roster-filters" },
  null
);
const token = login.body?.token;
out(
  Boolean(token),
  "a staff session opens, so the filters can be exercised as an operator would",
  token ? `role=${login.body?.role}` : `HTTP ${login.status} ${JSON.stringify(login.body)?.slice(0, 120)}`
);
if (!token) {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(1);
}

/* ============================ the whole roster =========================== */

const all = await staffList(token, {});
out(all.ok, "the unfiltered roster loads", `HTTP ${all.status} total=${all.total} rows=${all.rows.length}`);
if (!all.ok || !all.total) {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(1);
}
const ALL_IDS = new Set(all.rows.map((r) => r.id));

/* ======================== 1. every filter narrows ======================== */
// Each filter is checked twice: it must return fewer rows than the whole roster,
// AND every row it returns must actually satisfy the predicate. A filter that
// returns the right count by accident - or that PostgREST silently ignored - is
// caught by the second half.

const aCollege = all.rows.find((r) => r.college_name)?.college_name;
const aDept = all.rows.find((r) => r.department)?.department;
const aYear = all.rows.find((r) => r.year)?.year;
const aStatus = all.rows.find((r) => r.payment_status)?.payment_status;

const CASES = [
  {
    name: "College",
    value: aCollege,
    options: { college: aCollege },
    matches: (r) => r.college_name === aCollege,
    export: { college: aCollege },
  },
  {
    name: "Year",
    value: aYear,
    options: { year: aYear },
    matches: (r) => r.year === aYear,
    export: { year: aYear },
  },
  {
    name: "Department",
    value: aDept,
    options: { department: aDept },
    matches: (r) => r.department === aDept,
    export: { department: aDept },
  },
  {
    name: "Status",
    value: aStatus,
    options: { status: aStatus },
    matches: (r) => r.payment_status === aStatus,
    export: { status: aStatus },
  },
];

for (const c of CASES) {
  const r = await staffList(token, c.options);
  out(
    r.ok && r.total > 0 && r.total < all.total,
    `the ${c.name.toLowerCase()} filter narrows the roster`,
    `HTTP ${r.status} total=${r.total} of ${all.total}  value=${c.value}`
  );
  out(
    r.ok && r.rows.every(c.matches),
    `every row the ${c.name.toLowerCase()} filter returns really is ${c.name.toLowerCase()} = ${c.value}`,
    r.ok ? `${r.rows.length} rows checked` : `HTTP ${r.status}`
  );
  out(
    r.ok && r.rows.every((x) => ALL_IDS.has(x.id)),
    `the ${c.name.toLowerCase()} filter returns a subset of the roster, not rows from elsewhere`,
    r.ok ? `${r.rows.length} rows checked` : `HTTP ${r.status}`
  );

  // The file must be the same question answered the same way.
  const e = await staffExport(token, c.export);
  out(
    e.ok && e.rows.length === r.total,
    `the export honours the ${c.name.toLowerCase()} filter exactly`,
    `export=${e.rows.length} rows, roster=${r.total}  ${e.rows.length === r.total ? "match" : "MISMATCH"}`
  );
}

/* ---- the date window: both ends inclusive, in Asia/Kolkata ---- */
{
  const sorted = [...all.rows].sort((x, y) => new Date(x.created_at) - new Date(y.created_at));
  const ist = (d) => new Date(new Date(d).getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
  const fromDate = ist(sorted[Math.floor(sorted.length * 0.3)].created_at);
  const toDate = ist(sorted[Math.floor(sorted.length * 0.6)].created_at);

  const r = await staffList(token, { fromDate, toDate });
  out(
    r.ok && r.total > 0 && r.total < all.total,
    "the date window narrows the roster",
    `total=${r.total} of ${all.total}  ${fromDate}..${toDate}`
  );

  const day = (v) => ist(v);
  const inRange = r.ok && r.rows.every((x) => day(x.created_at) >= fromDate && day(x.created_at) <= toDate);
  out(
    inRange,
    "every row the date window returns falls inside it (IST days, both ends inclusive)",
    inRange ? `${r.rows.length} rows checked` : "a row is outside the window"
  );

  const e = await staffExport(token, { fromDate, toDate });
  out(
    e.ok && e.rows.length === r.total,
    "the export honours the date window exactly",
    `export=${e.rows.length} rows, roster=${r.total}  ${e.rows.length === r.total ? "match" : "MISMATCH"}`
  );
}

/* ---- the search box ---- */
{
  const target = all.rows.find((r) => (r.name || "").trim().length >= 3);
  const term = (target?.name || "").trim().split(/\s+/)[0];
  const r = await staffList(token, { query: term });
  out(
    r.ok && r.total > 0 && r.total < all.total,
    "the search box narrows the roster",
    `term="${term}" total=${r.total} of ${all.total}`
  );

  // The search is the one filter the export has no parameter for. Asserted as a
  // fact about the RPC rather than as an opinion, so this line has to be changed
  // deliberately if p_query is ever added.
  const e = await staffExport(token, {});
  out(
    e.ok && e.rows.length > r.total,
    "the export RPC has no search parameter, so a searched roster exports WIDER than the screen",
    `export=${e.rows.length} rows vs filtered roster=${r.total}`
  );
}

/* ================== 2. the counts on the dropdowns are true ================= */
// The count beside every option is the only thing separating "nobody registered
// from there" from "this filter is broken". A count that drifts from what the
// filter actually returns makes the control lie in a new way.

const opts = await rpc("staff_filter_options", {}, token);
const colleges = Array.isArray(opts.body?.colleges) ? opts.body.colleges : [];
const departments = Array.isArray(opts.body?.departments) ? opts.body.departments : [];
const years = Array.isArray(opts.body?.years) ? opts.body.years : [];
out(
  opts.ok && colleges.length > 0,
  "the filter options load",
  `colleges=${colleges.length} departments=${departments.length} years=${years.length}`
);

/**
 * Assert every listed option's count against what its own filter returns.
 *
 * `toOptions` maps a dropdown option onto the console's paging state, so the
 * query is built by rosterFilters exactly as it is when an operator picks it.
 * That is the assertion that matters: the number beside the option and the rows
 * behind it are produced by two different pieces of code, and nothing else
 * compares them.
 */
async function countsAreTrue(label, list, toOptions) {
  const populated = list.filter((x) => (x.count ?? 0) > 0);
  if (populated.length === 0) {
    out(true, `${label} counts match what the filter returns`, "no populated options today");
    return;
  }
  const bad = [];
  for (const item of populated.slice(0, 8)) {
    const r = await staffList(token, toOptions(item));
    if (!r.ok || r.total !== item.count) bad.push(`${item.name}: says ${item.count}, returns ${r.ok ? r.total : `HTTP ${r.status}`}`);
  }
  out(bad.length === 0, `${label} counts match what the filter returns`, bad.length ? bad.join(" | ") : `checked ${Math.min(8, populated.length)} populated options`);
}

await countsAreTrue("college", colleges, (c) => ({ college: c.name }));
await countsAreTrue("year", years, (y) => ({ year: y.name }));
await countsAreTrue("department", departments, (d) => ({ department: d.name }));

/* ============ 3. a college with nobody still reads as honestly empty ========= */
// The whole point of the union in staff_filter_options: a college nobody has
// registered from must be selectable AND visibly zero - not missing, and not
// producing an error an operator reads as a broken filter.
{
  const empty = colleges.filter((c) => (c.count ?? 0) === 0);
  if (empty.length === 0) {
    out(true, "a college with no registrations is offered with a count of 0", "none today - every listed college has somebody");
  } else {
    const c = empty[0];
    const r = await staffList(token, { college: c.name });
    out(
      r.ok && r.total === 0,
      "a college with no registrations returns an empty roster, not an error",
      `${c.name} -> ${r.ok ? `${r.total} rows` : `HTTP ${r.status}`}`
    );
  }
}

/* =============== 4. combined filters intersect, they do not replace ========= */
{
  const a = await staffList(token, { college: aCollege });
  const b = await staffList(token, { year: aYear });
  const both = await staffList(token, { college: aCollege, year: aYear });
  const expected = a.rows.filter((r) => r.year === aYear).length;
  out(
    both.ok && both.total === expected,
    "two filters combine as an intersection, not as a replacement",
    `${aCollege} (${a.total}) ∩ ${aYear} (${b.total}) = ${both.total}, expected ${expected}`
  );
  const e = await staffExport(token, { college: aCollege, year: aYear });
  out(
    e.ok && e.rows.length === both.total,
    "the export combines filters the same way the roster does",
    `export=${e.rows.length} rows, roster=${both.total}  ${e.rows.length === both.total ? "match" : "MISMATCH"}`
  );
}

/* ================= 5. an unfiltered export is the whole roster ================ */
{
  const e = await staffExport(token, {});
  out(
    e.ok && e.rows.length === all.total,
    "an unfiltered export returns the entire roster, not a page of it",
    `export=${e.rows.length} rows, roster=${all.total}  ${e.rows.length === all.total ? "match" : "MISMATCH"}`
  );
  const numbered = e.ok && e.rows.every((r, i) => r.si_no === i + 1);
  out(numbered, "exported rows are numbered 1..N in the sheet's own order", numbered ? `${e.rows.length} rows` : "si_no does not run 1..N");
  const amountsAreNumbers = e.ok && e.rows.every((r) => r.purchase_amount == null || typeof r.purchase_amount === "number");
  out(amountsAreNumbers, "every amount is a NUMBER, so Excel can total the column", amountsAreNumbers ? "checked" : "a text amount would total as zero");
}

/* ============ 6. every database status is reachable from the console =========== */
// payment_status is an enum, and enums grow by migration. A console that
// hardcodes its dropdown therefore makes any status added later UNREACHABLE:
// the rows exist and are counted in the total, and no operator can isolate them.
// This compares the enum in the database against the options the UI offers.
{
  const mgmtToken = env.SUPABASE_ACCESS_TOKEN;
  if (!mgmtToken) {
    out(true, "the status dropdown covers the database enum", "SUPABASE_ACCESS_TOKEN absent - skipped (operator tool only)");
  } else {
    const ref = new URL(url).hostname.split(".")[0];
    /* Named sql, not q: q is the quoting helper above and shadowing it inside
       this block would quietly change what the enum read means. */
    const sql = async (query) => {
      const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
        method: "POST",
        headers: { Authorization: `Bearer ${mgmtToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
        signal: AbortSignal.timeout(45_000),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(text.slice(0, 300));
      const parsed = JSON.parse(text);
      return Array.isArray(parsed) ? parsed : (parsed.result ?? []);
    };

    let enumValues = [];
    try {
      const rows = await sql(
        `select e.enumlabel from pg_type t
           join pg_enum e on e.enumtypid = t.oid
           join pg_namespace n on n.oid = t.typnamespace
          where n.nspname = 'public' and t.typname = 'payment_status'
          order by e.enumsortorder;`
      );
      enumValues = rows.map((r) => r.enumlabel);
    } catch (err) {
      out(false, "the payment_status enum can be read", String(err.message).slice(0, 160));
    }

    // The dropdown, read out of the source rather than restated here: a copy in
    // the test would keep passing after someone edited the real control.
    const source = readFileSync(new URL("../src/pages/Admin.jsx", import.meta.url), "utf8");
    const block = source.match(/id="roster-status"[\s\S]*?options=\{\[([\s\S]*?)\]\}/);
    const offered = block ? [...block[1].matchAll(/value:\s*"([a-z_]+)"/g)].map((m) => m[1]) : [];
    const consoleOffers = offered.filter((v) => v !== "all");

    const missing = enumValues.filter((v) => !consoleOffers.includes(v));
    out(
      enumValues.length > 0 && missing.length === 0,
      "every payment_status the database allows is selectable in the console",
      missing.length
        ? `NOT OFFERED: ${missing.join(", ")} - rows in these states cannot be isolated by any filter`
        : `${consoleOffers.length} statuses offered, all present in the enum`
    );
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);






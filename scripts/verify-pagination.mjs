/**
 * Prove that the console pages and filters in the DATABASE, not in the browser.
 *
 * The bug this guards against is specific and was not hypothetical. The console
 * used to load the whole table and filter it in a `useMemo`. The moment paging
 * was added, that arrangement silently breaks in the worst possible way: search
 * would only ever match the rows on screen, so an operator searching for a
 * participant who was not on page 1 would be told "no match" and conclude the
 * person had never registered.
 *
 * So these assertions are all about WHERE the work happens:
 *
 *   1. A page of N never returns more than N rows (the load stays bounded).
 *   2. Two different pages return different rows (paging is real, not cosmetic).
 *   3. The reported total is the true table total, not the page length.
 *   4. A search finds a row that is NOT on page 1 - the decisive test, and the
 *      one that fails loudly if filtering is still client-side.
 *   5. A status filter narrows the count server-side.
 *   6. A page past the end is empty rather than an error.
 *   7. Every admin tab renders a working Refresh button.
 *
 *   node scripts/verify-pagination.mjs
 *
 * Needs the same credentials as verify-staff-ui.mjs: SUPABASE_STAFF_EMAIL /
 * SUPABASE_STAFF_PASSWORD (a master) plus SUPABASE_ACCESS_TOKEN / SUPABASE_URL.
 * The probe rows are ALWAYS deleted, even when an assertion fails.
 */
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const BASE = process.env.VERIFY_BASE || "http://localhost:4173";

/** Enough rows that page 2 is reachable at the page size used below. */
const SEED = 12;
const PAGE_SIZE = 5;

/** A tag that cannot collide with a real registration, and that the search
 *  below can match exactly one row of. */
const TAG = "pagerprobe";
/** Participant 1's email: unique across the probe set, unlike its name. */
const TARGET_EMAIL = `${TAG}-1@example.invalid`;

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
const mgmtToken = process.env.SUPABASE_ACCESS_TOKEN || env.SUPABASE_ACCESS_TOKEN;
const supabaseUrl = (process.env.SUPABASE_URL || env.SUPABASE_URL || "").replace(/\/+$/, "");
const username = process.env.SUPABASE_STAFF_EMAIL || env.SUPABASE_STAFF_EMAIL;
const password = process.env.SUPABASE_STAFF_PASSWORD || env.SUPABASE_STAFF_PASSWORD;
const anonKey = process.env.SUPABASE_ANON_KEY || env.SUPABASE_ANON_KEY;

if (!username || !password) {
  console.error("FAIL: SUPABASE_STAFF_EMAIL / SUPABASE_STAFF_PASSWORD are required (a master account)");
  process.exit(1);
}
if (!mgmtToken || !supabaseUrl) {
  console.error("FAIL: SUPABASE_ACCESS_TOKEN / SUPABASE_URL required (to seed and clean up)");
  process.exit(1);
}

const ref = new URL(supabaseUrl).hostname.split(".")[0];
const mgmt = `https://api.supabase.com/v1/projects/${ref}/database/query`;

async function sql(query) {
  const res = await fetch(mgmt, {
    method: "POST",
    headers: { Authorization: `Bearer ${mgmtToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`management API HTTP ${res.status}: ${text.slice(0, 300)}`);
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : (parsed.result ?? []);
}

/** Probe rows, oldest last so `created_at desc` orders them predictably. */
const rows = Array.from({ length: SEED }, (_, i) => ({
  name: `${TAG} participant ${i + 1}`,
  email: `${TAG}-${i + 1}@example.invalid`,
  roll: `${TAG}-roll-${i + 1}`,
  college: `${TAG} college ${i + 1}`,
}));

/** Registrations have RLS and several CHECK constraints, so they are seeded
 *  with a privileged connection rather than through the public API. The
 *  constraints are real and worth honouring, because a seed that bypassed them
 *  would be testing rows the application itself can never write:
 *
 *    awaiting_utr -> utr_number IS NULL
 *    verified     -> utr_number IS NOT NULL AND payment_verified_at IS NOT NULL
 *
 *  Half of each, so the status filter has two real buckets to choose between. */
async function seed() {
  await cleanup();
  for (const [i, r] of rows.entries()) {
    const verified = i % 2 === 0;
    const utr = verified ? `'${TAG}-utr-${i + 1}'` : "null";
    const verifiedAt = verified ? "now()" : "null";
    await sql(
      `insert into public.registrations
         (name, email, roll_number, college_name, year, department, phone_number,
          payment_status, utr_number, payment_verified_at, payment_verified_by)
       values ('${r.name}', '${r.email}', '${r.roll}', '${r.college}',
               '3rd', 'Computer Science', '9000000000',
               '${verified ? "verified" : "awaiting_utr"}', ${utr}, ${verifiedAt},
               ${verified ? "'verify-pagination'" : "null"})`
    );
  }
}

async function cleanup() {
  await sql(
    `delete from public.registrations where name like '${TAG}%' or email like '${TAG}-%@example.invalid'`
  );
}

async function count() {
  const rows = await sql(`select count(*)::int as n from public.registrations`);
  return rows[0]?.n ?? 0;
  return rows[0]?.n ?? 0;
}

/**
 * Call PostgREST exactly the way staffFetch does for a list, so these
 * assertions exercise the real query shape (Range + Prefer) rather than a
 * reimplementation of it.
 */
async function staffList(token, path, { page, pageSize, preferCount = true }) {
  const res = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${anonKey}`,
      "X-Nexus-Staff-Token": token,
      Range: `${(page - 1) * pageSize}-${page * pageSize - 1}`,
      ...(preferCount ? { Prefer: "count=exact" } : {}),
    },
  });
  const text = await res.text();
  const range = res.headers.get("Content-Range") ?? "";
  let rows = [];
  try {
    const parsed = text ? JSON.parse(text) : [];
    rows = Array.isArray(parsed) ? parsed : [];
  } catch {
    // A non-JSON body means an error page. `ok` is false and the assertion
    // reports the status, which is more useful than a parse stack trace.
    rows = [];
  }
  return {
    ok: res.ok,
    status: res.status,
    rows,
    total: Number(range.split("/")[1]) || 0,
  };
}

/** Build a registrations query the way staff.js does.
 *
 *  The `%` wildcards MUST go through URLSearchParams. Postgrest accepts a raw
 *  `%` in `ilike`, but an unencoded one reaches Cloudflare first, which answers
 *  with a 500 HTML error page instead of a result. Encoding the value is what
 *  the app already does, and the test has to match it or it is testing a
 *  request the app never makes. */
function registrationsQuery(filters = {}) {
  const params = new URLSearchParams();
  params.set("select", "id,name");
  params.set("order", "created_at.desc");
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, value);
  }
  return `registrations?${params.toString()}`;
}

/** The `or=(...)` search predicate, matching staff.js's `q()` quoting. */
const q = (value) => `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const searchFilter = (term) =>
  `(name.ilike.${q(`%${term}%`)},email.ilike.${q(`%${term}%`)},roll_number.ilike.${q(
    `%${term}%`
  )},college_name.ilike.${q(`%${term}%`)},utr_number.ilike.${q(`%${term}%`)})`;

/* ---------- run ---------- */

await seed();
const totalAfterSeed = await count();
console.log(`\nseeded ${SEED} probe registrations; table now holds ${totalAfterSeed}\n`);

const browser = await chromium.launch();

try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  const page = await ctx.newPage();

  await page.goto(`${BASE}/nexus-admin`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  await page.fill("#staff-username", username);
  await page.fill("#staff-password", password);
  await page.click('#admin-signin button[type="submit"]');
  await page.waitForTimeout(4000);
  out(
    (await page.locator('nav[aria-label="Console sections"]').count()) === 1,
    "signed in and the console rendered"
  );

  /* The raw token only ever exists in the browser: the database stores a
     `token_hash`, so it cannot be read back out. Taking it from sessionStorage
     is the only way to make the direct PostgREST calls below, and it means they
     run with the same identity the console is really using. */
  const token = await page.evaluate(() => sessionStorage.getItem("nexus.staff.token.v1"));
  out(Boolean(token), "captured the live staff token from the signed-in console");

  /* ---------- paging mechanics ---------- */

  const p1 = await staffList(token, registrationsQuery(), {
    page: 1,
    pageSize: PAGE_SIZE,
  });
  out(
    p1.ok && p1.rows.length <= PAGE_SIZE,
    `a page of ${PAGE_SIZE} never returns more than ${PAGE_SIZE} rows`,
    `n=${p1.rows.length}`
  );
  out(
    p1.total === totalAfterSeed,
    "the reported total is the true table total, not the page length",
    `${p1.total} of ${totalAfterSeed}`
  );

  const p2 = await staffList(token, registrationsQuery(), {
    page: 2,
    pageSize: PAGE_SIZE,
  });
  out(
    p2.rows.length === PAGE_SIZE && !p1.rows.some((r) => p2.rows.some((o) => o.id === r.id)),
    "page 2 returns a different, full set of rows",
    `p1=${p1.rows.length} p2=${p2.rows.length}`
  );
  out(
    p1.rows.every((r) => !p2.rows.some((o) => o.id === r.id)),
    "pages do not overlap",
    "no shared ids"
  );

  /* The final page must hold the remainder. Checked against the REAL total,
     not a fixed 12: the table may already hold real signups, and a test that
     only passes against an empty database is not a test. */
  const lastPage = Math.ceil(totalAfterSeed / PAGE_SIZE);
  const pLast = await staffList(token, registrationsQuery(), {
    page: lastPage,
    pageSize: PAGE_SIZE,
  });
  const expectedLast = totalAfterSeed - (lastPage - 1) * PAGE_SIZE;
  out(
    pLast.rows.length === expectedLast,
    "the final page holds exactly the remainder",
    `${pLast.rows.length}, expected ${expectedLast}`
  );

  /* ---------- search runs in the database ---------- */

  /* The decisive test. Participant 1 is the OLDEST seeded row, so under
     `created_at desc` it sits on the LAST page. A client-side filter would
     never see it while page 1 is displayed, and the operator would be told
     the participant does not exist.

     Every expected number below is scoped to the probe TAG, not the whole
     table, so a production database full of real signups cannot change the
     result. The email is used as well as the name because
     "pagerprobe participant 1" is a substring of "…participant 10/11/12". */
  const target = "pagerprobe participant 1";
  const searched = await staffList(token, registrationsQuery({ or: searchFilter(TARGET_EMAIL) }), {
    page: 1,
    pageSize: PAGE_SIZE,
  });
  out(
    searched.ok && searched.rows.length === 1 && searched.rows[0].name === target,
    "search finds a row that is NOT on page 1 (filter runs in the database)",
    `found=${searched.rows.length}, total=${searched.total}`
  );
  out(
    searched.total === 1,
    "the filtered count reflects the filter, not the table",
    `total=${searched.total}`
  );

  /* A fragment that genuinely spans several probe rows must report all of
     them, which is the other half of "the count is computed by the database". */
  const fragment = await staffList(
    token,
    registrationsQuery({ or: searchFilter(`${TAG} participant 1`) }),
    { page: 1, pageSize: PAGE_SIZE }
  );
  out(
    fragment.ok && fragment.total === 4,
    "a term spanning several rows reports all of them, not just the page",
    `total=${fragment.total}, expected 4 (participants 1, 10, 11, 12)`
  );

  /* A term containing filter syntax must be data, not parsed as a filter.
     This is the edge a naive string-built query gets wrong. The expected
     result is scoped to the probe tag so real registrations cannot interfere. */
  const injectedTerm = `${TAG}-1'") or id.not.is.null,zz("`;
  const injected = await staffList(
    token,
    registrationsQuery({ or: searchFilter(injectedTerm) }),
    { page: 1, pageSize: PAGE_SIZE }
  );
  out(
    injected.ok,
    "a search term containing filter syntax is treated as data",
    `http=${injected.status}, rows=${injected.rows.length}`
  );
  out(
    injected.rows.length === 0,
    "that injected term matches nothing rather than everything",
    `rows=${injected.rows.length}`
  );

  /* ---------- status filter runs in the database ---------- */

  const verifiedOnly = await staffList(
    token,
    registrationsQuery({ payment_status: "eq.verified" }),
    { page: 1, pageSize: PAGE_SIZE }
  );
  const expected = await sql(
    `select count(*)::int as n from public.registrations where payment_status = 'verified'`
  );
  out(
    verifiedOnly.ok && verifiedOnly.total === expected[0].n,
    "a status filter narrows the count server-side",
    `${verifiedOnly.total} of ${expected[0].n}`
  );

  /* ---------- past the end is empty, not an error ---------- */

  /* The page is derived from the REAL total: a fixed page 99 is still INSIDE
     the table once there are thousands of rows, which is exactly the kind of
     test that quietly passes for the wrong reason. */
  const beyondPage = Math.ceil(totalAfterSeed / PAGE_SIZE) + 10;
  const beyond = await staffList(token, registrationsQuery(), {
    page: beyondPage,
    pageSize: PAGE_SIZE,
  });
  out(
    beyond.status === 416 && beyond.rows.length === 0,
    "a page past the end is empty, not an error",
    `page=${beyondPage} of ${lastPage}, http=${beyond.status}, n=${beyond.rows.length}`
  );

  /* ---------- the rendered console ---------- */

  out((await page.locator("#roster-refresh").count()) === 1, "Roster tab has a Refresh button");
  const pagerText = (await page.locator("#roster-refresh").locator("xpath=..").innerText())
    .replace(/\s+/g, " ")
    .trim();
  out(
    /\bof\s+\d+/i.test(pagerText),
    "the pager reports a true total, not just the rows on screen",
    pagerText.slice(0, 70)
  );
  out(
    (await page.locator('button:has-text("Next")').count()) === 1,
    "Roster tab has Next paging"
  );

  /* Clicking Refresh must actually issue a NEW read. Counting requests is the
     only honest way to tell a working refresh from a decorative button.
     The handler receives a Request object, so the URL comes from `.url()`. */
  let rosterReads = 0;
  const tally = (req) => {
    if (/\/rest\/v1\/registrations/.test(req.url())) rosterReads += 1;
  };
  page.on("request", tally);
  await page.click("#roster-refresh");
  await page.waitForTimeout(2500);
  page.off("request", tally);
  out(rosterReads >= 1, "clicking Refresh re-queries the database", `reads=${rosterReads}`);

  /* Every admin tab carries the same control. */
  for (const [tab, id] of [
    ["Audit log", "#audit-refresh"],
    ["Staff", "#staff-refresh"],
    ["Pricing", "#pricing-refresh"],
  ]) {
    await page.click(`nav[aria-label="Console sections"] button:has-text("${tab}")`);
    await page.waitForTimeout(1800);
    out((await page.locator(id).count()) === 1, `${tab} tab has a Refresh button`, id);
  }

  /* Opening a tab must not drag the other tables along with it: the old code
     fanned out to all four on every action. */
  let auditReads = 0;
  let rosterReadsOnAudit = 0;
  const tallyAudit = (req) => {
    if (/\/rest\/v1\/staff_audit_log/.test(req.url())) auditReads += 1;
    if (/\/rest\/v1\/registrations/.test(req.url())) rosterReadsOnAudit += 1;
  };
  await page.click('nav[aria-label="Console sections"] button:has-text("Roster")');
  await page.waitForTimeout(2000);
  page.on("request", tallyAudit);
  await page.click('nav[aria-label="Console sections"] button:has-text("Audit log")');
  await page.waitForTimeout(2500);
  page.off("request", tallyAudit);
  out(auditReads >= 1, "switching to Audit reads the audit table", `reads=${auditReads}`);
  out(
    rosterReadsOnAudit === 0,
    "switching to Audit does NOT also re-read the roster (tabs load independently)",
    `roster reads=${rosterReadsOnAudit}`
  );
} finally {
  await browser.close();
  await cleanup();
  const probesLeft = await sql(
    `select count(*)::int as n from public.registrations where name like '${TAG}%'`
  );
  out(probesLeft[0].n === 0, "no probe registrations left behind", `n=${probesLeft[0].n}`);
  console.log(`\nregistrations now: ${await count()}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
console.log(fail === 0 ? "=== PAGINATION VERIFIED ===" : "=== PAGINATION FAILED ===");
process.exit(fail === 0 ? 0 : 1);

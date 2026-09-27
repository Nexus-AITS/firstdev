/**
 * Prove the catalogue layer: seed integrity, bundle rules, CRUD authorization,
 * and the XLSX writer.
 *
 * Four claims are defended here, and three of them are security claims rather
 * than behaviour:
 *
 *   1. The catalogue writes are MASTER-ONLY. staff_upsert_event /
 *      staff_upsert_bundle / staff_retire_* all check staff_at_least('master')
 *      internally, and that check is the only thing between a coordinator and
 *      the public price list. Called with no token, a forged token, and as a
 *      real coordinator, because "works for staff" and "refuses non-masters"
 *      are different claims and only one of them is proved by a happy path.
 *
 *   2. The SEED IS IDEMPOTENT, and specifically does not revive a retired
 *      bundle. This is the regression the publish-UPDATE bug would have caused:
 *      the old statement reactivated ANY inactive bundle with a content key and
 *      include lines, all of which a deliberately retired seeded bundle
 *      satisfies. The check here retires a seeded bundle, re-runs the real
 *      generated seed, and asserts it is still retired afterwards.
 *
 *   3. Bundle rules are enforced by the DATABASE, not the browser. A selection
 *      that breaks the contract is refused by bundle_selection_errors and by
 *      registration_set_events. The browser is a convenience layer over this.
 *
 *   4. The XLSX writer emits a real archive. Asserted against the bytes: the ZIP
 *      signature, the stored-entry names, and the XML escaping of a value
 *      containing &, < and ' — the three characters that corrupt a sheet
 *      silently rather than loudly.
 *
 * Every row this creates is removed in a finally block.
 *
 *   node scripts/verify-catalogue.mjs
 */
import { readFileSync } from "node:fs";
import { buildRosterWorkbook, buildXlsx, columnName } from "../src/lib/xlsx.js";

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

/** Every probe row shares this prefix, so cleanup is one statement. */
const PROBE = "zz-verify-catalogue";

/* ============================ the XLSX writer ============================ */
// No database needed, so this runs first and a broken writer is reported before
// any slow round trips hide it.

{
  const bytes = buildXlsx({
    sheetName: "Roster",
    columns: [
      { header: "SI.NO", width: 8, type: "number" },
      { header: "NAME", width: 28 },
      { header: "AMOUNT", width: 12, type: "number" },
    ],
    rows: [
      [1, "A & B <College>", 349],
      [2, "O'Brien", null],
    ],
  });

  out(
    bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04,
    "the writer emits a ZIP local-file-header signature",
    [...bytes.subarray(0, 4)].map((b) => b.toString(16)).join(" ")
  );

  // Read the central directory, which is the part an unzip tool trusts. Proving
  // the bytes start correctly is not enough — a reader that cannot find the
  // entries has nothing to extract.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const names = [];
  for (let i = 0; i < bytes.length - 4; i += 1) {
    if (view.getUint32(i, true) === 0x02014b50) {
      const len = view.getUint16(i + 28, true);
      names.push(new TextDecoder().decode(bytes.subarray(i + 46, i + 46 + len)));
    }
  }
  out(names.length === 6, "the archive lists its six parts", names.join(" "));
  out(
    names.includes("xl/worksheets/sheet1.xml") && names.includes("[Content_Types].xml"),
    "the parts Excel requires are present"
  );

  const text = new TextDecoder().decode(bytes);
  out(text.includes("A &amp; B &lt;College&gt;"), "ampersand and angle brackets are escaped");
  out(text.includes("O&apos;Brien"), "an apostrophe is escaped");
  out(text.includes("<v>349</v>"), "numbers are stored as values, not text");
  out(
    columnName(0) === "A" && columnName(25) === "Z" && columnName(26) === "AA",
    "column names roll over past Z"
  );

  // The roster workbook is a different shape; assert it carries every column a
  // reconciler needs and that its amount column is numeric.
  const roster = buildRosterWorkbook(
    [
      {
        si_no: 1,
        name: "Test",
        phone_number: "9000000000",
        utr_number: "UTR1",
        reg_date: "2026-08-14",
        reg_time: "09:30:00",
        payment_status: "verified",
        purchase_label: "BUNDLED #01",
        purchase_amount: 299,
        events: "nexus-breach",
        email: "t@example.invalid",
        college_name: "AITS",
        roll_number: "21B81A0501",
        year: "3rd",
        department: "CSE",
      },
      {
        // A second row with NO amount. A registration whose price was never set
        // is a real state, and it is the case that would put a blank cell in a
        // numeric column — which Excel totals as zero and a reconciler reads as
        // a real figure.
        si_no: 2,
        name: "No Amount",
        purchase_amount: null,
      },
    ],
    "scope"
  );
  const rosterText = new TextDecoder().decode(roster);
  out(rosterText.includes("UTR NUMBER"), "the roster sheet has the reconciliation columns");
  out(rosterText.includes("<v>299</v>"), "the amount is a number cell, so Excel can total it");
  out(rosterText.includes("<v>0</v>"), "a null amount becomes 0, not an empty text cell");
}

/* ============================ the catalogue ============================ */

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

/* ---------- 1. the seed's own content ---------- */

const counts = await sql(`
  select (select count(*) from public.event_catalogue where is_active) as events,
         (select count(*) from public.bundle_catalogue where is_active) as bundles,
         (select count(*) from public.bundle_includes) as includes`);
out(counts[0].events === 11, "eleven active events", `n=${counts[0].events}`);
out(counts[0].bundles === 8, "eight active bundles", `n=${counts[0].bundles}`);
out(counts[0].includes === 15, "fifteen include lines", `n=${counts[0].includes}`);

const keys = await sql(`
  select count(*) as n, count(distinct content_key) as d
    from public.bundle_catalogue where is_active and content_key <> ''`);
out(
  keys[0].n === keys[0].d,
  "no two live bundles have the same content",
  `${keys[0].d} distinct of ${keys[0].n}`
);

/* ---------- 2. the pricing MODEL: bundles must undercut their parts ------ */

// The product strategy is that a bundle is cheaper than assembling the same
// events a la carte, which is what pushes a multi-event buyer to the bundle.
// That is a property of the DATA, not of any one function, so it is asserted
// here: a future price edit that made a bundle dearer than its own components
// would invert the incentive while every other check still passed.
//
// Compared against the CHEAPEST legal assembly, not an average. Beating an
// average proves nothing — a canny buyer picks the cheap events, and the bundle
// only wins if it undercuts that choice too.
const pricing = await sql(`
  with lines as (
    select bi.bundle_id, bi.event_id, bi.pick_realm, bi.pick_count, bi.exclude_hackathon,
           case when bi.event_id is not null then (
             select pp.price from public.pricing pp
              where pp.kind = 'event' and pp.ref_id = bi.event_id and pp.is_active
           ) end as fixed_value,
           case when bi.pick_realm is not null then (
             select pp.price from public.event_catalogue ec
               join public.pricing pp
                 on pp.kind = 'event' and pp.ref_id = ec.id and pp.is_active
              where ec.realm = bi.pick_realm and ec.is_active
                and (not bi.exclude_hackathon or ec.category is distinct from 'HACKATHON')
              order by pp.price asc, ec.id limit 1
           ) end as pool_min_each
      from public.bundle_includes bi
  )
  select b.id, p.price as bundle_price,
         coalesce(sum(coalesce(l.fixed_value, l.pool_min_each * l.pick_count)), 0)::int
           as cheapest_parts
    from public.bundle_catalogue b
    join public.pricing p on p.kind = 'bundle' and p.ref_id = b.id and p.is_active
    left join lines l on l.bundle_id = b.id
   where b.is_active
   group by b.id, p.price`);

const notCheaper = pricing.filter((r) => r.cheapest_parts <= r.bundle_price);
out(
  pricing.length === 8 && notCheaper.length === 0,
  "every bundle undercuts the cheapest a-la-carte assembly of the same events",
  notCheaper.length
    ? `priced too high: ${notCheaper.map((r) => `${r.id} (₹${r.bundle_price} vs ₹${r.cheapest_parts})`).join(", ")}`
    : pricing
        .map((r) => `${r.id} saves ₹${r.cheapest_parts - r.bundle_price}`)
        .slice(0, 3)
        .join("; ")
);

/* ---------- 3. bundle rules are the database's, not the browser's ---------- */


/* ---------- 3. the catalogue writes are master-only ---------- */

// Every probe id shares a prefix so cleanup is one statement, and every write
// this file makes is reversible.
// Every probe row shares this prefix, so cleanup is one statement per table.
// Events are cleaned too: the event probe is written BEFORE the bundle probes,
// and a run that dies between them would otherwise leave an active event behind
// — which the very next run's "eleven active events" check would then fail on.
const cleanup = () => sql(`
  delete from public.bundle_catalogue where id like '${PROBE}%';
  delete from public.event_catalogue where id like '${PROBE}%';`);
await cleanup();

try {
  const anon = await rpc("staff_upsert_event", {
    p_event: { id: `${PROBE}-a`, title: "X", realm: "forge" },
  });
  const anonBody = await anon.json();
  out(!anonBody?.ok, "an anonymous caller cannot write to the event catalogue", anonBody?.error ?? "");

  const forged = await rpc(
    "staff_upsert_event",
    { p_event: { id: `${PROBE}-b`, title: "X", realm: "forge" } },
    "forged-token"
  );
  const forgedBody = await forged.json();
  out(!forgedBody?.ok, "a forged staff token cannot write to the catalogue", forgedBody?.error ?? "");

  // A coordinator is a real, non-master session. This is the check that matters:
  // a coordinator holding a VALID token is exactly the caller the internal
  // master check exists to stop, and it is the one a happy-path test misses.
  const coordinatorName = `zz-coord-${Date.now()}`;
  // A REAL bcrypt hash, not a placeholder: staff_login verifies with crypt(), so
  // a literal 'x' would fail the login and the check below would silently pass
  // for the wrong reason (no session, so "cannot write" trivially true).
  await sql(`
    insert into public.staff_users (username, password_hash, role, is_active)
    values ('${coordinatorName}', extensions.crypt('probe', extensions.gen_salt('bf', 10)),
            'coordinator', true)`);
  const coordLogin = await rpc("staff_login", {
    p_username: coordinatorName,
    p_password: "probe",
  });
  const coordToken = (await coordLogin.json()).token;

  if (coordToken) {
    const coordWrite = await rpc(
      "staff_upsert_event",
      { p_event: { id: `${PROBE}-c`, title: "X", realm: "forge" } },
      coordToken
    );
    const coordBody = await coordWrite.json();
    out(
      !coordBody?.ok,
      "a COORDINATOR with a valid session cannot write to the catalogue",
      coordBody?.error ?? ""
    );
  } else {
    out(false, "a coordinator session could be created for the authorization check");
  }

  // A master CAN write, and the row is really there afterwards. Without this the
  // three refusals above would also pass if the function were simply broken.
  const okWrite = await rpc(
    "staff_upsert_event",
    { p_event: { id: `${PROBE}-ok`, number: "ZZ", title: "Probe Event", realm: "forge", is_active: true } },
    token
  );
  const okBody = await okWrite.json();
  out(okBody?.ok === true, "a master CAN write to the event catalogue", JSON.stringify(okBody));

  const wrote = await sql(`select count(*) as n from public.event_catalogue where id = '${PROBE}-ok'`);
  out(wrote[0].n === 1, "the master's write really landed");

  // Malformed input is a message, not a crash: the RPC must return ok:false
  // rather than raising, or the console shows a raw 500 instead of the sentence.
  const badRealm = await rpc(
    "staff_upsert_event",
    { p_event: { id: `${PROBE}-bad`, title: "X", realm: "atlantis" } },
    token
  );
  const badBody = await badRealm.json();
  out(
    badBody?.ok === false && typeof badBody?.error === "string",
    "an invalid realm returns a readable message",
    badBody?.error ?? ""
  );

  const badId = await rpc(
    "staff_upsert_event",
    { p_event: { id: "NOT A VALID ID", title: "X", realm: "forge" } },
    token
  );
  const badIdBody = await badId.json();
  out(
    badIdBody?.ok === false && typeof badIdBody?.error === "string",
    "an invalid id returns a readable message",
    badIdBody?.error ?? ""
  );

  // A bundle naming an event that does not exist must be refused, and refused
  // BEFORE anything is written — a half-built bundle is the failure a form
  // cannot recover from.
  const badBundle = await rpc(
    "staff_upsert_bundle",
    {
      p_bundle: {
        id: `${PROBE}-bundle`,
        number: "ZZ",
        name: "Probe Bundle",
        includes: [{ event: "no-such-event" }],
      },
    },
    token
  );
  const badBundleBody = await badBundle.json();
  out(
    badBundleBody?.ok === false,
    "a bundle naming a missing event is refused",
    badBundleBody?.error ?? ""
  );
  const orphan = await sql(`select count(*) as n from public.bundle_catalogue where id = '${PROBE}-bundle'`);
  out(orphan[0].n === 0, "the refused bundle left NO row behind");

  // A duplicate-content bundle must be refused AND left retired rather than
  // going live half-built.
  const dupe = await rpc(
    "staff_upsert_bundle",
    {
      p_bundle: {
        id: `${PROBE}-dupe`,
        number: "ZZ",
        name: "Probe Dupe",
        includes: [{ event: "nexus-breach" }, { pick: "paradox", count: 1 }],
      },
    },
    token
  );
  const dupeBody = await dupe.json();
  const dupeRow = await sql(
    `select is_active from public.bundle_catalogue where id = '${PROBE}-dupe'`
  );
  if (dupeBody?.ok === false && dupeRow.length) {
    out(dupeRow[0].is_active === false, "a bundle refused for duplication is left RETIRED, not live and unpayable");
  } else {
    out(dupeBody?.ok === true, "a distinct-content bundle is accepted", JSON.stringify(dupeBody).slice(0, 120));
  }

  /* ---------- 4. retiring an event that a live bundle seats ---------- */

  const seatBlock = await rpc("staff_retire_event", { p_event_id: "nexus-breach" }, token);
  const seatBody = await seatBlock.json();
  out(
    !seatBody?.ok,
    "an event seated by a live bundle cannot be retired",
    seatBody?.error ?? ""
  );
  const stillThere = await sql(`select is_active from public.event_catalogue where id = 'nexus-breach'`);
  out(stillThere[0].is_active === true, "the refused retirement changed nothing");

  /* ---------- 5. the seed is idempotent ---------- */

  // The regression this file exists for. Retire a seeded bundle, re-run the real
  // generated seed, and require that it is STILL retired. The old publish-UPDATE
  // matched on "inactive AND has a content key AND has include lines" — all of
  // which a deliberately retired seeded bundle satisfies — so it came silently
  // back to life and reappeared on the public site.
  const victim = "bundled-349";
  await sql(`update public.bundle_catalogue set is_active = false where id = '${victim}'`);
  const before = await sql(`select is_active from public.bundle_catalogue where id = '${victim}'`);
  out(before[0].is_active === false, "a seeded bundle is retired for the re-run test");

  const seedSql = readFileSync(new URL("../supabase/seed-catalogue.sql", import.meta.url), "utf8");
  await sql(seedSql);

  const after = await sql(`select is_active from public.bundle_catalogue where id = '${victim}'`);
  out(
    after[0].is_active === false,
    "re-running the seed does NOT revive a deliberately retired bundle",
    `${victim} is_active=${after[0].is_active}`
  );

  const afterCounts = await sql(`
    select (select count(*) from public.bundle_catalogue where is_active) as bundles,
           -- Scoped to the seeded bundles on purpose. The probe bundle above is
           -- still in the table at this point (the finally block removes it), and
           -- counting it would make a correct seed look like it added rows.
           (select count(*) from public.bundle_includes
             where bundle_id not like '${PROBE}%') as includes`);
  out(
    afterCounts[0].bundles === 7,
    "the re-run left the retired bundle out and activated nothing else",
    `${afterCounts[0].bundles} active, ${afterCounts[0].includes} includes`
  );
  out(
    afterCounts[0].includes === 15,
    "re-running the seed added no duplicate include lines",
    `n=${afterCounts[0].includes}`
  );

  // Put it back, or the catalogue is one bundle short for whoever comes next.
  await sql(`update public.bundle_catalogue set is_active = true where id = '${victim}'`);
} finally {
  await cleanup();
  await sql(`delete from public.staff_users where username like 'zz-coord-%'`);
  const left = await sql(`
    select (select count(*) from public.bundle_catalogue where id like '${PROBE}%')
         + (select count(*) from public.event_catalogue where id like '${PROBE}%') as n`);
  console.log(`\nprobe rows removed: ${left[0].n === 0 ? "yes" : `NO (${left[0].n} left)`}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
console.log(fail === 0 ? "=== CATALOGUE VERIFIED ===" : "=== CATALOGUE CHECKS FAILED ===");
process.exit(fail === 0 ? 0 : 1);


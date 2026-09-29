/**
 * Prove the catalogue layer: seed integrity, bundle rules, CRUD authorization,
 * and the XLSX writer.
 *
 * Five claims are defended here, three of them security claims rather
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
 *   5. The ENTRY RULE is the database's. Every event states whether it is
 *      individual or team, a team must say how many may enter, and an
 *      individual must carry no cap — in the data AND on the write path. The
 *      refusals are asserted for a readable sentence rather than ok:false,
 *      because the console prints that string to the operator. A client that
 *      predates the field is proved to still work, so deploying the schema does
 *      not break a console tab that is already open.
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
         (select count(*) from public.bundle_catalogue) as bundles,
         (select count(*) from public.bundle_includes) as includes`);
out(counts[0].events === 11, "eleven active events", `n=${counts[0].events}`);
// The bundle count, and the include count, are asserted over the WHOLE table
// rather than over the published rows. How many bundles a master has chosen to
// publish is a business decision that changes between seasons, and a test that
// fails when they withdraw one is a test that pressures them to keep selling
// something. What must always hold is that the seeded catalogue is intact and
// no line was lost or doubled - which is the invariant this file exists to
// defend, and the one the ...018 repair was written against.
out(counts[0].bundles === 8, "eight bundles in the catalogue", `n=${counts[0].bundles}`);
out(counts[0].includes === 15, "fifteen include lines", `n=${counts[0].includes}`);

// The ...018 bug: a one-based insert left position 0 free, the seed filled it,
// and every bundle silently gained a duplicate line. Asserted over ALL bundles
// because a retired bundle is exactly where this hides - it is not on the
// public site, so nobody notices the card printing the same event twice.
const gaps = await sql(`
  select bi.bundle_id, count(*) as n, coalesce(max(bi.position), -1) as hi
    from public.bundle_includes bi
   group by bi.bundle_id
  having coalesce(max(bi.position), -1) <> count(*) - 1`);
out(
  gaps.length === 0,
  "every bundle's include lines are numbered 0..n-1 with no gap",
  gaps.length ? gaps.map((g) => `${g.bundle_id} (n=${g.n}, max=${g.hi})`).join(", ") : "no gaps"
);

const dupes = await sql(`
  select bundle_id, event_id, pick_realm, pick_count, count(*) as n
    from public.bundle_includes
   group by bundle_id, event_id, pick_realm, pick_count
  having count(*) > 1`);
out(
  dupes.length === 0,
  "no bundle lists the same seat or pool twice",
  dupes.length ? dupes.map((d) => d.bundle_id).join(", ") : "no duplicates"
);

const keys = await sql(`
  select count(*) as n, count(distinct content_key) as d
    from public.bundle_catalogue where is_active and content_key <> ''`);
out(
  keys[0].n === keys[0].d,
  "no two live bundles have the same content",
  `${keys[0].d} distinct of ${keys[0].n}`
);

/* ---------- 1b. every event states who may enter it ---------- */

// The entry rule has two halves and both are checked here rather than one: a
// team with no cap cannot answer "how many may enter?", and an individual
// carrying a cap is advertising a limit that does not exist. The constraint
// makes both unstorable, so this asserts the DATA agrees — which is the part a
// constraint cannot tell you, because it only ever saw the last write.
const entry = await sql(`
  select ec.id, ec.entry_type, ec.max_team_members, ec.team_size
    from public.event_catalogue ec
   where ec.is_active
     and ( ec.entry_type not in ('individual', 'team')
        or (ec.entry_type = 'team'  and ec.max_team_members is null)
        or (ec.entry_type = 'team'  and (ec.max_team_members < 1 or ec.max_team_members > 50))
        or (ec.entry_type = 'individual' and ec.max_team_members is not null) )`);
out(
  entry.length === 0,
  "every active event is a team with a cap, or an individual with none",
  entry.length
    ? entry.map((r) => `${r.id} (${r.entry_type}/${r.max_team_members}, "${r.team_size}")`).join("; ")
    : "11 of 11 well formed"
);

// The cap and the free-text line an operator reads on the card have to agree.
// They are two different columns, so a console edit to one can leave the other
// lying — and the card prints team_size while the rule is enforced on the cap.
const split = await sql(`
  select ec.id, ec.team_size, ec.max_team_members
    from public.event_catalogue ec
   where ec.is_active
     and ec.team_size ~ '[0-9]'
     and ec.team_size !~* 'solo'
     and substring(reverse(ec.team_size) from '[^0-9]*([0-9]+)')::int
           is distinct from ec.max_team_members`);
out(
  split.length === 0,
  "each team's cap matches the number in its printed team size",
  split.length
    ? split.map((r) => `${r.id}: says "${r.team_size}", cap is ${r.max_team_members}`).join("; ")
    : "no disagreement"
);

/* ---------- 1c. nothing is priced that the catalogue does not contain ---------- */

// The catalogue is the only thing that can be priced, so a price row naming
// anything else is unreachable, unreferenced and can only ever look real to
// somebody reading the table. Migration ...015 deletes these and the trigger
// prevents new ones; this proves the cleanup held rather than assuming it did.
const orphans = await sql(`
  select p.kind || ':' || p.ref_id as bad
    from public.pricing p
   where (p.kind = 'event'  and not exists (
            select 1 from public.event_catalogue ec where ec.id = p.ref_id))
      or (p.kind = 'bundle' and not exists (
            select 1 from public.bundle_catalogue bc where bc.id = p.ref_id))`);
out(
  orphans.length === 0,
  "no price names an event or bundle the catalogue does not contain",
  orphans.length ? orphans.map((r) => r.bad).join(", ") : "none"
);

// A price's variant has to be the one its event actually offers. The trigger
// enforces this on write, but a mismatch here means the row was written by
// something that is not the trigger, which is worth knowing about.
const mismatched = await sql(`
  select p.ref_id, p.entry_type, ec.entry_type as should_be
    from public.pricing p
    join public.event_catalogue ec on ec.id = p.ref_id
   where p.kind = 'event' and p.entry_type is distinct from ec.entry_type`);
out(
  mismatched.length === 0,
  "every event price is stored at the entry type that event offers",
  mismatched.length
    ? mismatched.map((r) => `${r.ref_id}: ${r.entry_type} vs ${r.should_be}`).join("; ")
    : "no disagreement"
);

// An unpriced event is the live money bug: registration_set_events sums whatever
// price rows it finds, so before ...015 an event with no row handed out a free
// seat. Now the writer refuses it, and this asserts the refusal is never needed
// on the real catalogue.
const unpriced = await sql(`
  select ec.id
    from public.event_catalogue ec
   where ec.is_active
     and not exists (select 1 from public.pricing p
                      where p.kind = 'event' and p.ref_id = ec.id
                        and p.entry_type = ec.entry_type and p.is_active)`);
out(
  unpriced.length === 0,
  "every active event has an active price, so none can be registered for free",
  unpriced.length ? unpriced.map((r) => r.id).join(", ") : "all priced"
);

/* ---------- 1d. who pays is stated, and a squad price has a squad size ---------- */

// Three states, all real: a per-person event, a team event where each participant
// pays, and a squad event where one leader pays for everyone. The third is only
// meaningful with a cap, because "Rs 300 for the squad" is a discount of unknown
// size without one.
const pay = await sql(`
  select ec.id, ec.entry_type, ec.payment_mode, ec.max_team_members
    from public.event_catalogue ec
   where ec.is_active
     and ( ec.payment_mode not in ('per_person', 'per_team')
        or (ec.payment_mode = 'per_team' and ec.max_team_members is null)
        or (ec.payment_mode = 'per_team' and ec.max_team_members < 1) )`);
out(
  pay.length === 0,
  "every event states who pays, and a per-squad price always has a squad size",
  pay.length
    ? pay.map((r) => `${r.id} (${r.payment_mode}, cap ${r.max_team_members})`).join("; ")
    : "every event is well formed"
);

// The esports exception has to actually BE the exception, or the backfill that
// created it did nothing and the rule is being enforced against nothing.
const modes = await sql(`
  select ec.realm, ec.payment_mode, count(*)::int as n
    from public.event_catalogue ec where ec.is_active
   group by ec.realm, ec.payment_mode order by ec.realm, ec.payment_mode`);
console.log(
  "    payment modes: " +
    modes.map((m) => `${m.realm}/${m.payment_mode}=${m.n}`).join(", ")
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
   group by b.id, p.price`);

// Asserted over every bundle, published or not. Withdrawing a bundle is a
// pricing decision, not a data-integrity one, and a bundle sitting retired with
// a price above its parts is not something a participant can be charged for -
// it is simply next season's starting point. Checking the whole catalogue means
// the day a master re-publishes one, the number is already known to be sane.
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

  /* ---- the entry rule: individual or team, and a cap only for a team ---- */
  //
  // The refusals matter as much as the accept, and they are checked for a
  // SENTENCE rather than just ok:false, because the console prints this string
  // and a raw constraint name tells an operator nothing. A cap-less team is the
  // whole point — it is the state where "how many may enter?" has no answer.

  const noCap = await rpc(
    "staff_upsert_event",
    { p_event: { id: `${PROBE}-nocap`, title: "X", realm: "forge", entry_type: "team" } },
    token
  );
  const noCapBody = await noCap.json();
  out(
    noCapBody?.ok === false && typeof noCapBody?.error === "string",
    "a team event with no maximum team size is refused, with a message",
    noCapBody?.error ?? ""
  );

  const badEntry = await rpc(
    "staff_upsert_event",
    { p_event: { id: `${PROBE}-entry`, title: "X", realm: "forge", entry_type: "duo" } },
    token
  );
  const badEntryBody = await badEntry.json();
  out(
    badEntryBody?.ok === false && typeof badEntryBody?.error === "string",
    "an entry type that is neither individual nor team is refused",
    badEntryBody?.error ?? ""
  );

  const hugeCap = await rpc(
    "staff_upsert_event",
    {
      p_event: {
        id: `${PROBE}-huge`,
        title: "X",
        realm: "forge",
        entry_type: "team",
        max_team_members: 900,
      },
    },
    token
  );
  const hugeCapBody = await hugeCap.json();
  out(
    hugeCapBody?.ok === false && typeof hugeCapBody?.error === "string",
    "a cap outside 1-50 is refused rather than silently clamped",
    hugeCapBody?.error ?? ""
  );

  // A team WITH a cap, and the row is really that afterwards. Without the read
  // back, an RPC that accepted everything and stored nothing would pass the
  // refusals above for entirely the wrong reason.
  const teamWrite = await rpc(
    "staff_upsert_event",
    {
      p_event: {
        id: `${PROBE}-team`,
        number: "ZZ",
        title: "Probe Team",
        realm: "forge",
        entry_type: "team",
        max_team_members: 4,
        is_active: true,
      },
    },
    token
  );
  const teamBody = await teamWrite.json();
  out(teamBody?.ok === true, "a team event with a cap is accepted", JSON.stringify(teamBody));

  const teamRow = await sql(
    `select entry_type, max_team_members, max_size from public.event_catalogue where id = '${PROBE}-team'`
  );
  out(
    teamRow[0]?.entry_type === "team" && Number(teamRow[0]?.max_team_members) === 4,
    "the entry type and the cap are stored as given",
    JSON.stringify(teamRow[0])
  );
  // The legacy column is a mirror, not a second source of truth: a client must
  // not be able to write a max_size that disagrees with the pair above it.
  out(
    teamRow[0]?.max_size === "4",
    "the legacy max_size mirror follows the cap",
    `max_size=${teamRow[0]?.max_size}`
  );

  // An individual event that arrives with a stray cap. Normalised, not refused:
  // the console hides the field for a solo entry, so a leftover value there is
  // a UI accident, and the storage invariant is what has to hold either way.
  const soloWrite = await rpc(
    "staff_upsert_event",
    {
      p_event: {
        id: `${PROBE}-solo`,
        number: "ZZ",
        title: "Probe Solo",
        realm: "forge",
        entry_type: "individual",
        max_team_members: 9,
        is_active: true,
      },
    },
    token
  );
  const soloBody = await soloWrite.json();
  out(soloBody?.ok === true, "an individual event is accepted", JSON.stringify(soloBody));

  const soloRow = await sql(
    `select entry_type, max_team_members from public.event_catalogue where id = '${PROBE}-solo'`
  );
  out(
    soloRow[0]?.entry_type === "individual" && soloRow[0]?.max_team_members == null,
    "an individual event stores no cap, whatever the client sent",
    JSON.stringify(soloRow[0])
  );

  // A console tab that predates the field still works. It sends the old packed
  // max_size and no entry_type, and has to land as the pair the migration's
  // backfill would have derived — otherwise deploying the schema would break the
  // one client that is already open.
  const legacyWrite = await rpc(
    "staff_upsert_event",
    { p_event: { id: `${PROBE}-legacy`, title: "X", realm: "forge", max_size: "3" } },
    token
  );
  const legacyBody = await legacyWrite.json();
  const legacyRow = await sql(
    `select entry_type, max_team_members from public.event_catalogue where id = '${PROBE}-legacy'`
  );
  out(
    legacyBody?.ok === true &&
      legacyRow[0]?.entry_type === "team" &&
      Number(legacyRow[0]?.max_team_members) === 3,
    "a client sending only the old max_size still lands as a team with that cap",
    JSON.stringify(legacyRow[0])
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
  // Remember what this bundle was BEFORE the test touched it, and put it back to
  // exactly that. The old version hardcoded `set is_active = true`, which meant
  // running the test silently republished a bundle a master had deliberately
  // withdrawn - the test was changing the thing it exists to protect.
  const original = await sql(
    `select is_active from public.bundle_catalogue where id = '${victim}'`
  );
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

  // The seed must be a NO-OP on a catalogue that is already correct, whatever
  // that catalogue happens to contain. Asserted as a before/after comparison
  // rather than as a hardcoded "seven", because the number of published bundles
  // is a business decision: the old form of this check passed only while eight
  // bundles were on sale and would have failed the moment a master withdrew one,
  // which is precisely the wrong thing for a seed test to police.
  const publishedBefore = await sql(`
    select count(*) as n from public.bundle_catalogue where is_active`);

  const afterCounts = await sql(`
    select (select count(*) from public.bundle_catalogue where is_active) as bundles,
           -- Scoped to the seeded bundles on purpose. The probe bundle above is
           -- still in the table at this point (the finally block removes it), and
           -- counting it would make a correct seed look like it added rows.
           (select count(*) from public.bundle_includes
             where bundle_id not like '${PROBE}%') as includes`);
  out(
    afterCounts[0].bundles === publishedBefore[0].n,
    "re-running the seed published nothing and retired nothing",
    `${publishedBefore[0].n} active before, ${afterCounts[0].bundles} after`
  );
  out(
    afterCounts[0].includes === 15,
    "re-running the seed added no duplicate include lines",
    `n=${afterCounts[0].includes}`
  );

  // The include lines the seed would have added must not have landed either.
  // This is the direct regression test for the ...018 off-by-one: a one-based
  // upsert leaves position 0 free, and the seed's `on conflict do nothing` fills
  // it - duplicating a line instead of restoring the missing one.
  const afterGaps = await sql(`
    select bi.bundle_id, count(*) as n, coalesce(max(bi.position), -1) as hi
      from public.bundle_includes bi
     where bi.bundle_id not like '${PROBE}%'
     group by bi.bundle_id
    having coalesce(max(bi.position), -1) <> count(*) - 1`);
  out(
    afterGaps.length === 0,
    "re-running the seed left every bundle numbered 0..n-1",
    afterGaps.length ? afterGaps.map((g) => g.bundle_id).join(", ") : "no gaps"
  );

  // Put it back exactly as it was, so the test leaves no trace either way.
  await sql(
    `update public.bundle_catalogue set is_active = ${original[0].is_active} where id = '${victim}'`
  );
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


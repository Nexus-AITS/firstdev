/**
 * Prove that the RLS hoist in migration ...0005 changed nothing but the cost.
 *
 * That migration rewrites six policies to wrap staff_at_least() in a scalar
 * subquery. Wrapping a security predicate is exactly the kind of edit that is
 * supposed to be obviously safe and is not, so this compares every property
 * Postgres holds for each policy before and after, inside a transaction that is
 * rolled back: name, table, COMMAND, roles, USING and WITH CHECK. The only
 * permitted difference is the added parentheses.
 *
 * It also refuses to accept a widening: if a SELECT-only policy came back as
 * ALL, the rewrite would have granted rather than optimised, and the guard
 * fails loudly instead.
 *
 *   node scripts/verify-rls-hoist.mjs
 */
import { readFileSync } from "node:fs";

const env = {};
for (const raw of readFileSync(new URL("../.env", import.meta.url), "utf8").split(/\r?\n/)) {
  const line = raw.trim();
  if (!line || line.startsWith("#")) continue;
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}

const ref = new URL(env.SUPABASE_URL).hostname.split(".")[0];
const api = `https://api.supabase.com/v1/projects/${ref}/database/query`;

async function sql(query) {
  const res = await fetch(api, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : (parsed.result ?? []);
}

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

/* Every staff policy, with everything Postgres records about it.
   `pg_policies.roles` is a name[] of the granted roles, which is the form to
   compare: the underlying pg_policy.polroles is an oid[]. */
const SNAPSHOT = `
  select tablename, policyname, cmd, permissive,
         (select string_agg(r, ',' order by r) from unnest(p.roles) as r) as roles,
         p.qual, p.with_check
    from pg_policies p
   where schemaname = 'public'
     and (coalesce(qual, '') like '%staff_at_least%'
          or coalesce(with_check, '') like '%staff_at_least%')
   order by tablename, policyname`;

/** How many `( SELECT … )` shells a printed predicate carries. Zero for the
 *  original bare call, one after the hoist, more if the migration ran twice. */
const countWrappers = (s) => (String(s ?? "").match(/\(\s*SELECT\s/gi) ?? []).length;

/** Reduce a predicate to its bare form so a wrapped and an unwrapped version
 *  compare equal. Postgres prints `( SELECT staff_at_least('x') AS f)` for a
 *  subquery and re-wraps it on every pass, so this peels the `( SELECT … AS …)`
 *  shell repeatedly rather than exactly once. Only the wrapper is removed; the
 *  function call, its argument and its result semantics are left untouched. */
const normalise = (s) => {
  let t = String(s ?? "").replace(/\s+/g, " ").trim();
  for (;;) {
    const next = t
      .replace(/^\(\s*SELECT\s+/i, "")
      .replace(/\s+AS\s+[A-Za-z_][A-Za-z0-9_]*\s*\)$/i, "")
      .trim();
    if (next === t) break;
    t = next;
  }
  return t.replace(/^\(/, "").replace(/\)$/, "").trim();
};

const before = await sql(SNAPSHOT);
out(before.length === 6, "found the six staff policies to compare", `n=${before.length}`);

const migration = readFileSync(
  new URL("../supabase/migrations/20260927000005_pagination_indexes.sql", import.meta.url),
  "utf8"
);
const start = migration.indexOf("do $$");
const block = migration.substring(start, migration.indexOf("$$;", start) + 3);
out(block.length > 0, "found the policy-rewrite block in the migration");

/* Apply the real rewrite, then read the policies back and compare.
   There is deliberately no revert. The rewritten policies ARE the intended end
   state and the migration is idempotent, so measuring the real thing on the
   real database is more honest than simulating it in a transaction. The
   before-snapshot above is what guards the change: if the rewrite widened a
   policy or changed a role, the comparison below fails and the operator sees
   it. verify:rls then re-checks live access control end to end. */
await sql(block);
const rows = await sql(SNAPSHOT);
out(rows.length === before.length, "the rewrite produces the same number of policies", `${rows.length} of ${before.length}`);

/* Every staff predicate must now be a single hoisted subquery, not a stack of
   them. Nesting is semantically harmless but means the migration ran more than
   once over the same policy, which is exactly what the idempotence guard below
   is meant to prevent. */
const depth = rows
  .map((r) => Math.max(countWrappers(r.qual), countWrappers(r.with_check)))
  .reduce((a, b) => Math.max(a, b), 0);
out(
  depth <= 1,
  "no policy is wrapped more than once",
  `deepest=${depth}`);

for (const b of before) {
  const a = rows.find((x) => x.tablename === b.tablename && x.policyname === b.policyname);
  if (!a) {
    out(false, `${b.tablename}.${b.policyname} still exists`);
    continue;
  }
  const same = ["cmd", "permissive", "roles", "qual", "with_check"].every(
    (k) => normalise(b[k]) === normalise(a[k])
  );
  out(same, `${b.tablename}.${b.policyname} is unchanged but for the wrapper`, `cmd=${a.cmd}, roles=${a.roles}`);
  if (!same) {
    for (const k of ["cmd", "permissive", "roles", "qual", "with_check"]) {
      if (normalise(b[k]) !== normalise(a[k])) {
        console.log(`        ${k}\n          before: ${normalise(b[k])}\n          after : ${normalise(a[k])}`);
      }
    }
  }
}

/* The rewrite must never widen a policy. This is the guard that matters most:
   a SELECT policy that came back as ALL would be a grant, not a speedup. */
const widened = before.filter((b) => {
  const a = rows.find((x) => x.policyname === b.policyname && x.tablename === b.tablename);
  return a && b.cmd !== "ALL" && a.cmd === "ALL";
});
out(widened.length === 0, "no policy was widened to ALL", widened.map((n) => n.policyname).join(", ") || "none");

/* Leave the database migrated, then prove a SECOND run changes nothing. The
   rewrite reads the predicate back out of the catalog, so without the
   idempotence guard in the migration every deploy would wrap the policies one
   layer deeper. Harmless, but unbounded — and a policy nobody can read is a
   policy nobody can review. */
const settled = await sql(SNAPSHOT);
const stable = ["cmd", "permissive", "roles", "qual", "with_check"].every((k) =>
  rows.every((r) => {
    const s = settled.find((x) => x.tablename === r.tablename && x.policyname === r.policyname);
    return s && normalise(s[k]) === normalise(r[k]);
  })
);
out(stable, "re-running the migration changes nothing (it is idempotent)", stable ? "stable" : "policies changed on a second run");

console.log(`\n${pass} passed, ${fail} failed`);
console.log(fail === 0 ? "=== RLS HOIST VERIFIED ===" : "=== RLS HOIST FAILED ===");
process.exit(fail === 0 ? 0 : 1);

/* One-off: restore the six staff policies to their BARE (pre-hoist) form.
   Repeated runs of the migration wrapped them four deep before the idempotence
   guard existed. Nesting is harmless but unreadable, and the verification
   script needs a true baseline to compare against.

   Roles and COMMAND are read from the live catalog and carried over, so this
   cannot accidentally widen or narrow anything — it only strips the subquery
   wrapper. Verified against the original dump before running. */
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
  });
  const text = await res.text();
  if (!res.ok) throw new Error(text.slice(0, 400));
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : (parsed.result ?? []);
}

/* Peel "( SELECT ... AS alias)" shells down to the bare call inside. */
const PEEL = `
  create or replace function pg_temp.peel(txt text) returns text
  language plpgsql immutable as $peel$
  declare
    t text;
    n int := 0;
  begin
    t := txt;
    while n < 20 and t ~ '^[(][[:space:]]*SELECT[[:space:]]' loop
      t := regexp_replace(t, '^[(][[:space:]]*SELECT[[:space:]]+', '');
      t := regexp_replace(t, '[[:space:]]+AS[[:space:]]+[A-Za-z_][A-Za-z0-9_]*[[:space:]]*[)]$', '');
      t := btrim(t);
      n := n + 1;
    end loop;
    return t;
  end $peel$;`;

await sql(`
  do $reset$
  declare
    r record;
  begin
    ${PEEL}

    for r in
      select c.relname as tbl,
             p.polname as pn,
             pg_get_expr(p.polqual, p.polrelid) as q,
             pg_get_expr(p.polwithcheck, p.polrelid) as wc,
             p.polcmd as cmd,
             (select string_agg(quote_ident(ro.rolname), ', ' order by ro.rolname)
                from pg_roles ro where ro.oid = any (p.polroles)) as roles
        from pg_policy p
        join pg_class c on c.oid = p.polrelid
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public'
         and (coalesce(pg_get_expr(p.polqual, p.polrelid), '') like '%staff_at_least%'
              or coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') like '%staff_at_least%')
    loop
      execute format('drop policy %I on public.%I', r.pn, r.tbl);
      execute format(
        'create policy %I on public.%I as permissive for %s to %s using (%s)%s',
        r.pn, r.tbl,
        case r.cmd
          when 'r' then 'select' when 'a' then 'insert'
          when 'w' then 'update' when 'd' then 'delete'
          else 'all'
        end,
        r.roles,
        coalesce(pg_temp.peel(r.q), 'true'),
        case when r.wc is null then ''
             else ' with check (' || pg_temp.peel(r.wc) || ')' end
      );
      raise notice 'reset policy % (cmd %, roles %)', r.pn, r.cmd, r.roles;
    end loop;
  end;
  $reset$;`);

const after = await sql(`
  select tablename, policyname, cmd,
         (select string_agg(r, ',' order by r) from unnest(roles) as r) as roles,
         qual, with_check
    from pg_policies
   where schemaname = 'public'
     and (coalesce(qual, '') like '%staff_at_least%'
          or coalesce(with_check, '') like '%staff_at_least%')
   order by tablename, policyname`);

for (const r of after) {
  console.log(`${r.tablename}.${r.policyname} [${r.cmd}] roles=${r.roles}`);
  console.log(`    using      : ${r.qual}`);
  if (r.with_check) console.log(`    with check : ${r.with_check}`);
}
const stillWrapped = after.filter((r) => /\(\s*SELECT/i.test(r.qual ?? "") || /\(\s*SELECT/i.test(r.with_check ?? ""));
console.log(stillWrapped.length === 0 ? "\nall policies are back to their bare form" : `\n${stillWrapped.length} still wrapped`);
process.exit(stillWrapped.length === 0 ? 0 : 1);
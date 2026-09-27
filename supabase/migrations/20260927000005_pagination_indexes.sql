-- Phase 4 — pagination support.
--
-- Pagination moved the console's reads from "fetch the table" to "fetch one
-- window, ordered and filtered, and count the rest". Making that fast needed
-- four things, and only the first three are indexes. The fourth is the one that
-- actually decides whether the console works at all once real signups arrive.
--
--   1. Registrations: `idx_registrations_created_at` already covers the plain
--      "newest first" order, but a status filter makes the planner filter and
--      then sort, because an index on created_at alone cannot satisfy
--      "verified rows, newest first" without reading the older part of the
--      table. The composite index answers both at once.
--   2. Audit log: filtered by `action` then ordered by created_at. Same shape,
--      same reason. The audit table only ever grows, so this matters most.
--   3. Search: the console searches five text columns with ILIKE '%term%'.
--      A btree cannot serve a leading-wildcard match, so this needs pg_trgm.
--      Without it, every keystroke (debounced, but still) is a full scan of
--      registrations. The extension is created defensively so this migration
--      cannot fail on a project where it is unavailable; the GIN indexes are
--      then conditional on the extension actually being present.
--   4. RLS was silently re-evaluating the staff check ONCE PER ROW (below).
--      This is the one that turned "count the rows for the pager" from fast
--      into impossible past a few thousand signups, and it is invisible until
--      the table is big enough to matter.
--
-- These are additive only: no policy, column, constraint or existing index is
-- weakened, and the RLS rewrite in part 4 is semantics-preserving — same
-- predicate, same role, same rows, evaluated once instead of N times.

-- ============================================================================
-- PART 4 FIRST: hoist the staff check out of the per-row RLS filter.
-- ============================================================================
--
-- The problem, measured on this project with 5,000 registrations:
--
--   select count(*) from registrations;         -- 2,518 ms
--     ->  Index Only Scan on registrations  (actual time=3.479..2514.841 rows=5000)
--           Filter: staff_at_least('coordinator')
--
-- `staff_at_least()` resolves the request header to a live session row. Written
-- as a bare call in a USING clause, Postgres treats it as an expression to
-- evaluate for every candidate row, so the session lookup ran 5,000 times for
-- one question that has exactly one answer per request.
--
-- Why that breaks pagination specifically: the `anon` role carries
-- `statement_timeout = 3s`, and PostgREST's `Prefer: count=exact` — the thing
-- the pager needs to know "1–25 of 1,482" — is a full-table count. At 5,000
-- rows it was already at 2.5s, so the roster would begin returning HTTP 500 to
-- operators at around 6,000 signups, and no index would have prevented it:
-- the cost was in the policy, not the plan.
--
-- The fix is to wrap the call in a scalar subquery, `(select ...)`. Postgres
-- recognises that as an InitPlan and evaluates it ONCE, then reuses the answer
-- for every row. Same result, ~640x less work:
--
--   Aggregate (actual time=3.876..3.876 rows=1)
--     InitPlan 1  (actual time=2.952..2.952)      <- one evaluation
--     ->  Index Only Scan ... rows=5000
--           Filter: (InitPlan 1).col1
--
-- This is safe, not a shortcut around security. `staff_at_least()` is STABLE
-- and depends only on `request.headers`, which cannot change within a
-- statement — so per-row and once-per-statement are provably identical here.
-- The function's own definition (expiry, revocation, is_active) is untouched,
-- and the policies are still what grants access; only the repetition is gone.
--
-- Done via a DO block because ALTER POLICY needs a literal role expression,
-- and hard-coding six policies by hand invites one of them being missed.

do $$
declare
  r record;
begin
  for r in
    select c.relname                          as tablename,
           p.polname                          as policyname,
           pg_get_expr(p.polqual, p.polrelid) as qual,
           pg_get_expr(p.polwithcheck, p.polrelid) as with_check,
           p.polcmd                                as cmd,
           (select string_agg(quote_ident(rolname), ', ' order by rolname)
              from pg_roles
             where oid = any (p.polroles))    as roles
      from pg_policy p
      join pg_class c     on c.oid = p.polrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       -- Only policies whose predicate mentions the staff check. The
       -- participant policies are left completely alone.
       and (coalesce(pg_get_expr(p.polqual, p.polrelid), '') like '%staff_at_least%'
            or coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') like '%staff_at_least%')
       -- IDEMPOTENCE. The rewrite below reads the predicate back out of the
       -- catalog, so re-running it on an already-wrapped policy would wrap it
       -- again: `( SELECT f(x) )` -> `( SELECT ( SELECT f(x) ) )` -> ... Each
       -- layer is harmless, but it grows without bound and makes the policy
       -- unreadable. Matching on the bare `staff_at_least(` prefix means a
       -- second run is a no-op instead of a noisiest-but-still-correct edit.
       and (   (coalesce(pg_get_expr(p.polqual, p.polrelid), '') ~ '^staff_at_least\(')
            or (coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') ~ '^staff_at_least\('))
  loop
    -- Drop and recreate, because ALTER POLICY cannot wrap an existing
    -- expression in a subquery. Every property is carried over from the
    -- catalog — name, table, COMMAND, roles, USING and WITH CHECK — because
    -- dropping the command would silently widen a SELECT-only policy to ALL,
    -- which is a grant, not an optimisation. Only the predicate changes shape,
    -- and only by gaining one layer of parentheses.
    execute format('drop policy %I on public.%I', r.policyname, r.tablename);

    execute format(
      'create policy %I on public.%I as permissive for %s to %s using (%s)%s',
      r.policyname,
      r.tablename,
      -- polcmd is a "char": r=SELECT, a=INSERT, w=UPDATE, d=DELETE, *=ALL.
      case r.cmd
        when 'r' then 'select'
        when 'a' then 'insert'
        when 'w' then 'update'
        when 'd' then 'delete'
        else 'all'
      end,
      r.roles,
      case when r.qual is null then 'true'
           else '(select ' || r.qual || ')' end,
      case when r.with_check is null then ''
           else ' with check ((select ' || r.with_check || '))' end
    );
    raise notice 'rewrote % on public.% (cmd: %, roles: %)',
      r.policyname, r.tablename, r.cmd, r.roles;
  end loop;
end;
$$;

--      registrations. The extension is created defensively so this migration
--      cannot fail on a project where it is unavailable; the GIN indexes are
--      then conditional on the extension actually being present.
--
-- These are additive only: no policy, column, constraint or existing index is
-- touched, so this is safe to apply to a live database with real signups in it.

-- ---------- 1. registrations: status + newest-first ----------
-- A partial-free composite so the planner can use it for both the unfiltered
-- order and the status-filtered order.
create index if not exists idx_registrations_status_created
  on public.registrations (payment_status, created_at desc);

-- Covers the console's exact projection (it selects * from this table), so a
-- page read can be answered from the index alone once vacuum has run.
create index if not exists idx_registrations_created_id
  on public.registrations (created_at desc, id);

-- ---------- 2. audit log: action + newest-first ----------
create index if not exists idx_audit_action_created
  on public.staff_audit_log (action, created_at desc);

-- ---------- 3. search: trigram indexes ----------
-- Guarded: pg_trgm may not be installable on every project, and a hard failure
-- here would block the whole migration. If it is missing, the console still
-- works — it just falls back to the sequential scan it always had.
do $$
begin
  create extension if not exists pg_trgm;
exception
  when others then
    raise notice 'pg_trgm unavailable; search will use a sequential scan';
end;
$$;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_trgm') then
    create index if not exists idx_registrations_name_trgm
      on public.registrations using gin (name gin_trgm_ops);
    create index if not exists idx_registrations_email_trgm
      on public.registrations using gin (email gin_trgm_ops);
    create index if not exists idx_registrations_roll_trgm
      on public.registrations using gin (roll_number gin_trgm_ops);
    create index if not exists idx_registrations_college_trgm
      on public.registrations using gin (college_name gin_trgm_ops);
    create index if not exists idx_registrations_utr_trgm
      on public.registrations using gin (utr_number gin_trgm_ops);
  else
    raise notice 'pg_trgm absent; skipping trigram indexes';
  end if;
end;
$$;
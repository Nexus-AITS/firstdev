-- =============================================================================
-- NEXUS — making the roster search index-backed
-- Migration : 20260927000012_roster_search_index.sql
-- Purpose   : The console's search is
--                or=(name.ilike.%t%,email.ilike.%t%,roll_number.ilike.%t%,
--                    college_name.ilike.%t%,utr_number.ilike.%t%)
--              A leading wildcard cannot use a btree index, so this has always
--              been a sequential scan of the whole roster, five times over, on
--              every pause in typing. That is the load the operator feels as a
--              slow search, and it grows with the roster rather than with the
--              number of matches.
--
--              pg_trgm's GIN indexes answer exactly this shape: a pattern with
--              wildcards on BOTH sides becomes a trigram lookup. Five separate
--              indexes (not one over a concatenation) because PostgREST filters
--              one column at a time and Postgres can only BitmapOr indexes it
--              already has.
--
-- Trade, stated plainly: a trigram index makes every INSERT/UPDATE on this
-- table more expensive, and it only pays for patterns of 3+ characters. That
-- is why the console waits for three characters before it queries at all — a
-- one- or two-character term matches most of the roster and the index cannot
-- help with it either way.
--
-- Idempotent: if-not-exists; the extension is create-if-missing.
-- =============================================================================

-- Supabase installs pg_trgm, but not always in the same schema: on this project
-- it is in `public`, on a fresh one Supabase puts it in `extensions`. Hardcoding
-- either breaks somewhere, so the operator class is looked up and the indexes
-- built through EXECUTE. A missing extension is a loud failure, not a silently
-- un-indexed search.
create extension if not exists pg_trgm;

do $$
declare
  ops_schema text;
begin
  select n.nspname into ops_schema
    from pg_opclass o
    join pg_namespace n on n.oid = o.opcnamespace
   where o.opcname = 'gin_trgm_ops';

  if ops_schema is null then
    raise exception 'pg_trgm is not installed: the roster search would stay a full scan';
  end if;

  execute format(
    'create index if not exists ix_registrations_name_trgm
       on public.registrations using gin (name %I.gin_trgm_ops)', ops_schema);
  execute format(
    'create index if not exists ix_registrations_email_trgm
       on public.registrations using gin (email %I.gin_trgm_ops)', ops_schema);
  execute format(
    'create index if not exists ix_registrations_roll_trgm
       on public.registrations using gin (roll_number %I.gin_trgm_ops)', ops_schema);
  execute format(
    'create index if not exists ix_registrations_college_trgm
       on public.registrations using gin (college_name %I.gin_trgm_ops)', ops_schema);
  execute format(
    'create index if not exists ix_registrations_utr_trgm
       on public.registrations using gin (utr_number %I.gin_trgm_ops)', ops_schema);
end $$;

-- `name` is also the tie-breaker in every ORDER BY created_at, name — this one
-- is ordinary btree and helps the ordering as well as the filter.
create index if not exists ix_registrations_created_name
  on public.registrations (created_at desc, name asc);

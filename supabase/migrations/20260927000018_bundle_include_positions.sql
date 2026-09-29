-- =============================================================================
-- NEXUS - repair duplicated bundle include lines, and stop them recurring
-- Migration : 20260927000018_bundle_include_positions.sql
-- Purpose   : Fix a real data-corruption bug found in the live catalogue, and
--             close the off-by-one that caused it.
--
-- THE BUG
--
-- staff_upsert_bundle numbered its include lines from ONE:
--
--     v_pos := v_pos + 1;
--     insert into public.bundle_includes (bundle_id, position, ...) values (v_id, v_pos, ...)
--
-- so a two-line bundle was stored at positions 1 and 2, leaving position 0
-- empty. The generated seed in ...007 numbers from ZERO, and it is
-- `on conflict (bundle_id, position) do nothing`, so re-running it saw position
-- 0 free and INSERTED the first line a second time. Every bundle saved once from
-- the console therefore ended up with one duplicated line:
--
--     bundled-299   0: nexus-breach   1: nexus-breach   2: paradox x1
--
-- Three consequences, all real:
--   * the card printed "NEXUS BREACH" twice, and a buyer was told a bundle
--     covered three things when it covered two;
--   * the bundle charged for N events but demanded N+1, so the database refused
--     the registration as an unsatisfiable selection;
--   * the duplicate-bundle guard was defeated, because a bundle that should
--     have CLASHED with an existing offer now had a different signature and
--     could be published alongside it.
--
-- It survived every existing test because they all read the seed's own numbers
-- and the bundles had been saved before the tests ran.
--
-- THE FIX, in three parts
--
--   1. The stored rows are repaired: within a bundle, a line identical to an
--      earlier one is dropped, and what remains is renumbered 0..n-1. The
--      surviving ORDER is the first occurrence's, which is the order the console
--      submitted and the order the card prints.
--   2. staff_upsert_bundle numbers from ZERO again.
--   3. A DEFERRABLE constraint trigger makes a gap impossible rather than
--      merely unlikely. It cannot be a CHECK on bundle_includes: the upsert
--      deletes every line and re-inserts them one at a time, so there is a
--      legitimate instant mid-save when positions are 1,2 and 0 is missing.
--      Deferred to COMMIT, the check sees the finished bundle and can say no.
--
-- Idempotent: create-or-replace, drop-trigger-if-exists, and the repair is a
-- no-op once no bundle has a duplicate.
-- =============================================================================

-- Refuse to run out of order rather than failing later on a missing relation.
do $$
begin
  if not exists (
    select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'staff_upsert_bundle'
  ) then
    raise exception
      'staff_upsert_bundle is missing - apply migration ...007 first. Refusing to run out of order.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. the repair
-- ---------------------------------------------------------------------------
--
-- Two stages rather than one, and the order is required. Duplicates are removed
-- FIRST while positions still hold their original values; renumbering first
-- would renumber the duplicate too and leave it in place under a new position.

-- 1a. drop every line that repeats an earlier line of the same bundle.
--
-- "Identical" is the content signature of a line, which is the same definition
-- bundle_content_key uses: an event seat is the event, and a pool is the realm,
-- the count and the exclude flag together. Comparing on that - rather than on
-- `position` - is what makes this a statement about MEANING: two lines are
-- redundant exactly when they would grant the same thing twice.
delete from public.bundle_includes bi
 where exists (
   select 1
     from public.bundle_includes earlier
    where earlier.bundle_id = bi.bundle_id
      and earlier.position < bi.position
      and earlier.event_id is not distinct from bi.event_id
      and earlier.pick_realm is not distinct from bi.pick_realm
      and earlier.pick_count is not distinct from bi.pick_count
      and earlier.exclude_hackathon is not distinct from bi.exclude_hackathon
 );

-- 1b. renumber what is left to 0..n-1.
--
-- Parked on a high offset first because (bundle_id, position) is the primary
-- key: renumbering in place would transiently collide with a row that has not
-- moved yet and abort the statement. The offset is above any real position, and
-- the second update walks each bundle in order, so each row moves into a slot
-- that has just been vacated.
--
-- MATERIALIZED is load-bearing, not a hint. A plain CTE is inlined, which means
-- the second statement re-evaluates row_number() over the table it has just
-- rewritten: the rows already parked on the offset sort AFTER the rows still in
-- place, so their wanted numbers all shift by the number already moved and the
-- update targets rows that no longer hold the position it read. That is not a
-- theoretical hazard - it failed with a duplicate-key violation on the first run
-- against the real data. Forcing materialization freezes the numbering at the
-- state before any row moved, which is what the two-step dance requires.
with ranked as materialized (
  select bi.bundle_id,
         bi.position,
         row_number() over (partition by bi.bundle_id order by bi.position) - 1 as wanted
    from public.bundle_includes bi
)
update public.bundle_includes bi
   set position = r.wanted + 100000
  from ranked r
 where bi.bundle_id = r.bundle_id
   and bi.position = r.position
   and bi.position <> r.wanted;

with parked as materialized (
  select bi.bundle_id,
         bi.position as parked_at,
         bi.position - 100000 as wanted
    from public.bundle_includes bi
   where bi.position >= 100000
)
update public.bundle_includes bi
   set position = p.wanted
  from parked p
 where bi.bundle_id = p.bundle_id
   and bi.position = p.parked_at;

-- 1c. the content key is derived from the rows, so it is recomputed rather than
-- trusted. trg_bundle_content_key already fires on the deletes and the updates
-- above, but stating it here means the repair is correct on its own terms and
-- does not depend on trigger timing to leave the table self-consistent.
update public.bundle_catalogue bc
   set content_key = public.bundle_content_key(bc.id)
 where bc.content_key is distinct from public.bundle_content_key(bc.id);

-- ---------------------------------------------------------------------------
-- 2. number include lines from zero again
-- ---------------------------------------------------------------------------
--
-- The functional change is moving `v_pos := v_pos + 1` to AFTER the insert. The
-- whole function is rewritten rather than its body patched, because plpgsql
-- source is not patchable and a partial edit would be a migration that only
-- works once.

create or replace function public.staff_upsert_bundle (p_bundle jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id      text := p_bundle ->> 'id';
  v_group   text := coalesce(nullif(trim(p_bundle ->> 'group_id'), ''), 'nexus-forge');
  v_name    text := coalesce(nullif(trim(p_bundle ->> 'name'), ''), null);
  v_lines   jsonb := coalesce(p_bundle -> 'includes', '[]'::jsonb);
  v_line    jsonb;
  v_event   text;
  v_realm   text;
  v_count   int;
  v_excl    boolean;
  v_key     text;
  v_clash   text;
  v_pos     int := 0;
  v_new     boolean;
begin
  if not public.staff_at_least('master') then
    return jsonb_build_object('ok', false,
      'error', 'Only a master administrator can change the bundle catalogue.');
  end if;

  if v_id is null or v_id !~ '^[a-z0-9][a-z0-9-]{1,48}$' then
    return jsonb_build_object('ok', false,
      'error', 'Bundle id must be 2-49 characters: a-z, 0-9 and dashes.');
  end if;

  if v_name is null then
    return jsonb_build_object('ok', false, 'error', 'A bundle needs a name.');
  end if;

  if jsonb_array_length(v_lines) = 0 then
    return jsonb_build_object('ok', false,
      'error', 'A bundle must include at least one event or pick-pool.');
  end if;

  -- Validate every line BEFORE writing anything, so a rejected bundle leaves no
  -- trace. A half-written bundle is the failure mode a form cannot recover from.
  for v_line in select * from jsonb_array_elements(v_lines)
  loop
    v_event := nullif(trim(coalesce(v_line ->> 'event', '')), '');
    v_realm := nullif(trim(coalesce(v_line ->> 'pick', '')), '');
    v_count := nullif(v_line ->> 'count', '')::int;
    v_excl  := coalesce((v_line ->> 'excludeHackathon')::boolean, false);

    if v_event is not null then
      if not exists (
        select 1 from public.event_catalogue ec
         where ec.id = v_event and ec.is_active
      ) then
        return jsonb_build_object('ok', false,
          'error', format('No active event called "%s".', v_event));
      end if;
    elsif v_realm is not null
          and v_realm in ('forge', 'paradox', 'arena')
          and v_count is not null and v_count > 0 then
      null; -- a well-formed pool
    else
      return jsonb_build_object('ok', false,
        'error', 'Each line must be either an event, or a realm with a count above zero.');
    end if;

    v_pos := v_pos + 1;
  end loop;

  select not exists (select 1 from public.bundle_catalogue bc where bc.id = v_id)
    into v_new;

  -- The parent first, HELD RETIRED with an empty key.
  --
  -- is_active is forced to false here on purpose. Both the CHECK ("an active
  -- bundle must have includes") and the partial unique index would reject an
  -- active bundle whose content_key is still '', which is the state this row is
  -- in for the few statements between here and the last include line landing.
  -- Writing it retired and re-activating once the key is real means there is no
  -- instant at which a live, incomplete or duplicate bundle is visible, and the
  -- trigger refills the key as the lines land.
  insert into public.bundle_catalogue as bc
    (id, number, name, group_id, kicker, title_lines, sort_order, is_active,
     content_key, updated_by)
  values
    (v_id,
     coalesce(nullif(trim(p_bundle ->> 'number'), ''), 'NEW'),
     v_name,
     v_group,
     nullif(trim(coalesce(p_bundle ->> 'kicker', '')), ''),
     coalesce(array(select jsonb_array_elements_text(coalesce(p_bundle -> 'title_lines', '[]'::jsonb))), '{}'),
     coalesce(nullif(trim(p_bundle ->> 'sort_order'), '')::int, 0),
     false,
     '',
     (select s.username from public.staff_session() s))
  on conflict (id) do update
     set number      = excluded.number,
         name        = excluded.name,
         group_id    = excluded.group_id,
         kicker      = excluded.kicker,
         title_lines = excluded.title_lines,
         sort_order  = excluded.sort_order,
         is_active   = false,
         content_key = '',
         updated_at  = now(),
         updated_by  = excluded.updated_by;

  delete from public.bundle_includes bi where bi.bundle_id = v_id;

  -- ZERO-BASED, and this is the fix. The counter is used as-is and advanced
  -- afterwards, so the first line lands at position 0. Incrementing first is
  -- what produced the off-by-one documented at the top of this file.
  v_pos := 0;
  for v_line in select * from jsonb_array_elements(v_lines)
  loop
    v_event := nullif(trim(coalesce(v_line ->> 'event', '')), '');
    v_realm := nullif(trim(coalesce(v_line ->> 'pick', '')), '');
    v_count := nullif(v_line ->> 'count', '')::int;
    v_excl  := coalesce((v_line ->> 'excludeHackathon')::boolean, false);

    insert into public.bundle_includes
      (bundle_id, position, event_id, pick_realm, pick_count, exclude_hackathon)
    values
      (v_id, v_pos,
       case when v_event is not null then v_event end,
       case when v_realm is not null and v_realm in ('forge', 'paradox', 'arena')
            then v_realm end,
       case when v_event is null and v_realm is not null and v_realm in ('forge', 'paradox', 'arena')
            then v_count end,
       case when v_event is null then v_excl else false end);

    v_pos := v_pos + 1;
  end loop;

  v_key := public.bundle_content_key(v_id);

  -- The duplicate check, stated as a message rather than a raw unique-violation,
  -- because "that bundle already exists" is the one error an operator in this
  -- console genuinely needs to read. Checked BEFORE re-activating, so a rejected
  -- save leaves the bundle retired rather than live and unpayable.
  select bc.id into v_clash
    from public.bundle_catalogue bc
   where bc.content_key = v_key
     and bc.id <> v_id
     and bc.is_active
     and bc.content_key <> ''
   limit 1;

  if v_clash is not null then
    -- Left retired: the caller is told why, and the bundle stays off the public
    -- site rather than appearing as a live duplicate of another offer.
    return jsonb_build_object('ok', false,
      'error', format('Bundle "%s" already offers exactly this. Two live bundles cannot be the same.', v_clash));
  end if;

  -- The key is real and unique, so the bundle can go live. Written last, and
  -- only now, which is what makes the whole upsert all-or-nothing from the
  -- public site's point of view.
  update public.bundle_catalogue bc
     set is_active   = coalesce((p_bundle ->> 'is_active')::boolean, true),
         content_key = v_key,
         updated_at  = now()
   where bc.id = v_id;

  perform public.staff_audit(
    case when v_new then 'create_bundle' else 'update_bundle' end,
    'bundle', v_id,
    jsonb_build_object('name', v_name, 'group', v_group, 'lines', jsonb_array_length(v_lines)));

  return jsonb_build_object('ok', true, 'id', v_id, 'content_key', v_key);
end;
$$;

comment on function public.staff_upsert_bundle(jsonb) is
  'Master-only. Replaces a bundle and its include lines in one call. Include lines are numbered from 0; a gap is refused by trg_bundle_include_positions at COMMIT.';

revoke execute on function public.staff_upsert_bundle(jsonb) from public;
grant  execute on function public.staff_upsert_bundle(jsonb) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. a gap can never be stored again
-- ---------------------------------------------------------------------------
--
-- The invariant: within a bundle, the set of positions is exactly 0..n-1.
-- Stated as "the highest position equals the line count minus one", which is one
-- cheap comparison rather than a window function on every write, and is exactly
-- equivalent given (bundle_id, position) is the primary key.
--
-- DEFERRABLE INITIALLY DEFERRED, and that is the whole design. The upsert
-- deletes all lines and re-inserts them one at a time, so mid-save positions
-- are 1,2 with 0 missing - a state that is correct in transit and wrong at
-- rest. An immediate trigger would reject every legitimate save; a deferred one
-- runs at COMMIT, when the bundle is complete, and refuses only a bundle that
-- really was left with a hole.

create or replace function public.bundle_check_positions ()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_bundle text;
  v_max    int;
  v_count  int;
begin
  -- TG_OP, not coalesce(new.bundle_id, old.bundle_id).
  --
  -- On an INSERT the OLD record is unassigned, and reading a field of it raises
  -- "record old is not assigned yet" rather than returning NULL, so the obvious
  -- coalesce() is not merely inelegant here - it is a runtime error on the very
  -- first insert. Naming the operation is also the honest expression of intent:
  -- this trigger only ever cares WHICH bundle was touched, and each operation
  -- names it in exactly one record.
  if tg_op = 'DELETE' then
    v_bundle := old.bundle_id;
  else
    v_bundle := new.bundle_id;
  end if;

  select max(bi.position), count(*)
    into v_max, v_count
    from public.bundle_includes bi
   where bi.bundle_id = v_bundle;

  -- A bundle with no lines is not this trigger's business: the upsert deletes
  -- every line before re-inserting, and an empty bundle is the documented
  -- mid-save state. The "an active bundle must have includes" CHECK on
  -- bundle_catalogue is what enforces the finished state.
  if v_count = 0 then
    return null;
  end if;

  if coalesce(v_max, -1) <> v_count - 1 then
    raise exception
      'Bundle "%" has % include line(s) numbered up to %, so they are not 0..%. This is a bug, not a choice: a gap means a line will be lost or counted twice.',
      v_bundle, v_count, coalesce(v_max, -1), v_count - 1
      using errcode = '23514';
  end if;

  return null;
end;
$$;

comment on function public.bundle_check_positions () is
  'Deferred guard: a bundle''s include lines must be numbered 0..n-1 with no gaps. Deferred to COMMIT because the upsert rewrites every line one at a time, so a gap exists legitimately mid-save.';

drop trigger if exists trg_bundle_include_positions on public.bundle_includes;

create constraint trigger trg_bundle_include_positions
  after insert or delete or update on public.bundle_includes
  deferrable initially deferred
  for each row
  execute function public.bundle_check_positions();

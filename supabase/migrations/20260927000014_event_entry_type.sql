-- =============================================================================
-- NEXUS - who may enter an event: individual or team, and the team cap
-- Migration : 20260927000014_event_entry_type.sql
-- Purpose   : Give every event a real "who may enter this" field, and make the
--             DATABASE the authority for it rather than a piece of display copy.
--
-- WHY THIS EXISTS
--
-- The site has always had to answer two questions about an event: is this a
-- solo entry or a team entry, and if a team, how many at most? It answered them
-- three different ways at once, and none of the three was a rule:
--
--   events.js    teamSize: "2 - 5 MEMBERS"   free text, printed as-is
--                 maxSize:  5 | "individual"  one field, two meanings
--   the table    team_size text, max_size text
--                ('individual' OR a digit string - the column comment says so)
--
-- max_size is the clearest evidence that this was never modelled: it is a text
-- column holding two different KINDS of value, and the comment on it explains
-- why as "the site genuinely has a non-numeric value here and has always
-- rendered both". Nothing could ask the database "may six people enter NEXUS
-- BREACH?" and get an answer worth having, and the console could not even set
-- it: staff_upsert_event read max_size from a key the Event form never sent, so
-- every save blanked the column.
--
-- So this migration adds the two fields the question actually needs:
--
--   entry_type        'individual' | 'team'   - who may enter
--   max_team_members  integer                   - the cap, teams only
--
-- and makes the pair a CONSTRAINT rather than a convention:
--
--   * a team event MUST carry a cap;
--   * an individual event MUST NOT.
--
-- A team event with no cap is refused rather than stored, so "how many may
-- enter?" always has an answer instead of quietly defaulting to one.
--
-- WHY max_size IS NOT DROPPED
--
-- It is redundant now, and it looks like the thing to drop. Dropping it here
-- would break the migration ORDER, though: the generated seed inside migration
-- ...007 writes that column, and ...007 runs BEFORE this file on a fresh
-- project. `npm run db:migrate` re-runs every file in order, so on a brand new
-- database the second run would fail on an INSERT naming a column that no
-- longer exists. So the column stays as a MIRROR - written from the pair below
-- by staff_upsert_event - and ...007's replay of it cannot contradict anything,
-- because that seed ends in `on conflict (id) do nothing`.
--
-- WHY 1 IS A VALID CAP
--
-- "1 - 5 MEMBERS" is a real and common shape on this site: the event takes a
-- team but does not insist on one. The cap is an upper bound, so 1 is a
-- legitimate value and a minimum would be a rule this migration invents.
--
-- Idempotent: add-column-if-not-exists, create-or-replace, and
-- drop-constraint-if-exists + add. The backfill is guarded, so re-running it
-- cannot undo a console edit made since the first run.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. the two fields
-- ---------------------------------------------------------------------------

alter table public.event_catalogue
  add column if not exists entry_type       text    not null default 'individual',
  add column if not exists max_team_members integer;

comment on column public.event_catalogue.entry_type is
  'Who may enter this event: ''individual'' or ''team''. The rule the site renders and the console edits; not display copy.';

comment on column public.event_catalogue.max_team_members is
  'Largest team allowed. Required when entry_type = ''team'' and null when it is ''individual'' - see chk_event_catalogue_team_cap.';

-- ---------------------------------------------------------------------------
-- 2. the backfill
-- ---------------------------------------------------------------------------
--
-- max_size already holds the answer, just packed into one column: a digit
-- string is a cap, 'individual' is not. So most rows need nothing clever.
--
-- The case that needs care is a row the CONSOLE created or edited. That form
-- never sent max_size, so the RPC's `coalesce(p_event ->> 'max_size', '')` has
-- been blanking it on every save - meaning some live rows have max_size = ''
-- and their only surviving evidence is the free-text team_size. So the last
-- branch reads the LAST number out of team_size, which is the cap in every
-- shape the site actually uses:
--
--   "2 - 5 MEMBERS"   -> 5     (the upper bound, which is what a cap is)
--   "SQUAD OF 4"      -> 4
--   "SOLO"            -> no digits -> no cap
--
-- Reversing the string to take the LAST run is the whole trick; the leading
-- `[^0-9]*` is what lets it skip the words before it ("SREBMEM " -> "5").
--
-- A row where no cap can be derived is stored as individual rather than as a
-- cap-less team, because a cap-less team is exactly the state this migration
-- exists to remove. Those rows are reported in the notice below rather than
-- left for someone to discover on the public site.

with derived as (
  select ec.id,
         case
           -- a digit max_size WAS the team cap
           when ec.max_size ~ '^[0-9]{1,4}$'
             and ec.max_size::integer between 1 and 50
             then ec.max_size::integer
           -- 'individual' states the answer outright and carries no cap
           when lower(btrim(ec.max_size)) in ('individual', 'solo') then null
           -- blanked by the console: fall back to the last number in team_size
           else nullif(
                  substring(
                    reverse(coalesce(ec.team_size, '')) from '[^0-9]*([0-9]+)'),
                    ''
                )::integer
         end as raw_cap
    from public.event_catalogue ec
),
resolved as (
  -- Out of range is treated as "no cap", not clamped: a max_size of 900 is a
  -- wrong number, and silently turning it into 50 would publish a rule nobody
  -- chose.
  select d.id, case when d.raw_cap between 1 and 50 then d.raw_cap end as cap
    from derived d
)
update public.event_catalogue ec
   set entry_type       = case when r.cap is not null then 'team' else 'individual' end,
       max_team_members = r.cap
  from resolved r
 where r.id = ec.id
   -- The guard is what makes a re-run a genuine no-op: without it this UPDATE
   -- rewrites all eleven rows on every `db:migrate` even when nothing changed.
   --
   -- Note what actually protects a console edit from being reverted, because it
   -- is NOT this guard. A master who switches an event to individual in the
   -- console goes through staff_upsert_event, which writes the legacy max_size
   -- mirror at the same time, so the derivation below reads 'individual' and
   -- agrees with the edit - and then the guard skips the row entirely. A direct
   -- `update` that moved entry_type alone, bypassing the RPC, would drift from
   -- its own mirror and the next db:migrate would put it back. That is the cost
   -- of keeping the mirror alive for migration ...007, and it is the right way
   -- round: every write the application can actually make stays consistent.
   and (ec.entry_type, ec.max_team_members)
       is distinct from
       (case when r.cap is not null then 'team' else 'individual' end, r.cap);

do $$
declare
  v_ids text;
begin
  select string_agg(id, ', ' order by id) into v_ids
    from public.event_catalogue
   where nullif(btrim(team_size), '') is not null
     and team_size !~* 'solo'
     and team_size !~* 'individual'
     and entry_type = 'individual';

  if v_ids is not null then
    raise notice
      'entry_type backfill: no team cap could be derived for [%], so they were stored as individual. Set entry_type and max_team_members in the admin catalogue if that is wrong.', v_ids;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. the rules
-- ---------------------------------------------------------------------------
-- Drop-then-add rather than add-if-not-exists, which Postgres does not have for
-- constraints. The same pair is used in migration ...011 for the roster export
-- columns, and for the same reason: it makes the statement re-runnable AND lets
-- a wrong definition be corrected by re-applying the file.

alter table public.event_catalogue
  drop constraint if exists chk_event_catalogue_entry_type;

alter table public.event_catalogue
  add constraint chk_event_catalogue_entry_type
    check (entry_type in ('individual', 'team'));

alter table public.event_catalogue
  drop constraint if exists chk_event_catalogue_team_cap;

alter table public.event_catalogue
  add constraint chk_event_catalogue_team_cap
    check (
      (entry_type = 'team' and max_team_members is not null
                     and max_team_members between 1 and 50)
      or
      (entry_type = 'individual' and max_team_members is null)
    );

-- `max_team_members is not null` is load-bearing, not decoration. Without it
-- `null between 1 and 50` is NULL, not FALSE, and a CHECK rejects a row only
-- when it evaluates to FALSE — so a cap-less team would sail straight through
-- the very constraint written to stop it. The RPC already refuses that write
-- with a sentence; this is what stops the writer that is not the RPC.

comment on constraint chk_event_catalogue_team_cap on public.event_catalogue is
  'The entry rule: a team carries how many may enter, an individual carries nothing. This is what makes "team with no cap" unstorable rather than merely unlikely.';

-- ---------------------------------------------------------------------------
-- 4. staff_upsert_event
-- ---------------------------------------------------------------------------
-- Validated in the function, and not left to the CHECK, because a console shows
-- the operator a sentence and a raw 23514 is not one. The CHECK stays as the
-- backstop for a writer that is not this function.

create or replace function public.staff_upsert_event (p_event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id      text := p_event ->> 'id';
  v_realm   text := p_event ->> 'realm';
  v_title   text := coalesce(nullif(trim(p_event ->> 'title'), ''), null);
  v_entry   text := lower(nullif(trim(coalesce(p_event ->> 'entry_type', '')), ''));
  v_raw_cap text := nullif(btrim(coalesce(p_event ->> 'max_team_members', '')), '');
  v_raw_max text := nullif(btrim(coalesce(p_event ->> 'max_size', '')), '');
  v_cap     integer;
  v_new     boolean;
begin
  if not public.staff_at_least('master') then
    return jsonb_build_object('ok', false,
      'error', 'Only a master administrator can change the event catalogue.');
  end if;

  if v_id is null or v_id !~ '^[a-z0-9][a-z0-9-]{1,48}$' then
    return jsonb_build_object('ok', false,
      'error', 'Event id must be 2-49 characters: a-z, 0-9 and dashes.');
  end if;

  if v_title is null then
    return jsonb_build_object('ok', false, 'error', 'An event needs a title.');
  end if;

  if v_realm is null or v_realm not in ('forge', 'paradox', 'arena') then
    return jsonb_build_object('ok', false,
      'error', 'Choose a realm: technical, non-technical or esports.');
  end if;

  -- A console that predates this migration sends neither entry_type nor
  -- max_team_members, only the old packed max_size. Deriving the pair from it
  -- means an un-updated tab keeps working instead of failing the new CHECK, and
  -- it is the same derivation the backfill makes, so both agree by construction.
  if v_entry is null then
    v_entry := case when v_raw_max ~ '^[0-9]{1,4}$' then 'team' else 'individual' end;
  end if;
  if v_raw_cap is null and v_entry = 'team' and v_raw_max ~ '^[0-9]{1,4}$' then
    v_raw_cap := v_raw_max;
  end if;

  if v_entry not in ('individual', 'team') then
    return jsonb_build_object('ok', false,
      'error', 'Choose an entry type: individual or team.');
  end if;

  if v_entry = 'individual' then
    -- Normalised rather than refused. The form hides the cap field for a solo
    -- event, so a stale value left in it is a UI accident and not a mistake
    -- worth an error the operator cannot act on. Storing null here is what
    -- keeps chk_event_catalogue_team_cap true for EVERY writer.
    v_cap := null;
  else
    if v_raw_cap is null then
      return jsonb_build_object('ok', false,
        'error', 'A team event needs a maximum team size - how many members at most?');
    end if;
    if v_raw_cap !~ '^-?[0-9]+$' then
      return jsonb_build_object('ok', false,
        'error', 'Maximum team size must be a whole number.');
    end if;
    v_cap := v_raw_cap::integer;
    if v_cap < 1 or v_cap > 50 then
      return jsonb_build_object('ok', false,
        'error', 'Maximum team size must be between 1 and 50.');
    end if;
  end if;


  select not exists (select 1 from public.event_catalogue ec where ec.id = v_id)
    into v_new;

  insert into public.event_catalogue as ec
    (id, number, title, category, mode, realm, tagline, about, event_date, venue,
     team_size, entry_type, max_team_members, max_size, status, accent, sigil,
     link_key, sort_order, is_active, updated_by)
  values
    (v_id,
     coalesce(nullif(trim(p_event ->> 'number'), ''), 'NEW'),
     v_title,
     nullif(trim(coalesce(p_event ->> 'category', '')), ''),
     nullif(trim(coalesce(p_event ->> 'mode', '')), ''),
     v_realm,
     coalesce(p_event ->> 'tagline', ''),
     coalesce(array(select jsonb_array_elements_text(coalesce(p_event -> 'about', '[]'::jsonb))), '{}'),
     coalesce(p_event ->> 'event_date', ''),
     coalesce(p_event ->> 'venue', ''),
     coalesce(p_event ->> 'team_size', ''),
     v_entry,
     v_cap,
     -- The legacy mirror, derived here rather than trusted: a client cannot
     -- write a max_size that disagrees with the pair above it.
     case when v_entry = 'team' then v_cap::text else 'individual' end,
     coalesce(nullif(trim(p_event ->> 'status'), ''), 'REGISTRATION OPEN'),
     nullif(trim(coalesce(p_event ->> 'accent', '')), ''),
     nullif(trim(coalesce(p_event ->> 'sigil', '')), ''),
     nullif(trim(coalesce(p_event ->> 'link_key', '')), ''),
     coalesce(nullif(trim(p_event ->> 'sort_order'), '')::int, 0),
     coalesce((p_event ->> 'is_active')::boolean, true),
     (select s.username from public.staff_session() s))
  on conflict (id) do update
     set number            = excluded.number,
         title             = excluded.title,
         category          = excluded.category,
         mode              = excluded.mode,
         realm             = excluded.realm,
         tagline           = excluded.tagline,
         about             = excluded.about,
         event_date        = excluded.event_date,
         venue             = excluded.venue,
         team_size         = excluded.team_size,
         entry_type        = excluded.entry_type,
         max_team_members  = excluded.max_team_members,
         max_size          = excluded.max_size,
         status            = excluded.status,
         accent            = excluded.accent,
         sigil             = excluded.sigil,
         link_key          = excluded.link_key,
         sort_order        = excluded.sort_order,
         is_active         = excluded.is_active,
         updated_at        = now(),
         updated_by        = excluded.updated_by;

  -- entry_type and the cap are in the audit payload: "who may enter this, and
  -- how many" is the change an operations lead would need to explain later.
  perform public.staff_audit(
    case when v_new then 'create_event' else 'update_event' end,
    'event', v_id,
    jsonb_build_object('title', v_title, 'realm', v_realm,
                       'entry_type', v_entry, 'max_team_members', v_cap));

  return jsonb_build_object('ok', true, 'id', v_id);
end;
$$;

revoke execute on function public.staff_upsert_event(jsonb) from public;
grant  execute on function public.staff_upsert_event(jsonb) to anon, authenticated;


-- ---------------------------------------------------------------------------
-- 5. the public read
-- ---------------------------------------------------------------------------
-- Recreated rather than altered: the JSON is built field by field, so the new
-- pair has to be added to the object. Both keys are always present, so a caller
-- never has to tell "this event is individual" apart from "this event predates
-- the field" by testing for the key.

create or replace function public.public_catalogue ()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'events', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', ec.id, 'number', ec.number, 'title', ec.title,
               'category', ec.category, 'mode', ec.mode, 'realm', ec.realm,
               'tagline', ec.tagline, 'about', ec.about,
               'event_date', ec.event_date, 'venue', ec.venue,
               'team_size', ec.team_size,
               'entry_type', ec.entry_type, 'max_team_members', ec.max_team_members,
               'max_size', ec.max_size,
               'status', ec.status, 'accent', ec.accent, 'sigil', ec.sigil,
               'link_key', ec.link_key, 'sort_order', ec.sort_order
             ) order by ec.sort_order, ec.id)
        from public.event_catalogue ec where ec.is_active
    ), '[]'::jsonb),
    'bundles', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', bc.id, 'number', bc.number, 'name', bc.name,
               'group_id', bc.group_id, 'kicker', bc.kicker,
               'title_lines', bc.title_lines, 'sort_order', bc.sort_order,
               'includes', coalesce((
                 select jsonb_agg(jsonb_build_object(
                          'event', bi.event_id,
                          'pick', bi.pick_realm,
                          'count', bi.pick_count,
                          'excludeHackathon', bi.exclude_hackathon
                        ) order by bi.position)
                   from public.bundle_includes bi where bi.bundle_id = bc.id
               ), '[]'::jsonb)
             ) order by bc.sort_order, bc.id)
        from public.bundle_catalogue bc where bc.is_active
    ), '[]'::jsonb)
  );
$$;

comment on function public.public_catalogue is
  'Active events with their include lines, in one response, so a bundle card can never render against a half-loaded catalogue. Public by design: it returns nothing that is not already on the public site.';


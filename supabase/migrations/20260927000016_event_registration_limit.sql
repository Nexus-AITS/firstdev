-- =============================================================================
-- NEXUS - how many people may register, and a live count of how many have
-- Migration : 20260927000016_event_registration_limit.sql
-- Purpose   : Cap an event at a number of individuals, allow "no limit", enforce
--             the cap where nobody can route around it, and publish the count so
--             every event card can show it.
--
-- WHY THIS EXISTS
--
-- ...014 made an event say WHO may enter (one person, or a team up to N) and
-- ...015 gave it a price. Neither says HOW MANY people in total. An organiser
-- setting up a 60-seat workshop has no way to express that, and a participant
-- has no way to see that the seats are going.
--
-- The two halves have to agree, and the agreement is the hard part:
--
--   * The cap is stored as a NUMBER, with null meaning "no limit". Not zero,
--     and not a magic sentinel - a null cap is an event nobody has limited yet,
--     which is the true state of all eleven events on day one.
--
--   * The count that decides whether a seat is free is computed by ONE function,
--     public.event_registered_count, which the enforcement trigger and the
--     public read both call. Two definitions of "registered" is how a cap and a
--     counter end up disagreeing on the same page, which is worse than either
--     being absent.
--
-- WHY THE CAP IS A TRIGGER, NOT A LINE IN registration_set_events
--
-- Because registration_events is INSERTable straight from the browser:
-- migration ...006 grants participant_add_own_events to authenticated, so a
-- participant can post a row to that table without going near
-- registration_set_events at all. A check inside that function would therefore
-- be a suggestion. The trigger on the table is the single point every join must
-- pass through, and it is the same argument migration ...011 makes for the FREE
-- FIRE id.
--
-- WHAT COUNTS AS REGISTERED
--
-- A registration that has this event in its selection, and whose payment has
-- not been REJECTED. Pending and submitted both hold a seat, because the seat is
-- why the money is being taken; a rejected payment did not take one, and
-- counting it would make a full event look full for people who are not in it.
-- NULL payment_status counts too - that is the state of a row written before the
-- status existed, and refusing a seat on a technicality helps nobody.
--
-- Idempotent: add-column-if-not-exists, create-or-replace, drop-*-if-exists.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. the cap
-- ---------------------------------------------------------------------------
-- NULL = no limit. Anything else must be at least 1, because a cap of zero would
-- make the event permanently unregisterable and there is no reading of "no
-- limit" that wants that.

alter table public.event_catalogue
  add column if not exists max_registrations integer;

alter table public.event_catalogue
  drop constraint if exists chk_event_catalogue_max_registrations;

alter table public.event_catalogue
  add constraint chk_event_catalogue_max_registrations
    check (max_registrations is null or max_registrations >= 1);

comment on column public.event_catalogue.max_registrations is
  'Total people allowed to register for this event, or null for no limit. Separate from max_team_members, which caps ONE team rather than the whole event. Enforced by trg_event_registration_cap.';

-- ---------------------------------------------------------------------------
-- 2. one definition of "registered"
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER on purpose. A participant can read their own rows under RLS
-- but not the whole table, and a count that silently returned only "mine" would
-- be wrong in a way that looks correct: a nearly-full event would report 0 and
-- every seat would look free.

create or replace function public.event_registered_count (p_event_id text)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::integer
    from public.registration_events re
    join public.registrations r
      on r.id = re.registration_id
   where re.event_id = p_event_id
     and (r.payment_status is null or r.payment_status <> 'rejected');
$$;

comment on function public.event_registered_count(text) is
  'People holding a seat for an event: a selection containing it, payment not rejected. The single definition used by both the cap trigger and the public counter, so a limit and a displayed number can never disagree.';

revoke execute on function public.event_registered_count(text) from public;
grant  execute on function public.event_registered_count(text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. the cap, enforced
-- ---------------------------------------------------------------------------
-- BEFORE INSERT, so a refused join never leaves a row behind. The count naturally
-- excludes the person being inserted (their row does not exist yet), and
-- registration_set_events deletes that person's previous selection before
-- re-inserting, so re-saving a selection cannot count them twice either.

create or replace function public.enforce_event_registration_cap ()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_cap   integer;
  v_count integer;
begin
  select ec.max_registrations into v_cap
    from public.event_catalogue ec
   where ec.id = new.event_id;

  if v_cap is null then
    return new;  -- no limit set: nothing to enforce
  end if;

  v_count := public.event_registered_count(new.event_id);

  if v_count >= v_cap then
    raise exception
      'That event is full - it allows % registration(s) and all of them are taken.', v_cap
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_event_registration_cap on public.registration_events;
create trigger trg_event_registration_cap
  before insert on public.registration_events
  for each row
  execute function public.enforce_event_registration_cap ();

comment on function public.enforce_event_registration_cap () is
  'Refuses a registration for an event that has reached its limit. Lives on the table rather than in registration_set_events because registration_events is directly insertable by a participant under RLS, so a check inside the function would be bypassable.';


-- ---------------------------------------------------------------------------
-- 4. staff_upsert_event, now carrying the limit
-- ---------------------------------------------------------------------------
-- The last rewrite of this function (...015 added the price; this adds the cap),
-- and the reason it keeps growing is deliberate: the console's event form is ONE
-- save, so the call that owns an event has to own every fact about it. Splitting
-- the cap into its own function would mean a form that could half-succeed.
--
-- Be aware when editing it that this is the version that RUNS: ...015 defines the
-- same function, and migrations apply in order, so anything changed in ...015
-- must be mirrored here or this copy silently wins.
--
-- `max_registrations` is read as TEXT and normalised, because the form sends an
-- empty string for "no limit" and a JSON number otherwise, and the difference
-- between those two must not become a validation error the operator has to
-- learn: a blank means no limit, and 0 is refused.

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
  v_price   text := nullif(btrim(coalesce(p_event ->> 'price', '')), '');
  v_raw_seats text := nullif(btrim(coalesce(p_event ->> 'max_registrations', '')), '');
  v_seats   integer;
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

  if v_price is not null then
    if v_price !~ '^-?[0-9]+$' or v_price::integer < 0 or v_price::integer > 1000000 then
      return jsonb_build_object('ok', false,
        'error', 'Enter a whole number of rupees, zero or more.');
    end if;
  end if;

  -- Blank is "no limit" and stays null. 0 is a number, and is refused, because a
  -- capped-at-zero event is unregisterable rather than unlimited.
  if v_raw_seats is not null then
    if v_raw_seats !~ '^-?[0-9]+$' then
      return jsonb_build_object('ok', false,
        'error', 'The registration limit must be a whole number, or blank for no limit.');
    end if;
    v_seats := v_raw_seats::integer;
    if v_seats < 1 then
      return jsonb_build_object('ok', false,
        'error', 'The registration limit must be at least 1, or blank for no limit.');
    end if;
  end if;


  select not exists (select 1 from public.event_catalogue ec where ec.id = v_id)
    into v_new;

  insert into public.event_catalogue as ec
    (id, number, title, category, mode, realm, tagline, about, event_date, venue,
     team_size, entry_type, max_team_members, max_size, max_registrations, status,
     accent, sigil, link_key, sort_order, is_active, updated_by)
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
     case when v_entry = 'team' then v_cap::text else 'individual' end,
     v_seats,
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
         max_registrations = excluded.max_registrations,
         status            = excluded.status,
         accent            = excluded.accent,
         sigil             = excluded.sigil,
         link_key          = excluded.link_key,
         sort_order        = excluded.sort_order,
         is_active         = excluded.is_active,
         updated_at        = now(),
         updated_by        = excluded.updated_by;

  -- Lowering a cap below the number already registered is ALLOWED on purpose. It
  -- is a real operational move - a venue shrank, a sponsor pulled out - and
  -- refusing to save it would leave the organiser unable to record reality. The
  -- trigger stops the next person from taking a seat; it does not evict anyone
  -- who already holds one.

  update public.pricing p
     set entry_type = v_entry, updated_at = now()
   where p.kind = 'event' and p.ref_id = v_id and p.entry_type is distinct from v_entry;

  if v_price is not null then
    insert into public.pricing as pr
      (kind, ref_id, entry_type, price, is_active, updated_by)
    values
      ('event', v_id, v_entry, v_price::integer, true,
       (select s.username from public.staff_session() s))
    on conflict (kind, ref_id) do update
       set price      = excluded.price,
           is_active  = true,
           updated_at = now(),
           updated_by = excluded.updated_by;
  end if;

  perform public.staff_audit(
    case when v_new then 'create_event' else 'update_event' end,
    'event', v_id,
    jsonb_build_object('title', v_title, 'realm', v_realm,
                       'entry_type', v_entry, 'max_team_members', v_cap,
                       'max_registrations', v_seats,
                       'price', case when v_price is null then null
                                     else v_price::integer end,
                       'registered', public.event_registered_count(v_id)));

  return jsonb_build_object('ok', true, 'id', v_id, 'entry_type', v_entry,
                            'max_team_members', v_cap, 'max_registrations', v_seats);
end;
$$;

revoke execute on function public.staff_upsert_event(jsonb) from public;
grant  execute on function public.staff_upsert_event(jsonb) to anon, authenticated;


-- ---------------------------------------------------------------------------
-- 5. the public read carries the count and the cap
-- ---------------------------------------------------------------------------
-- This is what the event cards read. public_catalogue was already the one call
-- that returns a whole catalogue (migration ...007 rebuilt it to prevent a
-- half-loaded bundle card, ...015 added the price); the counter belongs on the
-- same object for the same reason, so a card is never assembled from a
-- catalogue row in one response and a count from another.
--
-- registered_count comes from the SAME function the cap trigger calls. A card
-- that said 40/60 while the trigger was refusing the 41st would be the worst
-- possible failure for a page whose whole job is to tell the truth about space.
--
-- Supersedes the ...015 definition; migrations apply in order, so this is the one
-- that survives.

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
               'max_registrations', ec.max_registrations,
               'registered_count', public.event_registered_count(ec.id),
               'price', (select pr.price from public.pricing pr
                          where pr.kind = 'event' and pr.ref_id = ec.id
                            and pr.entry_type = ec.entry_type and pr.is_active),
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
               'price', (select pr.price from public.pricing pr
                          where pr.kind = 'bundle' and pr.ref_id = bc.id
                            and pr.entry_type = 'individual' and pr.is_active),
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
  'Active events and bundles with their price, entry rule and live registration count, in one response, so a card is never assembled from two sources and a count can never disagree with the cap enforcing it. Public by design: it returns nothing that is not already on the public site.';

-- ---------------------------------------------------------------------------
-- 6. the counter is public, the cap is not editable by anyone but a master
-- ---------------------------------------------------------------------------
-- A participant may ask "how many are registered?" without a staff token, so the
-- count is exposed as its own tiny RPC rather than needing a table grant. It
-- returns the count AND the cap together, for the reason in section 5.

create or replace function public.event_seats (p_event_id text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'event_id', p_event_id,
    'registered', public.event_registered_count(p_event_id),
    'limit', ec.max_registrations,
    'full', ec.max_registrations is not null
            and public.event_registered_count(ec.id) >= ec.max_registrations)
    from public.event_catalogue ec
   where ec.id = p_event_id and ec.is_active;
$$;

comment on function public.event_seats(text) is
  'Live seat state for one event: how many people hold a seat, the limit if there is one, and whether it is full. Count and cap in one value so a page cannot show a number that disagrees with the limit beside it.';

revoke execute on function public.event_seats(text) from public;
grant  execute on function public.event_seats(text) to anon, authenticated;


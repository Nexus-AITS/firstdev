-- =============================================================================
-- NEXUS - a registration has a LAST DAY, and the cap is enforced everywhere
-- Migration : 20260927000034_registration_deadline.sql
-- Purpose   : Give every event a deadline on which registration closes, and
--             close three paths by which an event could still take a
--             registration past that deadline or past its limit.
--
-- WHY THIS EXISTS
--
-- The console could express "how many" (max_registrations, migration ...016) but
-- never "until when". An organiser closing sign-ups for a workshop had no way to
-- say so, and nothing in the database would have stopped them either - `status`
-- is free text that no rule reads. The only way to close an event was to retire
-- it, which takes it off the public site entirely. Closing registration and
-- withdrawing an event are different operations and the console could only do
-- the second one.
--
-- WHAT WAS NOT ENFORCED
--
-- Three concrete holes, all reachable, none theoretical:
--
--   1. A RETIRED event still accepted registrations. registrations_join_single_event
--      checks that purchase_ref names a row in event_catalogue; it did not check
--      is_active. The bundle path (registration_set_events) DID check it. So a
--      participant posting purchase_type='event' with a retired id took a seat on
--      an offer that had been withdrawn - and the cap trigger did not care,
--      because it only ever compared a count against a number.
--
--   2. RE-VERIFYING A REJECTED PAYMENT bypassed the cap. enforce_event_registration_cap
--      is BEFORE INSERT on registration_events, so it runs exactly once per seat.
--      staffSetStatus is a PATCH on registrations. Rejecting a payment removes
--      the row from event_registered_count (which excludes 'rejected'), so a seat
--      frees; flipping that same row back to 'unverified' puts it back into the
--      count with no check at all. An operator working through a backlog could
--      walk an event past its limit one status flip at a time, and the console
--      would report the over-cap number as fact.
--
--   3. A registration could still JOIN AN EVENT that was no longer available,
--      for the same reason as (1), from the direct INSERT path that migration
--      ...006 grants to a signed-in participant.
--
-- WHY ALL THREE LAND IN THE SAME TRIGGER
--
-- Because registration_events is the only table every writer must pass through.
-- registration_set_events writes it, registrations_join_single_event writes it,
-- and a participant may INSERT it directly under the policy from ...006. A check
-- inside one function is a suggestion about one function - the argument
-- migrations ...011 and ...016 both make, and the reason those two put their rule
-- on the table. Three rules, one choke point.
--
-- WHY A DATE AND NOT A TIMESTAMPTZ
--
-- "Registration closes on 5 October" is a CALENDAR DAY, not an instant, and the
-- console's own DateField (src/components/ui/DateField.jsx) says so: it handles
-- every date as three numbers precisely because `new Date("2026-10-05")` is
-- midnight UTC and formatting that back prints the 4th in IST. Storing a
-- timestamptz would reintroduce that bug one layer down, where the operator
-- cannot see it. The comparison is therefore made in Asia/Kolkata explicitly,
-- which is the zone staff_export_registrations and DateField already use.
--
-- NULL IS "NO DEADLINE", NOT "CLOSED"
--
-- Every event starts null, and null is what an event nobody has set a date on
-- should mean. The opposite default - an event nobody has configured yet being
-- silently closed - would make the feature unsafe to ship: applying this
-- migration would close all eleven events at once.
--
-- WHY THE PAYMENT-STATUS TRIGGER RAISES RATHER THAN WARNS
--
-- When a rejected payment is accepted back it takes a real seat. If the event
-- is full there is no room, and recording the acceptance anyway would leave the
-- database over its own limit - the state this file exists to make impossible.
-- The refusal names the event and the fix, because the fix is a real operational
-- action: raise the cap first, then flip the status.
--
-- NOT CHANGED HERE, DELIBERATELY
--
--   * Editing an EXISTING registration's team list. registration_closes_on
--     closes new sign-ups; it is not the selection freeze (migration ...008),
--     which stops a participant changing what they already bought.
--   * Lowering a cap below the current count. Migration ...028 records that as a
--     deliberate decision - a real operational change, nobody evicted.
--   * The meaning of max_registrations. It counts SQUADS for a per_team event and
--     PEOPLE for a per_person one. A cap that changed meaning on every deploy
--     would silently re-price events.
--
-- Idempotent: add-column-if-not-exists, create-or-replace, drop-trigger-if-
-- exists. Re-running cannot change a stored deadline.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. the deadline
-- ---------------------------------------------------------------------------

alter table public.event_catalogue
  add column if not exists registration_closes_on date;

comment on column public.event_catalogue.registration_closes_on is
  'The last calendar day (Asia/Kolkata) on which a NEW registration may take a seat for this event, or null for no deadline. A date rather than a timestamptz on purpose: "closes on 5 Oct" must mean the whole of 5 Oct in India, which is what DateField types and what staff_export_registrations filters by. Null means open, and is how every event starts. Enforced by trg_event_registration_cap alongside the seat limit.';

-- ---------------------------------------------------------------------------
-- 2. one trigger, three rules
-- ---------------------------------------------------------------------------
-- BEFORE INSERT, so a refused join never leaves a row behind - the same argument
-- ...016 makes, and the same reason this is a trigger rather than a line in
-- registration_set_events. The count naturally excludes the row being inserted
-- (it does not exist yet), and registration_set_events deletes the previous
-- selection before re-inserting, so re-saving cannot count anybody twice.

create or replace function public.enforce_event_registration_cap ()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_cap     integer;
  v_count   integer;
  v_closes  date;
  v_active  boolean;
  v_title   text;
begin
  select ec.max_registrations, ec.registration_closes_on, ec.is_active, ec.title
    into v_cap, v_closes, v_active, v_title
    from public.event_catalogue ec
   where ec.id = new.event_id;

  -- Rule 1: the offer has to still be on sale. An id that is not in the
  -- catalogue at all is left to registration_set_events to report, which names
  -- the event; this trigger only speaks about rows it can find.
  if v_active is false then
    raise exception
      '% is no longer open for registration.', coalesce(v_title, new.event_id)
      using errcode = '23514';
  end if;

  -- Rule 2: the last day. Strictly greater-than, so the deadline day itself is
  -- still open - "closes on 5 Oct" has to include 5 Oct, or the console says one
  -- thing and the database does another.
  if v_closes is not null
     and (now() at time zone 'Asia/Kolkata')::date > v_closes then
    raise exception
      'Registration for % closed on %s.', coalesce(v_title, new.event_id),
      to_char(v_closes, 'DD Mon YYYY')
      using errcode = '23514';
  end if;

  -- Rule 3: the seat limit. null means no limit, which is how every event starts.
  if v_cap is null then
    return new;
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

comment on function public.enforce_event_registration_cap () is
  'BEFORE INSERT on registration_events. Three rules in the one place every writer passes: the event must still be active, the deadline (registration_closes_on, Asia/Kolkata) must not have passed, and the seat limit must not be reached. Lives on the table rather than in registration_set_events because registration_events is directly insertable by a participant under RLS, so a check inside the function would be bypassable.';

drop trigger if exists trg_event_registration_cap on public.registration_events;

create trigger trg_event_registration_cap
  before insert on public.registration_events
  for each row
  execute function public.enforce_event_registration_cap ();

-- ---------------------------------------------------------------------------
-- 3. accepting a rejected payment back re-takes a seat, so it re-checks
-- ---------------------------------------------------------------------------
-- The gap this closes, precisely: the cap trigger above runs once per seat, on
-- INSERT. A row flipped from 'rejected' to 'unverified' reappears inside
-- event_registered_count() - which excludes rejected rows and so counts this one
-- again - without any INSERT happening at all. staffSetStatus is a plain PATCH,
-- so nothing stood in the way.

create or replace function public.enforce_reinstated_registration_cap ()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_re     record;
  v_cap    integer;
  v_count  integer;
  v_closes date;
begin
  -- Only a move OUT of rejected re-takes a seat. unverified -> verified, or any
  -- other transition among the states that already count, changes nothing about
  -- how many seats the event is holding and must not be second-guessed here.
  if new.payment_status is distinct from 'rejected'
     or old.payment_status is not distinct from 'rejected' then
    return new;
  end if;

  for v_re in
    select re.event_id, ec.title, ec.max_registrations, ec.registration_closes_on
      from public.registration_events re
      join public.event_catalogue ec on ec.id = re.event_id
     where re.registration_id = new.id
  loop
    v_count  := public.event_registered_count(v_re.event_id);
    v_cap    := v_re.max_registrations;
    v_closes := v_re.registration_closes_on;

    if v_cap is not null and v_count > v_cap then
      raise exception
        'This registration holds a seat for %, which already has % of % registration(s). Raise the limit first, then accept it back.',
        v_re.title, v_count, v_cap
        using errcode = '23514';
    end if;

    if v_closes is not null
       and (now() at time zone 'Asia/Kolkata')::date > v_closes then
      raise exception
        'This registration holds a seat for %, whose registration closed on %s. Raise the deadline or clear it first, then accept it back.',
        v_re.title, to_char(v_closes, 'DD Mon YYYY')
        using errcode = '23514';
    end if;
  end loop;

  return new;
end;
$$;

comment on function public.enforce_reinstated_registration_cap () is
  'BEFORE UPDATE OF payment_status on registrations, and only when a row moves OUT of rejected. event_registered_count() excludes rejected rows, so accepting a rejected payment back re-takes a real seat - and the BEFORE INSERT cap trigger cannot see it, because no INSERT happens. Refuses the acceptance rather than recording an over-cap or post-deadline state, and names the order of the fix.';

drop trigger if exists trg_registrations_reinstated_cap on public.registrations;

create trigger trg_registrations_reinstated_cap
  before update of payment_status on public.registrations
  for each row
  execute function public.enforce_reinstated_registration_cap ();

-- ---------------------------------------------------------------------------
-- 4. the console's save carries the deadline
-- ---------------------------------------------------------------------------
-- Recreated whole rather than altered: the console's event form is ONE save, so
-- the call that owns an event has to own every fact about it. The pattern is
-- migration ...028's, down to the `p_event ? 'key'` guards that stop a partial
-- update from blanking a field it never mentioned.

create or replace function public.staff_upsert_event (p_event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id        text := p_event ->> 'id';
  v_realm     text := p_event ->> 'realm';
  v_title     text := coalesce(nullif(trim(p_event ->> 'title'), ''), null);
  v_entry     text := lower(nullif(trim(coalesce(p_event ->> 'entry_type', '')), ''));
  v_raw_cap   text := nullif(btrim(coalesce(p_event ->> 'max_team_members', '')), '');
  v_raw_max   text := nullif(btrim(coalesce(p_event ->> 'max_size', '')), '');
  v_price     text := nullif(btrim(coalesce(p_event ->> 'price', '')), '');
  v_raw_seats text := nullif(btrim(coalesce(p_event ->> 'max_registrations', '')), '');
  v_raw_close text := nullif(btrim(coalesce(p_event ->> 'registration_closes_on', '')), '');
  v_team_url  text := nullif(trim(coalesce(p_event ->> 'team_form_url', '')), '');
  v_closes    date;
  v_offsite   boolean;
  v_pay_mode  text;
  -- What the row already says, for the fields a client may have left out.
  v_prev_entry   text;
  v_prev_cap     integer;
  v_prev_offsite boolean;
  v_exists       boolean := false;
  v_seats        integer;
  v_cap          integer;
  v_new          boolean;
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

  -- Read the current row BEFORE resolving anything, so a partial update is safe.
  select ec.entry_type, ec.max_team_members, ec.team_formed_offsite
    into v_prev_entry, v_prev_cap, v_prev_offsite
    from public.event_catalogue ec
   where ec.id = v_id;
  v_exists := found;

  if v_entry is null then
    v_entry := case
      when v_exists then v_prev_entry
      else case when v_raw_max ~ '^[0-9]{1,4}$' then 'team' else 'individual' end
    end;
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
    -- Falling back to the row's own cap keeps a partial update from wiping the
    -- squad size, which would fail the CHECK and make the event unsaveable.
    if v_raw_cap is null and v_exists then
      v_cap := v_prev_cap;
    elsif v_raw_cap is not null then
      if v_raw_cap !~ '^-?[0-9]+$' then
        return jsonb_build_object('ok', false,
          'error', 'Maximum team size must be a whole number.');
      end if;
      v_cap := v_raw_cap::integer;
    end if;

    if v_cap is null then
      return jsonb_build_object('ok', false,
        'error', 'A team event needs a maximum team size - how many members at most?');
    end if;
    if v_cap < 1 or v_cap > 50 then
      return jsonb_build_object('ok', false,
        'error', 'Maximum team size must be between 1 and 50.');
    end if;
  end if;

  -- The flag, by PRESENCE rather than by value, for the reason every other
  -- optional field in this function is: the form sends false to clear it, and
  -- coalesce on a value cannot tell "clear it" from "did not mention it".
  if p_event ? 'team_formed_offsite' then
    v_offsite := coalesce((p_event ->> 'team_formed_offsite')::boolean, false);
  else
    v_offsite := coalesce(v_prev_offsite, false);
  end if;

  -- DERIVED, never read from the client. A team pays as a team; a team formed
  -- elsewhere charges per member; an individual is always per person.
  v_pay_mode := case
    when v_entry = 'team' and v_offsite is not true then 'per_team'
    else 'per_person'
  end;

  if v_price is not null then
    if v_price !~ '^-?[0-9]+$' or v_price::integer < 0 or v_price::integer > 1000000 then
      return jsonb_build_object('ok', false,
        'error', 'Enter a whole number of rupees, zero or more.');
    end if;
  end if;

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

-- The deadline. Validated as a DATE HERE rather than left to the column type,
  -- because the column would raise a bare 22007 that the console cannot turn
  -- into a sentence the operator can act on. Blank is null, which is "no
  -- deadline" - the form's Clear button sends "" and that has to mean open.
  if v_raw_close is not null then
    if v_raw_close !~ '^\d{4}-\d{2}-\d{2}$' then
      return jsonb_build_object('ok', false,
        'error', 'The closing date must be a calendar date like 2026-10-05, or blank for no deadline.');
    end if;
    begin
      v_closes := v_raw_close::date;
    exception when others then
      return jsonb_build_object('ok', false,
        'error', v_raw_close || ' is not a real date.');
    end;
  end if;

  -- Only an http(s) URL is stored. team_form_url is rendered as an href, so a
  -- javascript: or data: value here would be a stored XSS served from our own
  -- origin, and a master session should not be able to write one.
  if v_team_url is not null and v_team_url !~* '^https?://' then
    return jsonb_build_object('ok', false,
      'error', 'The team link must start with http:// or https://');
  end if;

  select not exists (select 1 from public.event_catalogue ec where ec.id = v_id)
    into v_new;

  insert into public.event_catalogue as ec
    (id, number, title, category, mode, realm, tagline, about, event_date, venue,
     team_size, entry_type, max_team_members, max_size, max_registrations,
     registration_closes_on, payment_mode, team_formed_offsite, team_form_url,
     status, accent, sigil, link_key, sort_order, is_active, updated_by)
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
     v_closes,
     v_pay_mode,
     v_offsite,
     v_team_url,
     coalesce(nullif(trim(p_event ->> 'status'), ''), 'REGISTRATION OPEN'),
     nullif(trim(coalesce(p_event ->> 'accent', '')), ''),
     nullif(trim(coalesce(p_event ->> 'sigil', '')), ''),
     nullif(trim(coalesce(p_event ->> 'link_key', '')), ''),
     coalesce(nullif(trim(p_event ->> 'sort_order', ''), '')::int, 0),
     coalesce((p_event ->> 'is_active')::boolean, true),
     (select s.username from public.staff_session() s))
  -- OMITTING a field no longer blanks it. Every SET clause below is guarded on
  -- `p_event ? 'key'`, which is the end of a bug that ran for the whole life of
  -- this function: the form read event_date, venue, team_size and status into
  -- its state and sent them back, but had no INPUTS for them, so editing a
  -- title silently blanked the date. A client that sends a partial update - an
  -- old console tab, a script, anything - cannot destroy fields it never
  -- mentioned.
  on conflict (id) do update
     set number             = case when p_event ? 'number' then excluded.number else ec.number end,
         title              = case when p_event ? 'title' then excluded.title else ec.title end,
         category           = case when p_event ? 'category' then excluded.category else ec.category end,
         mode               = case when p_event ? 'mode' then excluded.mode else ec.mode end,
         realm              = case when p_event ? 'realm' then excluded.realm else ec.realm end,
         tagline            = case when p_event ? 'tagline' then excluded.tagline else ec.tagline end,
         about              = case when p_event ? 'about' then excluded.about else ec.about end,
         event_date         = case when p_event ? 'event_date' then excluded.event_date else ec.event_date end,
         venue              = case when p_event ? 'venue' then excluded.venue else ec.venue end,
         team_size          = case when p_event ? 'team_size' then excluded.team_size else ec.team_size end,
         entry_type         = excluded.entry_type,
         max_team_members   = excluded.max_team_members,
         max_size           = excluded.max_size,
         max_registrations  = case when p_event ? 'max_registrations' then excluded.max_registrations else ec.max_registrations end,
         registration_closes_on = case when p_event ? 'registration_closes_on' then excluded.registration_closes_on else ec.registration_closes_on end,
         payment_mode       = excluded.payment_mode,
         team_formed_offsite = excluded.team_formed_offsite,
         team_form_url      = case when p_event ? 'team_form_url' then excluded.team_form_url else ec.team_form_url end,
         status             = case when p_event ? 'status' then excluded.status else ec.status end,
         accent             = case when p_event ? 'accent' then excluded.accent else ec.accent end,
         sigil              = case when p_event ? 'sigil' then excluded.sigil else ec.sigil end,
         link_key           = case when p_event ? 'link_key' then excluded.link_key else ec.link_key end,
         sort_order         = case when p_event ? 'sort_order' then excluded.sort_order else ec.sort_order end,
         is_active          = case when p_event ? 'is_active' then excluded.is_active else ec.is_active end,
         updated_at         = now(),
         updated_by         = excluded.updated_by;

-- Lowering a cap below the number already registered is ALLOWED on purpose
  -- (see ...016 and ...028): it is a real operational change, nobody is evicted,
  -- and refusing to record it leaves the organiser unable to describe what is
  -- actually happening. Setting a deadline in the PAST is the same kind of act
  -- - it closes the event now - and is likewise allowed, because an operator
  -- closing registration on a deadline they have just written is the point.

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

  -- entry_type, the cap, who pays, WHY, and UNTIL WHEN are all in the audit
  -- payload: "who may enter this, how many, does someone else handle the team,
  -- and by which date" is exactly the change an operations lead would have to
  -- explain later.
  perform public.staff_audit(
    case when v_new then 'create_event' else 'update_event' end,
    'event', v_id,
    jsonb_build_object('title', v_title, 'realm', v_realm,
                       'entry_type', v_entry, 'max_team_members', v_cap,
                       'max_registrations', v_seats,
                       'registration_closes_on', v_closes,
                       'team_formed_offsite', v_offsite,
                       'payment_mode', v_pay_mode,
                       'price', case when v_price is null then null
                                     else v_price::integer end,
                       'registered', public.event_registered_count(v_id)));

  return jsonb_build_object('ok', true, 'id', v_id, 'entry_type', v_entry,
                            'max_team_members', v_cap, 'max_registrations', v_seats,
                            'registration_closes_on', v_closes,
                            'team_formed_offsite', v_offsite,
                            'payment_mode', v_pay_mode);
end;
$$;

comment on function public.staff_upsert_event(jsonb) is
  'Master only. One save that owns every fact about an event: title, prose, date, venue, who may enter, how many, the registration limit, the last day registration closes, the price, and whether the team is formed on another website. payment_mode is DERIVED from entry_type and team_formed_offsite and is not read from the client. registration_closes_on is validated as a real calendar date here, so a malformed value is refused with a sentence rather than a bare 22007 from the column.';

revoke execute on function public.staff_upsert_event(jsonb) from public;
grant  execute on function public.staff_upsert_event(jsonb) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. the two catalogue reads
-- ---------------------------------------------------------------------------
-- BOTH carry registration_closes_on, and the reason they differ is the one
-- migration ...033 drew: a deadline is something a participant MUST know before
-- registering - it is the whole point of the feature, and hiding it would only
-- make the refusal a surprise - so public_catalogue sends it. The seat COUNT
-- stays out of the public read, because that is the organiser's information and
-- not the visitor's. One is a rule the participant is bound by; the other is a
-- fact about other people.

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
               'registration_closes_on', ec.registration_closes_on,
               'payment_mode', ec.payment_mode,
               'team_formed_offsite', ec.team_formed_offsite,
               'team_form_url', ec.team_form_url,
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

comment on function public.public_catalogue() is
  'Active events and bundles carrying every field the PUBLIC site renders - price, entry rule, who pays, whether the team is formed elsewhere, date, venue, and the last day registration closes. Registration COUNTS are deliberately absent: they are an operations figure, read by staff_list_catalogue() and staff_list_event_registrations(), not published here. A deadline is the opposite case - it is a rule the participant is bound by, so it is public.';

create or replace function public.staff_list_catalogue ()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- The Catalogue tab is gated on manage_catalogue, which only a master holds,
  -- so this matches. An admin who cannot open the tab has no reason to read the
  -- table behind it either.
  if not public.staff_at_least('master') then
    return jsonb_build_object('ok', false,
      'error', 'Only a master administrator can read the full catalogue.');
  end if;

  return jsonb_build_object(
    'ok', true,
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
               'registration_closes_on', ec.registration_closes_on,
               'registered_count', public.event_registered_count(ec.id),
               'payment_mode', ec.payment_mode,
               'team_form_url', ec.team_form_url,
               'price', (select pr.price from public.pricing pr
                          where pr.kind = 'event' and pr.ref_id = ec.id
                            and pr.entry_type = ec.entry_type and pr.is_active),
               'status', ec.status, 'accent', ec.accent, 'sigil', ec.sigil,
               'link_key', ec.link_key, 'sort_order', ec.sort_order,
               -- The reason this function exists at all.
               'is_active', ec.is_active
             ) order by ec.is_active desc, ec.sort_order, ec.id)
        from public.event_catalogue ec
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
               ), '[]'::jsonb),
               'is_active', bc.is_active
             ) order by bc.is_active desc, bc.sort_order, bc.id)
        from public.bundle_catalogue bc
    ), '[]'::jsonb)
  );
end;
$$;

comment on function public.staff_list_catalogue() is
  'Master-only. The whole catalogue INCLUDING retired rows, in the same projection public_catalogue sends plus is_active and the live registration count. public_catalogue filters to live rows because it feeds the public site; this exists so the console can show a master what they have withdrawn instead of only what is currently for sale.';

grant  execute on function public.staff_list_catalogue() to anon, authenticated;
revoke execute on function public.staff_list_catalogue() from public;

-- ---------------------------------------------------------------------------
-- 6. how to confirm the deadline is doing its job
-- ---------------------------------------------------------------------------
-- A query an operator can run, rather than a check that fails the deploy.
--
--   SELECT id, title, registration_closes_on,
--          (now() at time zone 'Asia/Kolkata')::date > registration_closes_on AS closed
--     FROM public.event_catalogue
--    WHERE is_active AND registration_closes_on IS NOT NULL
--    ORDER BY registration_closes_on;
--
-- Expect every row's `closed` to be false unless an operator has deliberately
-- backdated one.



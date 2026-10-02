-- =============================================================================
-- NEXUS - a squad can pay as a squad without this site listing its members
-- Migration : 20260927000035_roster_collected_on_site.sql
-- Purpose   : Let an event keep ONE leader paying a squad fee while the site
--             stops asking that leader to type three strangers' names, emails,
--             roll numbers, colleges, years, departments and phone numbers.
--
-- WHY NOT team_formed_offsite
--
-- That flag already exists and looks like the obvious answer. It cannot be used,
-- because it means two different things at once (migration ...028, section 3):
--
--     payment_mode := case
--       when entry_type = 'team' and team_formed_offsite is not true
--         then 'per_team'
--       else 'per_person'
--     end;
--
-- Setting it on FREE FIRE would stop the roster AND flip payment_mode to
-- per_person - turning a Rs 300 SQUAD fee into a Rs 300 PER-HEAD fee, so a
-- squad of four is quoted Rs 1,200. That is a money bug, introduced by a change
-- whose stated purpose was data collection.
--
-- So the two facts are separated, because they really are two facts:
--
--   team_formed_offsite      WHERE the squad is assembled, and therefore who
--                            pays. Offsite means each member settles their own
--                            seat wherever they are entered.
--   roster_collected_on_site WHETHER this site lists the members. Off-the-roster
--                            can still be one leader paying one squad fee.
--
-- ...028's own header argues for exactly this split - "the requirement is a
-- statement about what a TEAM EVENT IS" and a trigger keyed on a category would
-- be "a product decision hiding inside the schema". Reusing its flag for a
-- second purpose would be that same mistake, and would re-couple the two the
-- next time either rule changes.
--
-- WHERE IT IS DECIDED
--
-- registration_team_cap (migration ...029). That is already the single function
-- both the wizard and trg_registration_members_cap ask, and returning NULL for
-- it is already how "no roster" is expressed - so one added predicate removes
-- the step from the browser AND refuses the write, with no second mechanism.
--
-- DEFAULT TRUE, AND WHY THAT IS THE SAFE DIRECTION
--
-- Every existing row keeps collecting a roster, so applying this changes FREE
-- FIRE and nothing else. The opposite default would silently strip the teammate
-- step from every team event on the site at the moment of deploy, which is the
-- kind of surprise that loses a squad its registration.
--
-- Idempotent: add-column-if-not-exists, create-or-replace.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. the fact
-- ---------------------------------------------------------------------------

alter table public.event_catalogue
  add column if not exists roster_collected_on_site boolean;

-- Backfill rather than a NOT NULL DEFAULT: every row that predates this column
-- gets TRUE explicitly, so "collects a roster" is never NULL and never has to be
-- special-cased by a reader. A bare default would leave older rows reading NULL,
-- and `where roster_collected_on_site` would then silently EXCLUDE them.
update public.event_catalogue
   set roster_collected_on_site = true
 where roster_collected_on_site is null;

alter table public.event_catalogue
  alter column roster_collected_on_site set default true;

alter table public.event_catalogue
  alter column roster_collected_on_site set not null;

comment on column public.event_catalogue.roster_collected_on_site is
  'TRUE when a leader entering this event must list their teammates on THIS site (name, email, roll number, college, year, department, phone). FALSE when the squad is assembled elsewhere and this site never needs to know who is in it - FREE FIRE, where one leader still pays a single squad fee but the squad is formed in game. INDEPENDENT of team_formed_offsite, which decides who PAYS rather than what is COLLECTED: an offsite team is also never listed here. NULL is impossible.';

-- ---------------------------------------------------------------------------
-- 2. FREE FIRE, marked
-- ---------------------------------------------------------------------------
-- The one event this migration exists for. Named by id rather than by category
-- for the reason ...028's header gives: keying a rule on `category` buries a
-- product decision in the schema, and renaming the category in the console would
-- silently change what data is collected. An operator who wants another event
-- to behave this way ticks the box in the console, like every other fact here.
--
-- Only per_team rows can be affected. A per_person event already collects no
-- roster, so flipping one would be a no-op dressed as a change.

update public.event_catalogue
   set roster_collected_on_site = false
 where id = 'free-fire'
   and entry_type = 'team'
   and payment_mode = 'per_team'
   and roster_collected_on_site is distinct from false;

-- ---------------------------------------------------------------------------
-- 3. the one place "does this purchase collect a roster?" is answered
-- ---------------------------------------------------------------------------
-- Recreated whole rather than altered, because its WHERE clause is the rule.
-- Adding `roster_collected_on_site` here is the entire enforcement change: the
-- wizard's roster step (which asks this function, through the cap) and the
-- BEFORE INSERT trigger both stop at the same row, so they cannot disagree.

create or replace function public.registration_team_cap (p_registration_id uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select min(ec.max_team_members)
    from (
      select ec.id, ec.max_team_members, ec.entry_type, ec.payment_mode,
             ec.roster_collected_on_site
        from public.event_catalogue ec
       where ec.id = (
               select r.purchase_ref
                 from public.registrations r
                where r.id = p_registration_id
                  and r.purchase_type = 'event')
       union all
       select ec.id, ec.max_team_members, ec.entry_type, ec.payment_mode,
              ec.roster_collected_on_site
         from public.registration_events re
         join public.event_catalogue ec on ec.id = re.event_id
        where re.registration_id = p_registration_id
    ) ec
   where ec.entry_type = 'team'
     and ec.payment_mode = 'per_team'
     -- The new rule. Everything above it is unchanged, so an event nobody has
     -- touched keeps exactly the cap it had.
     and ec.roster_collected_on_site is true
     and ec.max_team_members is not null;
$$;

comment on function public.registration_team_cap(uuid) is
  'How many people this registration''s team may contain, INCLUDING the leader - so a cap of 3 allows the leader and two teammates. The minimum cap across the team-formed-here events the purchase covers. NULL when the purchase collects no roster: every individual event, a team formed offsite (each member pays their own seat elsewhere), and a squad this site does not list (roster_collected_on_site = false, which is FREE FIRE - one leader still pays the squad fee, the squad is simply assembled in game). The caller refuses a roster rather than inventing a cap of 50.';

revoke execute on function public.registration_team_cap(uuid) from public;
grant  execute on function public.registration_team_cap(uuid) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. the two refusals stop guessing WHY there is no roster
-- ---------------------------------------------------------------------------
-- Both messages ended with "Each participant registers and pays separately",
-- which was true of the hackathon and is FALSE for FREE FIRE: there the leader
-- pays for everybody and the squad is simply not listed here. A participant
-- reading a reason that does not match their own event would rightly stop
-- trusting the message - and would have no idea their leader should have been
-- able to skip the step.

create or replace function public.enforce_team_size_cap ()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_cap   integer;
  v_after integer;
begin
  v_cap := public.registration_team_cap(new.registration_id);

  if v_cap is null then
    raise exception
      'This event''s squad is not listed on NEXUS, so there are no teammates to add here.'
      using errcode = '23514';
  end if;

  /* The size this row WOULD make the team, not the size it is now. This is the
     off-by-one that matters: the count below sees only the members already
     stored, so the team is `existing` members plus the leader, and the row being
     inserted is a further one on top. Both have to be added - `existing + 2` -
     before comparing against a cap that counts PEOPLE.
     Getting it wrong by one here is silent and forgiving in the wrong
     direction: every team ends up allowed one person over its stated cap, and
     the operations team discovers it at the venue. */
  v_after := (select count(*)::integer
                from public.registration_members rm
               where rm.registration_id = new.registration_id)
           + 2;  -- the row being inserted, plus the leader who is the registration

  if v_after > v_cap then
    raise exception
      'This team already has % of a maximum % people (the leader counts). Remove someone before adding another.', v_after, v_cap
      using errcode = '23514';
  end if;

  return new;
end;
$$;

comment on function public.enforce_team_size_cap() is
  'BEFORE INSERT OR UPDATE on registration_members. Refuses a member that would take the team past the event''s max_team_members, counting the leader as one of them, and refuses any member at all for an event that collects no roster. Lives on the table rather than inside the RPC because registration_members is directly insertable by a participant under RLS, so a check in a function would be bypassable.';

drop trigger if exists trg_registration_members_cap on public.registration_members;

create trigger trg_registration_members_cap
  before insert or update on public.registration_members
  for each row
  execute function public.enforce_team_size_cap();

-- ---------------------------------------------------------------------------
-- 5. the wizard's own refusal says the same thing
-- ---------------------------------------------------------------------------
-- Recreated VERBATIM from ...029 except for one line: the message. This is the
-- participant-facing copy of the same refusal the trigger in section 4 raises,
-- and the two disagreed - this one explained the absence in terms of payment,
-- which is not why FREE FIRE has no roster. Nothing else is touched: the
-- per-row insert, the returned `members` (teammates, NOT people) alongside
-- `team_size` (people), and the leader self-reference all stay as they were,
-- because callers already read those keys.

create or replace function public.registration_set_team_members (
  p_registration_id uuid,
  p_team_name       text,
  p_members         jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reg     public.registrations%rowtype;
  v_cap     integer;
  v_name    text;
  v_m       jsonb;
  v_fields  text[];
  v_missing text;
  v_i       integer;
  v_count   integer;
  v_seen    text[] := '{}';
  v_email   text;
begin
  select * into v_reg from public.registrations r where r.id = p_registration_id;
  if not found then
    raise exception 'That registration could not be found.' using errcode = 'P0002';
  end if;

  -- Own row only. RLS would refuse the table writes too, but saying so here
  -- turns a silent empty update into a sentence.
  if v_reg.user_id is distinct from auth.uid() then
    raise exception 'That registration is not yours.' using errcode = '42501';
  end if;

  if v_reg.selection_frozen or v_reg.payment_status = 'verified' then
    raise exception
      'This team is final - contact the operations team to change it.'
      using errcode = '42501';
  end if;

  v_cap := public.registration_team_cap(p_registration_id);
  if v_cap is null then
    -- THE ONE LINE THAT CHANGED. It no longer claims each participant pays
    -- separately: that is true of an offsite team and false of a squad this
    -- site simply does not list.
    raise exception
      'This event''s squad is not listed on NEXUS, so there is no teammate list to fill in.'
      using errcode = '22023';
  end if;

-- The name, held to the same rule as the column CHECK and reported as a
  -- sentence rather than a raw 23514.
  v_name := nullif(btrim(coalesce(p_team_name, '')), '');
  if v_name is null or char_length(v_name) not between 2 and 60 then
    raise exception
      'Give the team a name of 2 to 60 characters.' using errcode = '22023';
  end if;

  if p_members is null or jsonb_typeof(p_members) <> 'array' then
    raise exception 'The teammate list is not a list.' using errcode = '22023';
  end if;

  v_count := jsonb_array_length(p_members);
  -- Checked here AND by the trigger. The check here gives the leader one clear
  -- sentence before anything is written; the trigger is what actually stops a
  -- bypass.
  if v_count + 1 > v_cap then
    raise exception
      'A team may have at most % people and the leader counts as one, so you can add %.', v_cap, v_cap - 1
      using errcode = '22023';
  end if;


  update public.registrations r
     set team_name = v_name, updated_at = now()
   where r.id = p_registration_id;

  delete from public.registration_members rm where rm.registration_id = p_registration_id;

  for v_i in 0 .. v_count - 1 loop
    v_m := p_members -> v_i;

    v_fields := array['name', 'roll_number', 'email', 'college_name',
                      'year', 'department'];
    select string_agg(f, ', ')
      into v_missing
      from unnest(v_fields) f
     where nullif(btrim(coalesce(v_m ->> f, '')), '') is null;

    if v_missing is not null then
      raise exception
        'Teammate % is missing: %', v_i + 1, v_missing
        using errcode = '22023';
    end if;

    v_email := lower(btrim(v_m ->> 'email'));

    -- The same person typed twice is a mistake worth naming. There is no unique
    -- index that would catch it, because a member email is deliberately NOT
    -- unique ACROSS teams - the same student may sit on two different teams.
    if v_email = any (v_seen) then
      raise exception
        '% appears twice in the teammate list.', v_email
        using errcode = '22023';
    end if;
    v_seen := array_append(v_seen, v_email);

    -- The leader is not a teammate of themselves.
    if v_email = lower(btrim(v_reg.email)) then
      raise exception
        'That is your own email - you are the leader, so list only the others.'
        using errcode = '22023';
    end if;

    insert into public.registration_members
      (registration_id, position, name, email, roll_number,
       college_name, year, department, phone_number)
    values
      (p_registration_id, v_i + 1,
       btrim(v_m ->> 'name'), v_email, btrim(v_m ->> 'roll_number'),
       btrim(v_m ->> 'college_name'), v_m ->> 'year', btrim(v_m ->> 'department'),
       nullif(btrim(coalesce(v_m ->> 'phone_number', '')), ''));
  end loop;

  return jsonb_build_object(
    'ok', true,
    'team_name', v_name,
    'members', v_count,
    -- What the LEADER sees: the team is everyone, and the leader is one of them.
    'team_size', v_count + 1,
    'max_team_members', v_cap);
end;
$$;

comment on function public.registration_set_team_members(uuid, text, jsonb) is
  'Replaces a registration''s whole teammate list and its team name in one atomic save. The browser supplies member FACTS only: the count, the positions, the cap and the team size are all read from the catalogue, and trg_registration_members_cap refuses an over-cap roster whatever this function is asked to do. Refused once the selection is frozen or the payment is verified, and refused outright for an event that collects no roster - every individual event, a team formed offsite, and FREE FIRE, whose squad is assembled in game.';

grant  execute on function public.registration_set_team_members(uuid, text, jsonb) to authenticated;
revoke execute on function public.registration_set_team_members(uuid, text, jsonb) from anon, public;

-- ---------------------------------------------------------------------------
-- 6. the console's save carries the fact
-- ---------------------------------------------------------------------------
-- Recreated from ...034 (which recreated ...028), plus two lines. The flag is
-- read BY PRESENCE like every other optional field here, so the form's unticked
-- box means false and a partial update from an old console tab cannot clear it.
--
-- What is deliberately NOT changed: the payment_mode derivation. FREE FIRE is
-- still per_team and still pays Rs 300 for the squad - that is the whole point
-- of separating this from team_formed_offsite.

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
  v_roster    boolean;
  v_pay_mode  text;
  -- What the row already says, for the fields a client may have left out.
  v_prev_entry   text;
  v_prev_cap     integer;
  v_prev_offsite boolean;
  v_prev_roster  boolean;
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
  select ec.entry_type, ec.max_team_members, ec.team_formed_offsite,
         ec.roster_collected_on_site
    into v_prev_entry, v_prev_cap, v_prev_offsite, v_prev_roster
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

  -- Same rule for the roster. An individual event collects no roster whatever
  -- this says, so the flag is forced TRUE there rather than trusted - otherwise
  -- an operator could tick it off an individual event and read nothing, with no
  -- way to tell the difference between "no roster because it is solo" and "no
  -- roster because I asked for none".
  if p_event ? 'roster_collected_on_site' then
    v_roster := coalesce((p_event ->> 'roster_collected_on_site')::boolean, true);
  else
    v_roster := coalesce(v_prev_roster, true);
  end if;
  if v_entry = 'individual' then
    v_roster := true;
  end if;

-- DERIVED, never read from the client. A team pays as a team; a team formed
  -- elsewhere charges per member; an individual is always per person.
  --
  -- UNCHANGED BY THIS MIGRATION, and that is the point: roster_collected_on_site
  -- takes no part in it. A squad this site does not list still pays as a squad.
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
     registration_closes_on, payment_mode, team_formed_offsite,
     roster_collected_on_site, team_form_url,
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
     v_roster,
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
         roster_collected_on_site = case when p_event ? 'roster_collected_on_site' then excluded.roster_collected_on_site else ec.roster_collected_on_site end,
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
  -- actually happening.

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

  -- The audit carries what is COLLECTED as well as who pays, because turning a
  -- roster off stops this site holding three people's personal details - which is
  -- exactly the kind of change an operations lead would have to justify later.
  perform public.staff_audit(
    case when v_new then 'create_event' else 'update_event' end,
    'event', v_id,
    jsonb_build_object('title', v_title, 'realm', v_realm,
                       'entry_type', v_entry, 'max_team_members', v_cap,
                       'max_registrations', v_seats,
                       'registration_closes_on', v_closes,
                       'team_formed_offsite', v_offsite,
                       'roster_collected_on_site', v_roster,
                       'payment_mode', v_pay_mode,
                       'price', case when v_price is null then null
                                     else v_price::integer end,
                       'registered', public.event_registered_count(v_id)));

  return jsonb_build_object('ok', true, 'id', v_id, 'entry_type', v_entry,
                            'max_team_members', v_cap, 'max_registrations', v_seats,
                            'registration_closes_on', v_closes,
                            'team_formed_offsite', v_offsite,
                            'roster_collected_on_site', v_roster,
                            'payment_mode', v_pay_mode);
end;
$$;

comment on function public.staff_upsert_event(jsonb) is
  'Master only. One save that owns every fact about an event: title, prose, date, venue, who may enter, how many, the registration limit, the last day registration closes, whether the team is formed elsewhere, WHETHER THIS SITE LISTS THE TEAM, the price, and who pays. payment_mode is DERIVED from entry_type and team_formed_offsite and is not read from the client - roster_collected_on_site deliberately takes no part in it, so a squad this site does not list still pays one squad fee.';

revoke execute on function public.staff_upsert_event(jsonb) from public;
grant  execute on function public.staff_upsert_event(jsonb) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 7. both catalogue reads carry the fact
-- ---------------------------------------------------------------------------
-- public_catalogue MUST carry it, which is the opposite of the registered_count
-- decision in migration ...033. The count is a fact about OTHER PEOPLE and stays
-- with staff; this is a fact about WHAT THE PARTICIPANT WILL BE ASKED, and the
-- wizard cannot render the right number of steps without it. Sending one more
-- boolean is not a leak.

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
               'roster_collected_on_site', ec.roster_collected_on_site,
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
  'Active events and bundles carrying every field the PUBLIC site renders - price, entry rule, who pays, whether the team is formed elsewhere, whether this site lists the team, the last day registration closes. Registration COUNTS are deliberately absent: they are an operations figure for staff_list_catalogue() and staff_list_event_registrations(), not published here. A deadline and a roster rule are the opposite case - they are rules the participant is bound by, so they are public.';

create or replace function public.staff_list_catalogue ()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
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
               'roster_collected_on_site', ec.roster_collected_on_site,
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
  'Master-only. The whole catalogue INCLUDING retired rows, in the same projection public_catalogue sends plus is_active and the live registration count, so a master can see and change the roster rule for any event.';

grant  execute on function public.staff_list_catalogue() to anon, authenticated;
revoke execute on function public.staff_list_catalogue() from public;

-- ---------------------------------------------------------------------------
-- 8. how to confirm it landed
-- ---------------------------------------------------------------------------
-- FREE FIRE should be the only row reading false, and its payment_mode should
-- still be per_team - if that column says per_person, something has re-coupled
-- the two facts and the squad fee is now per head.
--
--   SELECT id, title, entry_type, payment_mode, max_team_members,
--          roster_collected_on_site
--     FROM public.event_catalogue
--    WHERE entry_type = 'team'
--    ORDER BY roster_collected_on_site, id;



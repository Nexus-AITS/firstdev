-- =============================================================================
-- NEXUS - a team event is paid for by the team, and the hackathon is the
--          documented exception
-- Migration : 20260927000028_team_payment_rule.sql
-- Purpose   : Stop "who pays" being a CHOICE. A team event is now paid for by
--             the team, always, unless it is explicitly marked as forming teams
--             somewhere else - which is the hackathon, and only the hackathon.
--
-- WHAT WAS WRONG
--
-- payment_mode was a free choice in the console with two options, and the data
-- happened to be right: every team event read per_team except NEXUS BREACH,
-- which read per_person. Nothing held it there. An operator picking "each
-- person" for a squad event would save it without an argument, the card would
-- keep saying TEAM, and the money would be wrong. A rule that survives only
-- because nobody has yet broken it is not a rule.
--
-- The requirement is a statement about what a TEAM EVENT IS, not a setting: if
-- a team enters, the team pays. The one exception is a real one - the hackathon
-- charges every participant individually and hands team formation to a separate
-- site, so its leader is NOT paying for anybody.
--
-- WHY AN EXPLICIT FLAG AND NOT A HARD-CODED CATEGORY CHECK
--
-- A trigger that keyed on `category = 'HACKATHON'` would be a product decision
-- hiding inside the schema: rename the category in the console and the payment
-- rule silently changes. `team_formed_offsite` says the actual FACT - "the team
-- is formed on another website" - and the payment rule follows from that fact.
-- The hackathon is seeded as offsite; the column carries the meaning.
--
-- WHY A TRIGGER AS WELL AS THE RPC
--
-- Because staff_upsert_event is not the only writer and, more importantly, not
-- the only FUTURE writer. event_catalogue has no INSERT policy for anon, so the
-- RPC is the console's route today - but the derived value lives in a BEFORE
-- trigger so that any other path (a data fix, a future bulk import, a
-- superuser) produces the same answer. Same argument as ...025 and ...016: a
-- check inside one function is a suggestion about one function.
--
-- Idempotent: add-column-if-not-exists, create-or-replace, drop-trigger-if-
-- exists, and the backfill only touches rows that are not already marked.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. the fact
-- ---------------------------------------------------------------------------

alter table public.event_catalogue
  add column if not exists team_formed_offsite boolean not null default false;

comment on column public.event_catalogue.team_formed_offsite is
  'TRUE when this event''s team is formed on ANOTHER website, so the leader is not paying for the squad and this site never needs to know the members. That is the hackathon: every participant pays their own fee and teams are assembled elsewhere. FALSE (the default) means the team enters and pays together HERE, and the leader lists the members on the registration form. payment_mode is derived from this and entry_type - it is not chosen.';

-- ---------------------------------------------------------------------------
-- 2. the hackathon, marked
-- ---------------------------------------------------------------------------
-- Seeded from the category because that is how the site already identifies it:
-- bundles.js picks its fixed seat with
-- `events.find((e) => e.category === "HACKATHON")` and EventSelection.jsx
-- excludes the pool member with the same test. Matching on the same word keeps
-- one definition of "the hackathon" rather than three.
--
-- Case-insensitively, because this column is free text typed by an operator
-- into a text box and "hackathon" must not be a different event from
-- "HACKATHON". Only rows not already set are touched, so an operator who has
-- deliberately overridden one is not undone by a re-run.

update public.event_catalogue
   set team_formed_offsite = true
 where upper(btrim(coalesce(category, ''))) = 'HACKATHON'
   and team_formed_offsite is distinct from true;

-- ---------------------------------------------------------------------------
-- 3. the rule
-- ---------------------------------------------------------------------------

create or replace function public.event_catalogue_derive_payment_mode ()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Individual is always per person; there is no team to pay for.
  -- A team pays as a team unless its formation happens elsewhere, in which case
  -- each member settles their own seat wherever they are entered.
  new.payment_mode := case
    when new.entry_type = 'team' and new.team_formed_offsite is not true
      then 'per_team'
    else 'per_person'
  end;
  return new;
end;
$$;

comment on function public.event_catalogue_derive_payment_mode() is
  'BEFORE INSERT OR UPDATE on event_catalogue. Derives payment_mode from entry_type and team_formed_offsite so it can never be set to something those two do not imply. A team pays as a team; a team formed on another website charges each member separately, because its leader is not paying for anybody.';

drop trigger if exists trg_event_catalogue_payment_mode on public.event_catalogue;

create trigger trg_event_catalogue_payment_mode
  before insert or update on public.event_catalogue
  for each row
  execute function public.event_catalogue_derive_payment_mode();

-- ---------------------------------------------------------------------------
-- 4. the console's save
-- ---------------------------------------------------------------------------
-- The fifth rewrite of this function (...015 the price, ...016 the cap, ...017
-- the payment mode, this the fact that derives it) and the version that RUNS:
-- migrations apply in order, so anything changed in the three before has to be
-- mirrored here or this copy silently wins.
--
-- WHAT CHANGED, PRECISELY
--
--   * payment_mode is no longer READ from the client. It is computed from
--     entry_type and team_formed_offsite. A console that still sends
--     `payment_mode` is ignored on that key, so an open admin tab running
--     yesterday's JavaScript cannot set the wrong thing.
--   * team_formed_offsite IS read, with the same presence-guard as every other
--     optional field, so a partial update cannot clear it.
--
-- The trigger in section 3 recomputes payment_mode afterwards anyway. Two
-- mechanisms, deliberately: the function makes the returned value and the audit
-- entry true at the moment of writing, and the trigger means a writer that is
-- not this function still cannot produce an impossible pair.

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
  v_team_url  text := nullif(trim(coalesce(p_event ->> 'team_form_url', '')), '');
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

  -- Read the current row BEFORE resolving anything. This is what makes a partial
  -- update safe, and it is not a detail: an earlier draft of this migration
  -- defaulted an omitted entry_type to 'individual', so a client that changed
  -- only an event's TITLE silently turned a squad event into a solo one. Both
  -- that and the flag below are money bugs, and both were invisible until a
  -- partial update was actually run against a database.
  select ec.entry_type, ec.max_team_members, ec.team_formed_offsite
    into v_prev_entry, v_prev_cap, v_prev_offsite
    from public.event_catalogue ec
   where ec.id = v_id;
  v_exists := found;

  -- Precedence: what the client said, then what the row already says, then the
  -- legacy packed max_size, then the safe default. A client that predates this
  -- migration sends only max_size, and a genuinely new event has neither.
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
    -- Falling back to the row's own cap is what keeps a partial update from
    -- wiping the squad size, which would then fail chk_event_catalogue_team_cap
    -- and make the event unsaveable.
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
  -- elsewhere charges per member, because its leader is not paying for anybody;
  -- an individual is always per person. The trigger recomputes this for every
  -- writer, so the pair on the row is impossible to get wrong either way.
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
     payment_mode, team_formed_offsite, team_form_url, status, accent, sigil,
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
     case when v_entry = 'team' then v_cap::text else 'individual' end,
     v_seats,
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
  -- OMITTING a field no longer blanks it.
  --
  -- Every one of these SET clauses is guarded on `p_event ? 'key'`, and that is
  -- the end of a bug that ran for the whole life of this function: the console
  -- form read event_date, venue, team_size and status into its state and sent
  -- them back, but the form had no INPUTS for them, so an operator editing an
  -- event's title silently blanked its date and venue. Adding the inputs hides
  -- the symptom; this removes the cause, so a client that sends a partial update
  -- - an old console tab, a script, anything - cannot destroy fields it never
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
  -- (see ...016). Switching an event from per_person to per_team after people
  -- have already paid individually is allowed for the same reason: it is a real
  -- operational change, and refusing to record it leaves the organiser unable to
  -- describe what is actually happening. Nobody is evicted; the next
  -- registration is simply priced for a squad.

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

  -- entry_type, the cap, who pays and WHY are all in the audit payload: "who may
  -- enter this, how many, and does someone else handle the team" is exactly the
  -- change an operations lead would have to explain later.
  perform public.staff_audit(
    case when v_new then 'create_event' else 'update_event' end,
    'event', v_id,
    jsonb_build_object('title', v_title, 'realm', v_realm,
                       'entry_type', v_entry, 'max_team_members', v_cap,
                       'max_registrations', v_seats,
                       'team_formed_offsite', v_offsite,
                       'payment_mode', v_pay_mode,
                       'price', case when v_price is null then null
                                     else v_price::integer end,
                       'registered', public.event_registered_count(v_id)));

  return jsonb_build_object('ok', true, 'id', v_id, 'entry_type', v_entry,
                            'max_team_members', v_cap, 'max_registrations', v_seats,
                            'team_formed_offsite', v_offsite,
                            'payment_mode', v_pay_mode);
end;
$$;

comment on function public.staff_upsert_event(jsonb) is
  'Master only. One save that owns every fact about an event: title, prose, date, venue, who may enter, how many, the registration limit, the price, and whether the team is formed on another website. payment_mode is DERIVED from entry_type and team_formed_offsite and is not read from the client, so a stale console cannot set a team event to charge per person.';

revoke execute on function public.staff_upsert_event(jsonb) from public;
grant  execute on function public.staff_upsert_event(jsonb) to anon, authenticated;


-- ---------------------------------------------------------------------------
-- 5. the public read
-- ---------------------------------------------------------------------------
-- team_formed_offsite joins the row the pages already read, so the wizard asks
-- "does this leader need to list their teammates?" from the catalogue rather
-- than hardcoding which events are team-on-this-site. Same one-response rule as
-- every other field public_catalogue carries: a card must never be assembled
-- from a fresh catalogue and a stale rule.

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
  'Active events and bundles carrying every field the public site renders - price, entry rule, who pays, whether the team is formed elsewhere, live registration count, date, venue - in one response. The single source the console edits and the pages read, so the two cannot disagree. Public by design: it returns nothing that is not already on the public site.';


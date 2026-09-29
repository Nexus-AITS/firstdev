-- =============================================================================
-- NEXUS - who pays: per person, or one leader for the whole team
-- Migration : 20260927000017_payment_mode_and_team_link.sql
-- Purpose   : Record HOW an event is paid for, which is not the same question as
--             how it is entered (...014), and carry the link a paid participant
--             follows to form a team elsewhere.
--
-- WHY THIS EXISTS
--
-- entry_type says WHO may enter. It says nothing about WHO PAYS, and for this
-- event those are genuinely different questions:
--
--   NEXUS BREACH (hackathon)  team, up to 5. Every participant pays their own
--                             fee. Once paid and approved, they are sent to the
--                             hackathon site to form a team there. The team
--                             exists; it just does not exist HERE, and the
--                             database never needs to know its members.
--
--   FREE FIRE (esports)       a squad, 5-6 players, ONE payment of Rs 300 made
--                             by the leader on the squad's behalf. Only the
--                             leader's in-game ID is collected, because the
--                             leader IS how the squad is identified and entered.
--
-- So payment_mode is per_person or per_team, defaulting to per_person because
-- that is the rule and esports is the exception. Without the field the only way
-- to express "Rs 300 covers five people" is to divide it by five somewhere in
-- the UI, and then the arithmetic and the copy drift apart.
--
-- WHY NO MINIMUM IS ENFORCED
--
-- A per_team event must carry a cap - "Rs 300 for the squad" is meaningless
-- without knowing how big the squad is - so that is checked. A MINIMUM is not
-- checked, because a per_person team event genuinely may be entered by one
-- person ("1 - 5 MEMBERS" is three of the eleven events). The cap is an upper
-- bound and nothing more.
--
-- WHY team_form_url IS A COLUMN AND NOT A CONSTANT
--
-- The hackathon participants are sent somewhere else to form a team, and where
-- that is changes. Compiling it into a JS constant would mean a redeploy to
-- change a link, and would make the admin console lie about being the authority
-- for the one field operators most often need to fix. Blank means "no team is
-- formed off-site", which is true of every event except the ones that need it.
--
-- Idempotent: add-column-if-not-exists, create-or-replace, drop-*-if-exists.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. the two fields
-- ---------------------------------------------------------------------------

alter table public.event_catalogue
  add column if not exists payment_mode text not null default 'per_person',
  add column if not exists team_form_url text;

alter table public.event_catalogue
  drop constraint if exists chk_event_catalogue_payment_mode;

alter table public.event_catalogue
  add constraint chk_event_catalogue_payment_mode
    check (payment_mode in ('per_person', 'per_team'));

-- A squad price without a squad size is not a rule, it is a discount of unknown
-- size. `is not null` spelled out for the same three-valued-logic reason as
-- ...016's cap: `max_team_members >= 1` is NULL, not FALSE, when the column is
-- NULL, and a CHECK rejects only FALSE.
alter table public.event_catalogue
  drop constraint if exists chk_event_catalogue_team_payment;

alter table public.event_catalogue
  add constraint chk_event_catalogue_team_payment
    check (
      payment_mode = 'per_person'
      or (max_team_members is not null and max_team_members between 1 and 50)
    );

comment on column public.event_catalogue.payment_mode is
  'Who pays. ''per_person'': every participant registers and pays their own fee, and any team is formed elsewhere afterwards. ''per_team'': one registration covers the whole squad and one leader pays once for it. Distinct from entry_type, which is about who may enter.';

comment on column public.event_catalogue.team_form_url is
  'Where a paid, approved participant goes to form a team, when that happens off this site. Blank means no off-site team step. Kept as data so changing the destination is a console edit, not a redeploy.';

-- ---------------------------------------------------------------------------
-- 2. the backfill
-- ---------------------------------------------------------------------------
-- Esports is the exception the requirement names, and the Arena holds exactly
-- one event, FREE FIRE, which is a squad game. Keyed on realm AND entry_type
-- rather than realm alone, so a future solo title dropped into the Arena is not
-- silently switched to per-team payment because of where it sits.

update public.event_catalogue
   set payment_mode = case when realm = 'arena' and entry_type = 'team'
                          then 'per_team' else 'per_person' end
 where payment_mode is distinct from
       (case when realm = 'arena' and entry_type = 'team'
             then 'per_team' else 'per_person' end);

-- ---------------------------------------------------------------------------
-- 3. staff_upsert_event, now carrying the payment mode and the team link
-- ---------------------------------------------------------------------------
-- The fourth rewrite of this function (...015 added the price, ...016 the
-- registration cap, this the payment mode), and it is the version that RUNS:
-- migrations apply in order, so anything changed in ...015 or ...016 has to be
-- mirrored here or this copy silently wins. The reason it keeps growing is
-- deliberate - the console's event form is ONE save, so the call that owns an
-- event owns every fact about it, and a form that could half-succeed is worse
-- than a long function.
--
-- It also finally gives the form somewhere to PUT the four fields it has always
-- sent but never exposed: event_date, venue, team_size and status. They were
-- read into the form, sent on save, and blanked, because the inputs did not
-- exist. They are columns, and columns are editable now.

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
  v_pay_mode  text := lower(nullif(trim(coalesce(p_event ->> 'payment_mode', '')), ''));
  v_raw_cap   text := nullif(btrim(coalesce(p_event ->> 'max_team_members', '')), '');
  v_raw_max   text := nullif(btrim(coalesce(p_event ->> 'max_size', '')), '');
  v_price     text := nullif(btrim(coalesce(p_event ->> 'price', '')), '');
  v_raw_seats text := nullif(btrim(coalesce(p_event ->> 'max_registrations', '')), '');
  v_team_url  text := nullif(trim(coalesce(p_event ->> 'team_form_url', '')), '');
  -- What the row already says, for the fields a client may have left out.
  v_prev_entry text;
  v_prev_cap   integer;
  v_prev_pay   text;
  v_exists     boolean := false;
  v_seats     integer;
  v_cap       integer;
  v_new       boolean;
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
  -- defaulted an omitted entry_type to 'individual' and an omitted payment_mode
  -- to 'per_person', so a client that changed only an event's TITLE silently
  -- turned a squad event into a solo one and a per-squad price into a per-person
  -- one. Both are money bugs, and both were invisible until a partial update was
  -- actually run against a database.
  select ec.entry_type, ec.max_team_members, ec.payment_mode
    into v_prev_entry, v_prev_cap, v_prev_pay
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

  if v_pay_mode is null then
    v_pay_mode := case when v_exists then v_prev_pay else 'per_person' end;
  end if;

  if v_pay_mode not in ('per_person', 'per_team') then
    return jsonb_build_object('ok', false,
      'error', 'Choose who pays: each person, or one team leader for the whole squad.');
  end if;

  -- A squad price with no squad size is a discount of unknown size, so it is
  -- refused here with a sentence rather than left to the CHECK's raw 23514.
  if v_pay_mode = 'per_team' and v_cap is null then
    return jsonb_build_object('ok', false,
      'error', 'If one leader pays for the squad, the event needs a maximum squad size.');
  end if;

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
     payment_mode, team_form_url, status, accent, sigil, link_key, sort_order,
     is_active, updated_by)
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
     v_team_url,
     coalesce(nullif(trim(p_event ->> 'status'), ''), 'REGISTRATION OPEN'),
     nullif(trim(coalesce(p_event ->> 'accent', '')), ''),
     nullif(trim(coalesce(p_event ->> 'sigil', '')), ''),
     nullif(trim(coalesce(p_event ->> 'link_key', '')), ''),
     coalesce(nullif(trim(p_event ->> 'sort_order'), '')::int, 0),
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
  -- — an old console tab, a script, anything — cannot destroy fields it never
  -- mentioned.
  --
  -- Clearing still works, and is the reason the guard tests for PRESENCE rather
  -- than for a non-empty value: the form sends `""` for a cleared text field and
  -- null for a cleared one, and both are present keys, so both land.
  on conflict (id) do update
     set number            = case when p_event ? 'number' then excluded.number else ec.number end,
         title             = case when p_event ? 'title' then excluded.title else ec.title end,
         category          = case when p_event ? 'category' then excluded.category else ec.category end,
         mode              = case when p_event ? 'mode' then excluded.mode else ec.mode end,
         realm             = case when p_event ? 'realm' then excluded.realm else ec.realm end,
         tagline           = case when p_event ? 'tagline' then excluded.tagline else ec.tagline end,
         about             = case when p_event ? 'about' then excluded.about else ec.about end,
         event_date        = case when p_event ? 'event_date' then excluded.event_date else ec.event_date end,
         venue             = case when p_event ? 'venue' then excluded.venue else ec.venue end,
         team_size         = case when p_event ? 'team_size' then excluded.team_size else ec.team_size end,
         entry_type        = excluded.entry_type,
         max_team_members  = excluded.max_team_members,
         max_size          = excluded.max_size,
         max_registrations = case when p_event ? 'max_registrations' then excluded.max_registrations else ec.max_registrations end,
         payment_mode      = excluded.payment_mode,
         team_form_url     = case when p_event ? 'team_form_url' then excluded.team_form_url else ec.team_form_url end,
         status            = case when p_event ? 'status' then excluded.status else ec.status end,
         accent            = case when p_event ? 'accent' then excluded.accent else ec.accent end,
         sigil             = case when p_event ? 'sigil' then excluded.sigil else ec.sigil end,
         link_key          = case when p_event ? 'link_key' then excluded.link_key else ec.link_key end,
         sort_order        = case when p_event ? 'sort_order' then excluded.sort_order else ec.sort_order end,
         is_active         = case when p_event ? 'is_active' then excluded.is_active else ec.is_active end,
         updated_at        = now(),
         updated_by        = excluded.updated_by;

  -- Lowering a cap below the number already registered is ALLOWED on purpose
  -- (see ...016). Switching an event from per_person to per_team after people
  -- have already paid individually is allowed for the same reason: it is a real
  -- operational change, and refusing to record it leaves the organiser unable to
  -- describe what is actually happening. Nobody is evicted; the next registration
  -- is simply priced for a squad.

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
                       'max_registrations', v_seats, 'payment_mode', v_pay_mode,
                       'price', case when v_price is null then null
                                     else v_price::integer end,
                       'registered', public.event_registered_count(v_id)));

  return jsonb_build_object('ok', true, 'id', v_id, 'entry_type', v_entry,
                            'max_team_members', v_cap, 'max_registrations', v_seats,
                            'payment_mode', v_pay_mode);
end;
$$;

revoke execute on function public.staff_upsert_event(jsonb) from public;
grant  execute on function public.staff_upsert_event(jsonb) to anon, authenticated;


-- ---------------------------------------------------------------------------
-- 4. the public read carries everything the cards render
-- ---------------------------------------------------------------------------
-- This is the point of the whole "the backend must reflect the frontend"
-- requirement. The event pages used to render date, venue, team size and status
-- from the compiled-in events.js and nothing else, so an operator editing those
-- in the console changed the database and not the page. Every one of those
-- fields is on this object now, and src/data/catalogue.js reads them from here.
-- The JS array stays as the offline fallback and the seed, which is what it has
-- always been, and is no longer the authority for anything editable.
--
-- Supersedes the ...016 definition; migrations apply in order, so this is the
-- version that survives.

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

comment on function public.public_catalogue is
  'Active events and bundles carrying every field the public site renders - price, entry rule, who pays, live registration count, date, venue - in one response. The single source the console edits and the pages read, so the two cannot disagree. Public by design: it returns nothing that is not already on the public site.';


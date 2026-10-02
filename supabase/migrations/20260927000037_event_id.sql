-- =============================================================================
-- NEXUS - any event can require an ID, and its name is written from the title
-- Migration : 20260927000037_event_id.sql
-- Purpose   : Turn "FREE FIRE needs an in-game ID" from a hardcoded special case
--             into a per-event console setting, and label the field from the
--             event's own title so it reads "VISION 2065 ID", not "ID".
--
-- WHAT WAS WRONG, IN TWO SEPARATE WAYS
--
-- 1. THE RULE WAS ONE EVENT, WRITTEN INTO THE TRIGGER. Migration ...011 put
--    `new.purchase_ref = 'free-fire'` in a trigger. That is the mistake
--    migration ...028's own header warns about by name: "a product decision
--    hiding inside the schema: rename the category in the console and the rule
--    silently changes". The console could not ask for an ID on any other event,
--    and the only way to change that was a migration. An organiser running an
--    esports event next season had no way to collect the lobby IDs at all.
--
-- 2. THE LABEL WAS PROSE. `fields[].label` is a string in the compiled seed
--    ("Squad leader's Free Fire ID"), so the question is only ever asked for one
--    event and the name of the event is written out by hand next to it.
--
-- WHY A BOOLEAN AND NOT A FIELD LIST
--
-- The console cannot write `fields`. Carrying a whole JSON schema of custom
-- inputs would be a much larger surface, and the one thing every event that
-- needs this actually needs is the same shape: one identifier, required,
-- free text, checked at the venue. So the catalogue stores the FACT ("this
-- event collects an ID") and the page builds the field from it, taking the
-- label from the title that is already there.
--
-- WHY A NEW COLUMN AND NOT free_fire_id RENAMED
--
-- free_fire_id is referenced by staff_export_registrations (an OUT parameter),
-- the participant API and the roster card. Renaming it would mean dropping and
-- recreating all of those in one migration, for a cosmetic gain, and any
-- external consumer reading the sheet would break. So event_id_value is added
-- and backfilled, free_fire_id is left alone for the rows that already have it,
-- and readers prefer the new column and fall back to the old one.
--
-- The trigger is narrowed to purchase_type = 'event' on purpose. A BUNDLE may
-- seat an event that wants an ID, but the wizard does not collect per-event
-- fields for a bundle and never did - demanding one there would make bundle
-- registration impossible for anyone whose bundle contains such an event.
--
-- Idempotent: add-column-if-not-exists, create-or-replace, drop-trigger-if-exists.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. the fact
-- ---------------------------------------------------------------------------

alter table public.event_catalogue
  add column if not exists requires_event_id boolean;

update public.event_catalogue
   set requires_event_id = false
 where requires_event_id is null;

alter table public.event_catalogue
  alter column requires_event_id set default false;

alter table public.event_catalogue
  alter column requires_event_id set not null;

comment on column public.event_catalogue.requires_event_id is
  'TRUE when a registration for this event must carry an identifier - the in-game lobby ID for an esports event, a bib number, a handle. The registration form then asks for it and labels the field from the event''s own title ("FREE FIRE ID"). FALSE, the default, means the event asks for nothing extra. Independent of every other field here: it does not change who may enter, what anyone pays, or how many seats there are.';

/* FREE FIRE, and only FREE FIRE, is switched on - carrying over exactly the
   behaviour migration ...011 gave it and nothing more. */
update public.event_catalogue
   set requires_event_id = true
 where id = 'free-fire';

-- ---------------------------------------------------------------------------
-- 2. where the value lives
-- ---------------------------------------------------------------------------

alter table public.registrations
  add column if not exists event_id_value text;

comment on column public.registrations.event_id_value is
  'The identifier this event asks a participant for, when event_catalogue.requires_event_id is true for the event being bought - the in-game ID for FREE FIRE, and whatever else a future event needs. Required by trg_registrations_event_id. Backfilled from the older free_fire_id, which stays for the export sheet and for rows written before this migration.';

/* The one and only source of truth for existing rows. free_fire_id keeps its
   own values, so the export and anything reading it are unaffected.

   The guard trigger is disabled for exactly this statement and re-enabled
   immediately after. trg_registrations_guard_update refuses UPDATEs that touch
   payment columns unless a staff session is present, and a Management API
   connection has none - so a migration cannot backfill any column without this.
   It is the legitimate case for that guard: nobody is changing anybody's payment
   state here, only copying an identifier into its new home. Postgres runs the
   whole file as one transaction, so if this statement fails the disable is
   rolled back with it and the trigger is never left off. */
alter table public.registrations disable trigger trg_registrations_guard_update;

update public.registrations
   set event_id_value = btrim(free_fire_id)
 where event_id_value is null
   and nullif(btrim(coalesce(free_fire_id, '')), '') is not null;

alter table public.registrations enable trigger trg_registrations_guard_update;

create index if not exists ix_registrations_event_id_value
  on public.registrations (event_id_value)
  where event_id_value is not null;
-- ---------------------------------------------------------------------------
-- 3. the rule, now read from the catalogue instead of hardcoded
-- ---------------------------------------------------------------------------
-- Same two-trigger shape as ...011, and for the same reason: a table CHECK would
-- be evaluated on every update of a legacy row that has no ID, making the UTR
-- step impossible for exactly the participants who need to finish.
--
--   BEFORE INSERT              â†’ a new registration for such an event must bring one
--   BEFORE UPDATE OF the column â†’ it may not be cleared afterwards
--
-- The message names the event it came from rather than saying "FREE FIRE",
-- because the whole point is that it is no longer only that event.

create or replace function public.require_event_id ()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_requires boolean;
  v_title    text;
begin
  -- A bundle, or a row with no event behind it, is not this rule's business.
  if new.purchase_type is distinct from 'event'
     or nullif(btrim(coalesce(new.purchase_ref, '')), '') is null then
    return new;
  end if;

  select ec.requires_event_id, ec.title
    into v_requires, v_title
    from public.event_catalogue ec
   where ec.id = new.purchase_ref;

  if coalesce(v_requires, false)
     and nullif(btrim(coalesce(new.event_id_value, '')), '') is null then
    raise exception
      'A % registration needs a % ID - it is checked at the venue.',
      v_title, upper(v_title)
      using errcode = '23514';
  end if;

  return new;
end;
$$;

comment on function public.require_event_id() is
  'BEFORE INSERT, and BEFORE UPDATE OF event_id_value, on registrations. Refuses a registration whose event carries requires_event_id but brings no identifier, and refuses to have one cleared afterwards. Reads the requirement from event_catalogue rather than naming an event, so ticking the box in the console is enough - the mistake migration ...028 calls a product decision hiding inside the schema. Narrowed to purchase_type = ''event'' because the wizard collects no per-event fields for a bundle.';

drop trigger if exists trg_registrations_free_fire_id on public.registrations;

create trigger trg_registrations_event_id
  before insert on public.registrations
  for each row
  execute function public.require_event_id ();

drop trigger if exists trg_registrations_free_fire_id_clear on public.registrations;
drop trigger if exists trg_registrations_event_id_clear on public.registrations;

create trigger trg_registrations_event_id_clear
  before update of event_id_value on public.registrations
  for each row
  execute function public.require_event_id ();
-- ---------------------------------------------------------------------------
-- 4. the console's save carries the flag
-- ---------------------------------------------------------------------------
-- staff_upsert_event is regenerated here rather than hand-edited. That function has
-- now been recreated by four migrations (...028, ...034, ...035, this one), and the reason
-- to do it again is that a partial save CANNOT introduce a new field: every SET clause
-- is guarded on p_event ? 'key', so a key the function does not know about is
-- silently dropped. There is no smaller correct edit - see the note at the top about
-- free_fire_id for why the column was added rather than renamed.
--
CREATE OR REPLACE FUNCTION public.staff_upsert_event(p_event jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  v_needs_id  boolean;
  v_pay_mode  text;
  -- What the row already says, for the fields a client may have left out.
  v_prev_entry   text;
  v_prev_cap     integer;
  v_prev_offsite boolean;
  v_prev_roster  boolean;
  v_prev_needs_id boolean;
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
         ec.roster_collected_on_site, ec.requires_event_id
    into v_prev_entry, v_prev_cap, v_prev_offsite, v_prev_roster, v_prev_needs_id
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

  -- Presence, not value: the form sends false to clear it.
  if p_event ? 'requires_event_id' then
    v_needs_id := coalesce((p_event ->> 'requires_event_id')::boolean, false);
  else
    v_needs_id := coalesce(v_prev_needs_id, false);
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
     roster_collected_on_site, requires_event_id, team_form_url,
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
     v_needs_id,
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
         requires_event_id  = case when p_event ? 'requires_event_id' then excluded.requires_event_id else ec.requires_event_id end,
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
                       'requires_event_id', v_needs_id,
                       'payment_mode', v_pay_mode,
                       'price', case when v_price is null then null
                                     else v_price::integer end,
                       'registered', public.event_registered_count(v_id)));

  return jsonb_build_object('ok', true, 'id', v_id, 'entry_type', v_entry,
                            'max_team_members', v_cap, 'max_registrations', v_seats,
                            'registration_closes_on', v_closes,
                            'team_formed_offsite', v_offsite,
                            'roster_collected_on_site', v_roster,
                            'requires_event_id', v_needs_id,
                            'payment_mode', v_pay_mode);
end;
$function$;


-- ---------------------------------------------------------------------------
-- 5. both catalogue reads carry the flag
-- ---------------------------------------------------------------------------
-- The wizard has to know whether to ask, so the flag travels with the event. Taken
-- from the definitions actually in force on the server rather than copied from a
-- migration file, which is what keeps this from silently dropping the deadline
-- or the roster rule that 034 and 035 added.
--
CREATE OR REPLACE FUNCTION public.public_catalogue()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
               'requires_event_id', ec.requires_event_id,
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
$function$;

CREATE OR REPLACE FUNCTION public.staff_list_catalogue()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
               'requires_event_id', ec.requires_event_id,
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
$function$;


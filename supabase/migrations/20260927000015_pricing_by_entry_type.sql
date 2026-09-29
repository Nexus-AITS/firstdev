-- =============================================================================
-- NEXUS - prices by entry type, and the catalogue as the only priceable thing
-- Migration : 20260927000015_pricing_by_entry_type.sql
-- Purpose   : Price an event for HOW it is entered (migration ...014 gave every
--             event an entry type), and stop the database from holding a price
--             for anything the catalogue does not contain.
--
-- WHY THIS EXISTS
--
-- Two separate problems, and the first one is money.
--
-- 1. A price was per EVENT, and an event is entered either individually or as
--    a team (a member pays the team rate; the cap is the only other rule). So
--    "the price" did not say WHICH rate it was - an individual event's fee and a
--    team member's fee were the same number with nothing recording which. public
--    pricing now carries entry_type, and the trigger DERIVES it from the event,
--    so a price can never be stored against a variant the event does not offer.
--
--    Note what this is NOT: one event does not hold two rates. uq_pricing_ref on
--    (kind, ref_id) still stands, so there is one price per item, and entry_type
--    says which way of entering it that price covers. An earlier draft of this
--    migration moved the index to (kind, ref_id, entry_type) on the assumption
--    that both rates could coexist; that was wrong (the trigger forbids it) and
--    it would have broken ...007's seed - see section 1.
--
-- 2. public.pricing had no referential integrity whatsoever. `uq_pricing_ref`
--    was a unique index and nothing else, and writes went STRAIGHT to the table
--    from the browser (staffSetPrice in src/data/staff.js did a client-side
--    read-then-write to decide insert vs update). A master session could insert a
--    price for a ref_id that was never in the catalogue, and nothing would ever
--    remove it - an invisible, unpriceable row. The admin Pricing tab made it
--    worse: its list came from the JS arrays, so it could not even SHOW a row
--    whose event was not compiled into the bundle.
--
-- So this migration:
--
--   * adds public.pricing.entry_type, derived by trigger from the catalogue;
--   * refuses, by trigger, any price whose ref_id is not in the catalogue;
--   * DELETES the orphan rows that already exist, and names them in a NOTICE;
--   * replaces the browser write with staff_set_price, which validates and
--     derives the entry type server-side;
--   * lets staff_upsert_event take the amount, so the console's event form sets
--     the entry type and the price in the one call that owns both;
--   * stops registration_set_events treating an unpriced event as a free one.
--
-- WHY BUNDLES PIN entry_type = 'individual'
--
-- A bundle is a contract for a fixed set of events, not a way of entering one,
-- so the column means nothing for it. The trigger writes the sentinel so the
-- value is never NULL, and the CHECK below says so explicitly rather than
-- leaving it to be inferred.
--
-- WHY RETIRED DOES NOT COUNT AS GONE
--
-- The existence check ignores is_active on purpose. Retiring an event should
-- keep its price, so publishing it again does not silently re-open it at zero.
-- A row with no catalogue entry at all is a different thing: it is unreachable,
-- unreferenced, and can never be paid - that is the anomaly being removed.
--
-- Idempotent: add-column-if-not-exists, create-or-replace, and
-- drop-index/constraint-if-exists before creating.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. the entry type on a price
-- ---------------------------------------------------------------------------

-- NULLABLE and with NO default, which looks like a mistake and is the opposite.
-- A default of 'individual' would make migration ...007's generated seed - which
-- names only (kind, ref_id, price) - stamp 'individual' onto every team event on
-- a re-run, and the trigger in section 4 would then refuse all eleven rows.
-- Leaving it nullable means an old write reads as "did not say" and is derived
-- from the catalogue instead, while the CHECK below refuses a row that somehow
-- ends up NULL anyway. The column is written by the database, never by a client.
alter table public.pricing
  add column if not exists entry_type text;

-- uq_pricing_ref (kind, ref_id) is KEPT, deliberately, and this is the part that
-- an earlier draft of this migration got wrong. Dropping it and moving the key
-- onto (kind, ref_id, entry_type) sounds tidier, but one price per item is the
-- REAL invariant here - the trigger in section 4 forbids two rows for one event
-- anyway - and dropping the index would invalidate the
-- `on conflict (kind, ref_id) do nothing` inside ...007's generated seed. Since
-- db:migrate re-runs every file in order, that turns a re-run into a hard failure
-- on a clause naming a constraint that no longer exists.
drop index if exists public.uq_pricing_ref_entry;

-- chk_pricing_entry_type is deliberately NOT added here. Every existing row has a
-- NULL entry_type at this point, and a CHECK added now would fail on the first
-- row it looked at. It goes in after the backfill, in section 3.

comment on column public.pricing.entry_type is
  'Which way of entering this the price covers: ''individual'' or ''team'' for an event, and the fixed sentinel ''individual'' for a bundle, which has no entry rule. Always equal to event_catalogue.entry_type for kind = ''event'' - enforced by trg_pricing_check_ref.';

-- ---------------------------------------------------------------------------
-- 2. backfill BEFORE the trigger, so nothing is ever written in violation
-- ---------------------------------------------------------------------------
--
-- Order matters twice over. The column was added with no default, so every
-- existing row is NULL and the CHECK in section 3 cannot be added until they are
-- all filled. And the catalogue is the only source that can say which variant an
-- event price belongs to, so the re-stamp is not a convenience.

update public.pricing p
   set entry_type = ec.entry_type
  from public.event_catalogue ec
 where p.kind = 'event'
   and p.ref_id = ec.id
   and p.entry_type is distinct from ec.entry_type;

-- Bundles get the sentinel. Not left NULL: there is no catalogue entry type to
-- copy, and a NULL would fail the CHECK added in section 3 - so the whole
-- migration would abort with the pricing table half-migrated.
update public.pricing
   set entry_type = 'individual'
 where kind = 'bundle'
   and entry_type is distinct from 'individual';

-- ---------------------------------------------------------------------------
-- 3. the orphans
-- ---------------------------------------------------------------------------
-- Removed, not disabled and not left for someone to find. Each one is a price
-- for an event or bundle that does not exist: nothing can select it, nothing can
-- pay it, and it can only ever look like a real price to an operator reading the
-- table. The ids are named so the deletion is auditable from the migration log.

do $$
declare
  v_labels text;
begin
  with doomed as (
    select p.id, p.kind || ':' || p.ref_id as label
      from public.pricing p
     where (p.kind = 'event'  and not exists (
              select 1 from public.event_catalogue ec where ec.id = p.ref_id))
        or (p.kind = 'bundle' and not exists (
              select 1 from public.bundle_catalogue bc where bc.id = p.ref_id))
  ), removed as (
    delete from public.pricing p using doomed d
     where p.id = d.id
    returning d.label
  )
  select string_agg(label, ', ' order by label) into v_labels from removed;

  if v_labels is not null then
    raise notice
      'pricing: removed price row(s) naming nothing in the catalogue: %', v_labels;
  end if;
end;
$$;

-- Now, and only now, the rule. Every existing row has an entry_type (section 2
-- filled them) and every row names something real (the block above removed the
-- rest), so the constraint validates.
--
-- Drop-then-add rather than add-if-not-exists, which Postgres has no form of for
-- constraints. Same pattern as ...011, and it also lets a corrected definition be
-- applied by re-running this file.
--
-- `entry_type is not null` is load-bearing, not decoration. Without it a NULL
-- makes the whole expression NULL, and a CHECK rejects only FALSE - so a row with
-- no entry type would pass the very constraint written to forbid it. That is the
-- same three-valued-logic trap that the event cap in ...016 hits, and it is why
-- the test is spelled out rather than left to the disjunction.
alter table public.pricing
  drop constraint if exists chk_pricing_entry_type;

alter table public.pricing
  add constraint chk_pricing_entry_type
    check (
      entry_type is not null
      and ( (kind = 'bundle' and entry_type = 'individual')
         or (kind = 'event'  and entry_type in ('individual', 'team')) )
    );

comment on column public.pricing.entry_type is
  'Which way of entering this the price covers: ''individual'' or ''team'' for an event, and the fixed sentinel ''individual'' for a bundle, which has no entry rule. Written by trg_pricing_check_ref from the row it points at, never by a client.';

-- ---------------------------------------------------------------------------
-- 4. the rule that makes an orphan impossible
-- ---------------------------------------------------------------------------
-- A trigger rather than a foreign key, and the reason is structural: the table a
-- price points at depends on the row's own `kind`, and a foreign key can only
-- name one target. So the two facts a key would have given are checked here.
--
-- It fires on INSERT and UPDATE only. A DELETE cannot orphan anything - the row
-- being removed IS the anomaly disappearing.
--
-- BEFORE, not AFTER, so the row is never stored even briefly in a state the
-- catalogue disagrees with.

create or replace function public.pricing_check_ref ()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_entry text;
begin
  if new.kind = 'event' then
    select ec.entry_type into v_entry
      from public.event_catalogue ec
     where ec.id = new.ref_id;

    -- A price for something that is not in the catalogue is a real error and is
    -- REFUSED. It cannot be derived, and nothing can ever pay it.
    if v_entry is null then
      raise exception
        'There is no event "%" in the catalogue, so it cannot be priced. Add the event first.',
        new.ref_id
        using errcode = '23503';
    end if;

    -- The variant is DERIVED, not compared. An earlier draft refused a mismatch,
    -- and that was wrong twice over: the catalogue already knows the answer, so
    -- the column is a restatement of the event's rule rather than a second thing
    -- an operator can set - and refusing broke migration ...007's generated seed,
    -- which writes no entry_type at all and would have been rejected on a re-run.
    new.entry_type := v_entry;

  elsif new.kind = 'bundle' then
    if not exists (select 1 from public.bundle_catalogue bc where bc.id = new.ref_id) then
      raise exception
        'There is no bundle "%" in the catalogue, so it cannot be priced. Add the bundle first.',
        new.ref_id
        using errcode = '23503';
    end if;
    new.entry_type := 'individual';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_pricing_check_ref on public.pricing;
create trigger trg_pricing_check_ref
  before insert or update on public.pricing
  for each row
  execute function public.pricing_check_ref ();

comment on function public.pricing_check_ref () is
  'Refuses a price naming nothing in the catalogue, and DERIVES entry_type from the row it points at, so a price can never be stored for a variant the event does not offer and no client has to supply one. This is the referential integrity uq_pricing_ref never had.';


-- ---------------------------------------------------------------------------
-- 5. staff_set_price
-- ---------------------------------------------------------------------------
-- The browser no longer writes to public.pricing at all.
--
-- staffSetPrice (src/data/staff.js) used to read the row to decide between
-- PATCH and POST. That was two round trips, it raced with a concurrent save, and
-- - the part that mattered - it inserted a price for whatever ref_id the caller
-- named, with nothing checking that a catalogue row of that name existed. This
-- function does the lookup, the existence check and the entry-type derivation in
-- one server-side statement, and refuses with a sentence the console can print.

create or replace function public.staff_set_price (
  p_kind    text,
  p_ref_id  text,
  p_price   integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_entry   text;
  v_current integer;
begin
  if not public.staff_at_least('master') then
    return jsonb_build_object('ok', false,
      'error', 'Only a master administrator can change prices.');
  end if;

  if p_kind not in ('event', 'bundle') then
    return jsonb_build_object('ok', false,
      'error', 'Prices are for events and bundles only.');
  end if;

  if p_ref_id is null or btrim(p_ref_id) = '' then
    return jsonb_build_object('ok', false, 'error', 'Nothing was selected to price.');
  end if;

  -- 0 is a legitimate price (an explicitly free entry), so the refusal is about
  -- the shape of the number, never about it being zero.
  if p_price is null or p_price < 0 or p_price > 1000000 then
    return jsonb_build_object('ok', false,
      'error', 'Enter a whole number of rupees, zero or more.');
  end if;

  if p_kind = 'event' then
    -- The entry type is READ from the catalogue here, never taken from the
    -- caller. A client that asked for a team rate on an individual event is
    -- asking to store the exact disagreement trg_pricing_check_ref forbids, so
    -- the server simply does not offer it.
    select ec.entry_type into v_entry
      from public.event_catalogue ec
     where ec.id = btrim(p_ref_id);

    if v_entry is null then
      return jsonb_build_object('ok', false,
        'error', 'There is no event "' || p_ref_id || '" in the catalogue, so it cannot be priced.');
    end if;
  else
    if not exists (
      select 1 from public.bundle_catalogue bc where bc.id = btrim(p_ref_id)
    ) then
      return jsonb_build_object('ok', false,
        'error', 'There is no bundle "' || p_ref_id || '" in the catalogue, so it cannot be priced.');
    end if;
    v_entry := 'individual';
  end if;

  insert into public.pricing as pr
    (kind, ref_id, entry_type, price, is_active, updated_by)
  values
    (p_kind, btrim(p_ref_id), v_entry, p_price, true,
     (select s.username from public.staff_session() s))
  on conflict (kind, ref_id) do update
     set price      = excluded.price,
         is_active  = true,
         updated_at = now(),
         updated_by = excluded.updated_by
  returning pr.price into v_current;

  return jsonb_build_object('ok', true, 'kind', p_kind, 'ref_id', btrim(p_ref_id),
                            'entry_type', v_entry, 'price', v_current);
end;
$$;

comment on function public.staff_set_price(text, text, integer) is
  'Set the price of a catalogue event or bundle. Master-only. The entry_type is derived from the catalogue, so a client cannot price a variant the event does not offer, and a ref_id that is not in the catalogue is refused rather than stored.';

revoke execute on function public.staff_set_price(text, text, integer) from public;
grant  execute on function public.staff_set_price(text, text, integer) to anon, authenticated;


-- ---------------------------------------------------------------------------
-- 6. staff_upsert_event, now carrying the amount
-- ---------------------------------------------------------------------------
-- The console's event form sets the entry type and the amount together, and
-- this is the call that owns both. Recreated rather than altered, replacing the
-- version from ...014 - the same replace-the-body pattern ...008 used.
--
-- Two things it does that the old one could not:
--
--   * accepts an optional `price`, and writes the public.pricing row for the
--     entry type the event now has;
--   * leaves entry_type to trg_pricing_check_ref, which rewrites it on this very
--     insert. So flipping an event between individual and team can never leave a
--     price row describing the variant it no longer offers - there is no step
--     here that could get it wrong.

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

  -- Validated BEFORE the event is written, so a bad amount leaves no half-saved
  -- catalogue row behind. 0 is allowed: a deliberately free event is a real
  -- state, and the form can express it.
  if v_price is not null then
    if v_price !~ '^-?[0-9]+$' or v_price::integer < 0 or v_price::integer > 1000000 then
      return jsonb_build_object('ok', false,
        'error', 'Enter a whole number of rupees, zero or more.');
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

  -- Move an existing price onto the variant the event is now. Done before the
  -- optional price write below, and either way the invariant holds when the
  -- trigger sees this row.
  -- Move an existing price onto the variant the event is now, when the operator
  -- flips the entry type WITHOUT re-typing the amount.
  --
  -- This is not redundant with trg_pricing_check_ref. That trigger rewrites
  -- entry_type whenever a PRICE is written, so a save that includes an amount
  -- would be correct on its own. But a save that only changes the type writes no
  -- price, the existing row keeps saying 'team', and then public_catalogue's
  -- lookup - which matches on the event's entry type - stops finding it. The
  -- event would silently appear UNPRICED, and registration_set_events would start
  -- refusing it. The UPDATE is what keeps the two sides in step when the amount
  -- is not part of the edit.
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
                       'price', case when v_price is null then null
                                     else v_price::integer end));

  return jsonb_build_object('ok', true, 'id', v_id, 'entry_type', v_entry,
                            'max_team_members', v_cap);
end;
$$;

revoke execute on function public.staff_upsert_event(jsonb) from public;
grant  execute on function public.staff_upsert_event(jsonb) to anon, authenticated;


-- ---------------------------------------------------------------------------
-- 7. the public read carries the price
-- ---------------------------------------------------------------------------
-- The admin console's pricing list is built from the catalogue, and the
-- catalogue is one call. Carrying the price on the same object means the console
-- can render "every catalogue item and what it costs" from a single response
-- instead of joining two paged windows in the browser and hoping they line up.
--
-- The lookup matches on entry_type, so the number a caller receives is the one
-- for the variant that event actually offers. A null here means "no price set",
-- which is a data gap the console shows as such - never as zero.

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
  'Active events and bundles with their prices, in one response, so a bundle card can never render against a half-loaded catalogue and a console list can never be built from a second source. Public by design: it returns nothing that is not already on the public site.';


-- ---------------------------------------------------------------------------
-- 8. an unpriced event is not a free event
-- ---------------------------------------------------------------------------
--
-- The sum below adds up whatever price rows it finds. An event with no row
-- therefore contributes 0 and hands out a free seat, silently. That has been true
-- since ...006 and is the one place where a missing catalogue fact became a
-- missing rupee.
--
-- Recreated whole, so the refusal and the sum cannot drift apart. The amount is
-- still computed entirely server-side; the browser still sends ids only.

create or replace function public.registration_set_events (
  p_registration_id uuid,
  p_bundle_id       text default null,
  p_event_ids       text[] default '{}'
)
returns table (registration_id uuid, amount integer, currency text)
language plpgsql
set search_path = ''
as $$
declare
  v_user_id  uuid;
  v_status   public.payment_status;
  v_frozen   boolean;
  v_reg_id   uuid;
  v_bundle   integer;
  v_events   integer;
  v_known    text[];
  v_amount   integer;
  v_errors   text[];
  v_titles   text;
  v_unpriced text;
begin
  v_user_id := auth.uid();
  if v_user_id is null then
    raise exception 'Sign in before choosing events.' using errcode = '42501';
  end if;

  select r.id, r.payment_status, r.selection_frozen
    into v_reg_id, v_status, v_frozen
    from public.registrations r
   where r.id = p_registration_id
     and r.user_id = v_user_id;

  if not found then
    raise exception 'That registration is not yours.' using errcode = '42501';
  end if;

  if v_frozen then
    raise exception 'Your event selection is final. Contact the operations team to change it.'
      using errcode = '42501';
  end if;

  if v_status = 'verified' then
    raise exception 'This payment is already confirmed, so the selection is closed.'
      using errcode = '42501';
  end if;

  select coalesce(array_agg(ec.id order by ec.id), '{}')
    into v_known
    from public.event_catalogue ec
   where ec.is_active
     and ec.id = any (coalesce(p_event_ids, '{}'));

  if coalesce(array_length(v_known, 1), 0)
     <> coalesce(array_length(coalesce(p_event_ids, '{}'), 1), 0) then
    raise exception 'One or more of those events is not available.'
      using errcode = '22023';
  end if;


  if p_bundle_id is not null then
    select p.price into v_bundle
      from public.pricing p
      join public.bundle_catalogue b on b.id = p.ref_id
     where p.kind = 'bundle' and p.ref_id = p_bundle_id
       and p.entry_type = 'individual' and p.is_active and b.is_active;

    if v_bundle is null then
      raise exception 'That bundle is not available.' using errcode = '22023';
    end if;

    v_errors := public.bundle_selection_errors(p_bundle_id, v_known);
    if coalesce(array_length(v_errors, 1), 0) > 0 then
      raise exception '%', array_to_string(v_errors, ' ')
        using errcode = '22023';
    end if;

    v_amount := v_bundle;
  else
    if coalesce(array_length(v_known, 1), 0) = 0 then
      raise exception 'Choose at least one event.' using errcode = '22023';
    end if;

    -- A MISSING row, not a zero row. The test is the absence of an active price
    -- for this event's own entry type, never the number being 0, because 0 is a
    -- legitimate FREE entry and has to pass.
    select string_agg(ec.id, ', ' order by ec.id) into v_unpriced
      from public.event_catalogue ec
     where ec.id = any (v_known)
       and not exists (
             select 1 from public.pricing p
              where p.kind = 'event' and p.ref_id = ec.id
                and p.entry_type = ec.entry_type and p.is_active);

    if v_unpriced is not null then
      raise exception 'No price is set yet for: %. Contact the operations team.', v_unpriced
        using errcode = '22023';
    end if;

    -- Joined to the catalogue rather than filtering on ref_id alone, so the sum
    -- can only ever add up rates that match the entry type being charged for.
    select coalesce(sum(p.price), 0) into v_events
      from public.pricing p
      join public.event_catalogue ec
        on ec.id = p.ref_id and p.entry_type = ec.entry_type
     where p.kind = 'event'
       and p.is_active
       and p.ref_id = any (v_known);

    v_amount := coalesce(v_events, 0);
  end if;

  select coalesce(string_agg(ec.title, ', ' order by ec.sort_order, ec.id), '')
    into v_titles
    from public.event_catalogue ec
   where ec.id = any (v_known);

  delete from public.registration_events re
   where re.registration_id = v_reg_id;

  insert into public.registration_events (registration_id, event_id)
  select v_reg_id, unnest(v_known)
  where cardinality(v_known) > 0;

  update public.registrations r
     set purchase_type   = case when p_bundle_id is not null then 'bundle' else 'event' end,
         purchase_label  = case
                             when p_bundle_id is not null
                               then p_bundle_id || (case when cardinality(v_known) > 0
                                                        then ' + ' || v_titles
                                                        else '' end)
                             when cardinality(v_known) > 0 then v_titles
                             else 'none'
                           end,
         purchase_amount = v_amount,
         updated_at      = now()
   where r.id = v_reg_id;

  return query select v_reg_id, v_amount, 'INR'::text;
end;
$$;

comment on function public.registration_set_events is
  'Replace a registration''s event selection. Refused once the selection is frozen or the payment is verified, and refused if any chosen event has no price set - a missing price is a data gap, not a free seat. With a bundle, the selection is validated against the bundle''s include lines and the bundle price is the TOTAL; without one, the chosen events are summed from public.pricing at their own entry type. The browser supplies ids only; the amount is never accepted from the client.';

grant execute on function public.registration_set_events(uuid, text, text[]) to authenticated;
revoke execute on function public.registration_set_events(uuid, text, text[]) from anon;


-- =============================================================================
-- NEXUS - a single-event purchase must join the event it bought
-- Migration : 20260927000025_single_purchase_joins.sql
-- Status    : APPLIED via npm run db:migrate (Management API + PAT in .env).
--
-- THE BUG, MEASURED
--
--   purchase_type   rows   join rows in registration_events
--   bundle            1     3
--   event            19     0
--
-- Every registration_events row on this project was written by
-- registration_set_events(), which ONLY the bundle-with-pools path calls. A
-- single-event purchase goes finalize() -> addRegistration() -> submitUtr(),
-- and that path never writes a join row at all: it records the event in
-- purchase_type / purchase_ref on the registration itself and stops.
--
-- So registration_events described one purchase out of twenty. Four things
-- that all read that table were therefore wrong for 95% of the roster:
--
--   * the console's event filter (staffListRegistrations filters
--     registration_events.event_id with an !inner embed) returned NOTHING for
--     every event bought directly - "the filter is not working";
--   * event_registered_count() read 0, so every event card showed no seats
--     taken and the number never moved;
--   * trg_event_registration_cap only fires on an INSERT into this table, so
--     max_registrations (nexus-breach carries 400) was never enforced even once;
--   * staff_list_event_registrations, the per-event roster drilldown, was
--     empty for all of them.
--
-- WHY A TRIGGER AND NOT A LINE IN THE WIZARD
--
-- Because the wizard is not the only writer, and the rule belongs to the
-- database: purchase_type='event' MEANS "this row holds one event seat", and
-- everything that counts a seat should be able to rely on that being true.
-- Same argument as ...016 for the cap and ...011 for the Free Fire id - a
-- client-side check is a convenience, a trigger is the authority.
--
-- WHY BUNDLES ARE EXEMPT
--
-- A bundle's events are the participant's CHOICE, made in
-- registration_set_events and stored per selected id. A bundle row must not
-- have "its" event guessed here: bundled-299 and bundled-349 are different
-- contracts that both contain NEXUS BREACH, and writing the bundle id as an
-- event id would be a join nothing could ever satisfy.
--
-- SECURITY DEFINER because the trigger fires for EVERY writer of a
-- registration, and staff (the anon role) holds only SELECT on
-- registration_events. Without it an operator creating a registration from the
-- console would fail the join while a participant succeeded.
--
-- Idempotent: create-or-replace + drop-trigger-if-exists + ON CONFLICT DO
-- NOTHING, so a second run cannot double-count a seat.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. the writer
-- ---------------------------------------------------------------------------

create or replace function public.registrations_join_single_event ()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Not an event purchase, or no reference to resolve. A row with no purchase
  -- context (added by hand from the console) is left alone rather than guessed.
  if new.purchase_type is distinct from 'event'
     or nullif(btrim(coalesce(new.purchase_ref, '')), '') is null then
    return new;
  end if;

  -- An id that is not in the catalogue cannot become a join row. event_id is
  -- TEXT rather than a foreign key (migration ...006 explains why: the
  -- catalogue owns the ids, not the database), so a typo is possible. Saying so
  -- beats a join that matches nothing and a seat nobody counts.
  if not exists (select 1 from public.event_catalogue ec where ec.id = new.purchase_ref) then
    raise notice
      'registration %: purchase_ref % is not in the event catalogue - no join written',
      new.id, new.purchase_ref;
    return new;
  end if;

  -- ON CONFLICT DO NOTHING is the idempotence. The trigger is AFTER INSERT OR
  -- UPDATE, so any later touch of purchase_type / purchase_ref re-runs it, and
  -- a duplicated join would double-count a seat on every card.
  insert into public.registration_events (registration_id, event_id)
  values (new.id, new.purchase_ref)
  on conflict (registration_id, event_id) do nothing;

  return new;
end;
$$;

comment on function public.registrations_join_single_event() is
  'AFTER INSERT OR UPDATE on registrations. Mirrors a single-event purchase into registration_events so the roster event filter, the seat counter, the registration cap and the per-event drilldown all see it. Bundles are exempt - their selection is the participant''s choice, written by registration_set_events.';

drop trigger if exists trg_registrations_join_single_event on public.registrations;

create trigger trg_registrations_join_single_event
  after insert or update of purchase_type, purchase_ref on public.registrations
  for each row
  execute function public.registrations_join_single_event();

-- ---------------------------------------------------------------------------
-- 2. the repair
-- ---------------------------------------------------------------------------
-- The nineteen rows already on the roster. Per-row exception handling on
-- purpose: the cap trigger rejects a join for an event that is already full,
-- and one such row must not abandon the other eighteen. Each refusal is
-- counted and reported rather than swallowed, because "skipped" has to stay
-- visible - it means an event took registrations past its own limit while the
-- counter was blind.

do $$
declare
  v_row     record;
  v_added   integer := 0;
  v_skipped integer := 0;
  v_detail  text[] := '{}';
begin
  for v_row in
    select r.id, r.purchase_ref
      from public.registrations r
     where r.purchase_type = 'event'
       and nullif(btrim(coalesce(r.purchase_ref, '')), '') is not null
       and exists (select 1 from public.event_catalogue ec where ec.id = r.purchase_ref)
       and not exists (
             select 1 from public.registration_events re
              where re.registration_id = r.id
                and re.event_id = r.purchase_ref)
     order by r.created_at
  loop
    begin
      insert into public.registration_events (registration_id, event_id)
      values (v_row.id, v_row.purchase_ref)
      on conflict (registration_id, event_id) do nothing;
      v_added := v_added + 1;
    exception when others then
      v_skipped := v_skipped + 1;
      v_detail := array_append(v_detail,
                     v_row.purchase_ref || ' (' || sqlerrm || ')');
    end;
  end loop;

  raise notice 'single-event join backfill: % added, % skipped', v_added, v_skipped;
  if v_skipped > 0 then
    raise notice 'skipped, the event was already at its registration cap: %',
      array_to_string(v_detail, ' | ');
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. how to confirm the repair landed
-- ---------------------------------------------------------------------------
-- A count an operator can read, not a check that fails the deploy - section 2
-- is allowed to skip.
--
--   SELECT r.purchase_type, count(*) AS rows, count(re.registration_id) AS joins
--     FROM public.registrations r
--     LEFT JOIN public.registration_events re ON re.registration_id = r.id
--    GROUP BY r.purchase_type;
--
-- Expect 'bundle' rows >= joins (a bundle holds several) and 'event' rows ==
-- joins. Before this migration 'event' read 19 rows and 0 joins.


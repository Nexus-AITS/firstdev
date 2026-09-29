-- Migration : 20260927000021_staff_delete.sql
-- Purpose   : Let a MASTER permanently remove an event, a bundle or a contact.
--             Retiring (staff_retire_*) already exists and is what the console
--             offers; this is the harder, irreversible thing, deliberately kept
--             separate and deliberately fenced off from the other two roles.
--
-- WHY DELETE AT ALL
--
-- Retire is a flag. It never removes a row, which is right for the ordinary
-- case - a retired bundle keeps its registrations and its place in history. But
-- there are rows retire cannot fix: a bundle created by mistake with the wrong
-- pick-pool, an event that was never real, a contact channel that was a test.
-- Those sit in the catalogue forever, still counted by the seeded-id checks and
-- still listed for anyone reading the console. A master needs to be able to say
-- "this was never a thing", and only a master.
--
-- THE ROLE FENCE
--
-- `staff_at_least('master')` is checked INSIDE each function, the same place
-- staff_upsert_* and staff_retire_* check it. The console is an `anon`-role
-- client holding an X-Nexus-Staff-Token header, so RLS alone cannot express
-- "master and not merely signed in" - the function is the gate, and a UI that
-- hides the button is a convenience on top of it, never the control.
--
-- IT REFUSES WHERE THE DATA IS REAL
--
-- A delete that orphans history is worse than no delete. So each function names
-- what is in the way instead of letting a foreign-key violation surface:
--
--   * an event seated by a bundle that is on sale -> refused, bundle named
--   * an event anyone registered for            -> refused, count given
--   * a bundle anyone registered for            -> refused, count given
--
-- purchase_ref is a plain text column with no foreign key, so nothing would have
-- stopped either one. Deleting an event three people have paid for must be a
-- deliberate act performed on the payments table, not a side effect of tidying a

-- ---------------------------------------------------------------------------
-- events
-- ---------------------------------------------------------------------------
create or replace function public.staff_delete_event (p_event_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_seated_by text;
  v_registrations int;
  v_seats int;
begin
  if not public.staff_at_least('master') then
    return jsonb_build_object('ok', false,
      'error', 'Only a master administrator can permanently delete an event.');
  end if;

  if not exists (select 1 from public.event_catalogue ec where ec.id = p_event_id) then
    return jsonb_build_object('ok', false, 'error', 'No such event.');
  end if;

  select bi.bundle_id into v_seated_by
    from public.bundle_includes bi
   where bi.event_id = p_event_id
     and exists (select 1 from public.bundle_catalogue bc
                  where bc.id = bi.bundle_id and bc.is_active)
   order by bi.bundle_id
   limit 1;

  if v_seated_by is not null then
    return jsonb_build_object('ok', false,
      'error', format('Bundle "%s" is on sale and includes this event. Retire the bundle first.', v_seated_by));
  end if;

  select count(*) into v_registrations
    from public.registrations r
   where r.purchase_ref = p_event_id;

  select count(*) into v_seats
    from public.registration_events re
   where re.event_id = p_event_id;

  if v_registrations > 0 or v_seats > 0 then
    return jsonb_build_object('ok', false,
      'error', format(
        '%s participant(s) registered for this event. Deleting it would erase what they bought - retire it instead.',
        greatest(v_registrations, v_seats)));
  end if;

  -- Audited BEFORE the delete, so the trail records what was there. The detail
  -- keeps the row's own words: a master reading the log months later needs to
  -- know WHICH event went, not just that "an event" did.
  perform public.staff_audit(
    'delete_event', 'event', p_event_id,
    jsonb_build_object(
      'title', (select ec.title from public.event_catalogue ec where ec.id = p_event_id),
      'number', (select ec.number from public.event_catalogue ec where ec.id = p_event_id),
      'by', (select s.username from public.staff_session() s)));

  delete from public.pricing where kind = 'event' and ref_id = p_event_id;
  delete from public.event_catalogue where id = p_event_id;

  return jsonb_build_object('ok', true, 'id', p_event_id);
end;
$$;


-- ---------------------------------------------------------------------------
-- bundles
-- ---------------------------------------------------------------------------
create or replace function public.staff_delete_bundle (p_bundle_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_registrations int;
  v_lines int;
begin
  if not public.staff_at_least('master') then
    return jsonb_build_object('ok', false,
      'error', 'Only a master administrator can permanently delete a bundle.');
  end if;

  if not exists (select 1 from public.bundle_catalogue bc where bc.id = p_bundle_id) then
    return jsonb_build_object('ok', false, 'error', 'No such bundle.');
  end if;

  -- purchase_ref is a plain text column, so there is no foreign key to catch
  -- this. Without the count, a bundle three people had bought could be deleted
  -- and the roster would keep naming it with nothing on either side.
  select count(*) into v_registrations
    from public.registrations r
   where r.purchase_ref = p_bundle_id;

  if v_registrations > 0 then
    return jsonb_build_object('ok', false,
      'error', format(
        '%s participant(s) bought this bundle. Deleting it would erase what they bought - retire it instead.',
        v_registrations));
  end if;

  select count(*) into v_lines
    from public.bundle_includes bi where bi.bundle_id = p_bundle_id;

  perform public.staff_audit(
    'delete_bundle', 'bundle', p_bundle_id,
    jsonb_build_object(
      'name', (select bc.name from public.bundle_catalogue bc where bc.id = p_bundle_id),
      'number', (select bc.number from public.bundle_catalogue bc where bc.id = p_bundle_id),
      'include_lines', v_lines,
      'by', (select s.username from public.staff_session() s)));

  delete from public.pricing where kind = 'bundle' and ref_id = p_bundle_id;
  -- bundle_includes cascade from bundle_catalogue, so the lines go with it.
  delete from public.bundle_catalogue where id = p_bundle_id;

  return jsonb_build_object('ok', true, 'id', p_bundle_id);
end;
$$;

comment on function public.staff_delete_bundle(text) is
  'Master-only. Permanently removes a bundle, its price, and its include lines (which cascade). Refused whenever any registration bought it, since purchase_ref is a plain text column with no foreign key to catch it.';

grant  execute on function public.staff_delete_bundle(text) to anon, authenticated;
revoke execute on function public.staff_delete_bundle(text) from public;

-- ---------------------------------------------------------------------------
-- contacts
-- ---------------------------------------------------------------------------
create or replace function public.staff_delete_contact (p_contact_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.staff_at_least('master') then
    return jsonb_build_object('ok', false,
      'error', 'Only a master administrator can permanently delete a contact channel.');
  end if;

  if not exists (select 1 from public.contacts c where c.id = p_contact_id) then
    return jsonb_build_object('ok', false, 'error', 'No such channel.');
  end if;

  perform public.staff_audit(
    'delete_contact', 'contact', p_contact_id::text,
    jsonb_build_object(
      'label', (select c.label from public.contacts c where c.id = p_contact_id),
      'kind', (select c.kind from public.contacts c where c.id = p_contact_id),
      'by', (select s.username from public.staff_session() s)));

  delete from public.contacts where id = p_contact_id;

  return jsonb_build_object('ok', true, 'id', p_contact_id::text);
end;
$$;

comment on function public.staff_delete_contact(uuid) is
  'Master-only. Permanently removes a contact channel. Nothing references a contact, so this is the one delete with nothing left to orphan.';

grant  execute on function public.staff_delete_contact(uuid) to anon, authenticated;
revoke execute on function public.staff_delete_contact(uuid) from public;

comment on function public.staff_delete_event(text) is
  'Master-only. Permanently removes an event that nobody has bought and that no live bundle seats. Refused - with the blocking bundle named, or the number of registrations - whenever deleting it would erase real history.';

grant  execute on function public.staff_delete_event(text) to anon, authenticated;
revoke execute on function public.staff_delete_event(text) from public;

-- catalogue.

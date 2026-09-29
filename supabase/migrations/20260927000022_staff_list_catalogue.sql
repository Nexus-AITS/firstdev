-- Migration : 20260927000022_staff_list_catalogue.sql
-- Purpose   : Let the console list RETIRED events and bundles, so a master can
--             see what they have withdrawn, put it back, or delete it.
--
-- THE GAP
--
-- The Catalogue tab builds its list from public_catalogue, and that function
-- ends each of its two aggregates with `where is_active` - correctly, because
-- it feeds the public site and a retired row must never appear there. But it
-- means the console's list IS the public list, so a retired event is invisible
-- in the one screen whose job is editing the catalogue.
--
-- That is why the master-only Delete added in ...021 had nothing to attach to:
-- its button was rendered per row, and no retired row was ever rendered. A
-- bundle that had been retired - which is what every master does to all eight
-- of them in a normal season - could not be deleted, brought back, or even
-- seen. The only record of it was the audit log.
--
-- This is a staff read, not a public one, so it gets its own function rather
-- than a flag on public_catalogue: loosening that one to include retired rows
-- would leak withdrawn offers to every visitor.
--
-- Same projection as public_catalogue, deliberately, so a row means the same
-- thing in both places - the console is not reading a different shape and
-- inventing fields the RPC does not send. The one addition is is_active, which
-- public_catalogue has no reason to send and the console needs to render the
-- RETIRED marker and decide whether to offer Retire or Restore.

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
  'Master-only. The whole catalogue INCLUDING retired rows, in the same projection public_catalogue sends plus is_active. public_catalogue filters to live rows because it feeds the public site; this exists so the console can show a master what they have withdrawn instead of only what is currently for sale.';

grant  execute on function public.staff_list_catalogue() to anon, authenticated;
revoke execute on function public.staff_list_catalogue() from public;

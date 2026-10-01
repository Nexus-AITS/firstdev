-- =============================================================================
-- NEXUS - registration counts leave the public site
-- Migration : 20260927000033_counts_are_operations_only.sql
-- Purpose   : Stop publishing how many people have registered, and leave the
--             number where it belongs — the operations console.
--
-- WHY REMOVING IT FROM THE PAYLOAD AND NOT JUST THE PAGE
--
-- public_catalogue() carried `registered_count` on every event, and every card
-- rendered it through <Seats/>. Hiding it in the components would have left the
-- number in the response - so it would still be in the network tab of anyone who
-- opens devtools, still in any client that caches the catalogue, and still
-- recomputed on every catalogue load, because event_registered_count() is a COUNT
-- over registration_events for each of eleven events on each request.
--
-- So the field goes from the PUBLIC read. The console is unaffected: it reads
-- staff_list_catalogue(), which carries its own copy of the same count, and that
-- is the audience the number is for.
--
-- WHY IT IS AN OPERATIONS FIGURE
--
-- A public counter tells a prospective participant how busy an event already is.
-- That is the organiser's information, not the visitor's, and it steers the
-- decision to register - in both directions: a nearly-full event reads as urgent,
-- and an empty one reads as unwanted. Neither is what the page is for.
--
-- WHAT STILL RENDERS
--
-- The console's Catalogue list prints `registered / max_registrations` beside every
-- event, and the per-event roster (staff_list_event_registrations) still returns
-- the count with the people behind it. Nothing is lost operationally; it is only
-- no longer public.
--
-- Idempotent: create-or-replace only.
-- =============================================================================

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
  'Active events and bundles carrying every field the PUBLIC site renders - price, entry rule, who pays, whether the team is formed elsewhere, date, venue. Registration counts are deliberately absent: they are an operations figure, read by staff_list_catalogue() and staff_list_event_registrations(), not published here. Nothing returned is anything a visitor could not read off the page.';
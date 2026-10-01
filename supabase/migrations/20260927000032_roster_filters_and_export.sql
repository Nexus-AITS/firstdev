-- =============================================================================
-- NEXUS - roster filters that can be trusted, and an export that obeys them
-- Migration : 20260927000032_roster_filters_and_export.sql
-- Purpose   : Make the college / year / department filters show what they can
--             actually match, and make the Excel export honour them.
--
-- WHY THE FILTERS LOOK BROKEN (they are not, and the difference matters)
--
-- The roster filters college / year / department by EXACT match against the text
-- a participant typed. The dropdown, on the other hand, was built from
-- public.colleges - the list the REGISTRATION FORM offers.
--
-- Those are two different populations, and on this project the difference is the
-- whole problem. Of the 17 colleges in the lookup list, 14 have NO registrations
-- at all, including SVCE. So an operator adds SVCE to the list, picks it in the
-- filter, sees an empty roster - and concludes the filter is broken. It is not:
-- it is answering correctly that nobody has registered from SVCE yet.
--
-- Nothing in the UI distinguished those two cases. This does, by showing the
-- registration COUNT beside every option, so "SVCE (0)" reads as an honest empty
-- answer and "ANNAMACHARYA... (18)" reads as a live one. An empty result that
-- looks identical to a broken one is how an operator stops trusting a filter
-- that works.
--
-- WHY THE OPTIONS COME FROM BOTH PLACES
--
-- Distinct values actually ON registrations, UNIONED with the lookup list.
-- Only the second alone hides a college somebody has registered from but which
-- was later renamed in the console; only the first alone hides a college the
-- team just added and is expecting to filter by. The union makes every
-- selectable option either matchable or visibly empty, and there is no third
-- case.
--
-- WHY THE EXPORT HAD TO CHANGE SIGNATURE
--
-- staff_export_registrations(p_from_date, p_to_date, p_event, p_status) is the
-- function behind the Download button, and it knew nothing about college, year
-- or department. So an operator who filtered the roster down to one college and
-- pressed Download got a sheet of EVERYONE - the filtered view and the exported
-- file silently disagreeing, which for a reconciliation sheet is the worst kind
-- of bug: the file looks authoritative and is not.
--
-- Adding parameters changes the declared signature, and Postgres refuses CREATE
-- OR REPLACE for that, so the function is dropped and recreated. Dropping also
-- drops the GRANT, so it is re-issued below - forgetting that produces a
-- function that exists and answers 401 to everyone.
--
-- Idempotent: create-or-replace, drop-function-if-exists.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. what the filters can match
-- ---------------------------------------------------------------------------
-- Coordinator+, so the counts are not on the public surface: a per-college
-- breakdown of who is registered is a small but real amount of information about
-- the roster, and the console is already the gate for reading the roster at all.

create or replace function public.staff_filter_options ()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.staff_at_least('coordinator') then
    return jsonb_build_object('ok', false, 'error', 'Not authorised.');
  end if;

  return jsonb_build_object(
    'ok', true,
    'colleges', coalesce((
      select jsonb_agg(jsonb_build_object('name', u.name, 'count', u.n)
                       order by u.n desc, u.name)
        from (
          -- what people actually typed, with how many
          select btrim(r.college_name) as name, count(*)::int as n
            from public.registrations r
           where nullif(btrim(r.college_name), '') is not null
           group by btrim(r.college_name)
          union all
          -- plus every published college, so one with nobody yet is still
          -- offered - and still honest about having nobody
          select c.name, 0
            from public.colleges c
           where c.is_active
             and not exists (
                   select 1 from public.registrations r
                    where btrim(r.college_name) = c.name)
        ) u), '[]'::jsonb),
    'departments', coalesce((
      select jsonb_agg(jsonb_build_object('name', u.name, 'count', u.n)
                       order by u.n desc, u.name)
        from (
          select btrim(r.department) as name, count(*)::int as n
            from public.registrations r
           where nullif(btrim(r.department), '') is not null
           group by btrim(r.department)
          union all
          select d.name, 0
            from public.departments d
           where d.is_active
             and not exists (
                   select 1 from public.registrations r
                    where btrim(r.department) = d.name)
        ) u), '[]'::jsonb),
    'years', coalesce((
      select jsonb_agg(jsonb_build_object('name', u.year, 'count', u.n)
                       order by u.year)
        from (
          select r.year, count(*)::int as n
            from public.registrations r
           group by r.year
        ) u), '[]'::jsonb));
end;
$$;

comment on function public.staff_filter_options() is
  'Coordinator+. What the roster''s college, department and year filters can actually match, each with a registration count. The union of the values present on registrations and the published lookup lists, because either list alone hides something: registrations alone would hide a college the team just added, and the lookup list alone would hide one somebody has already registered from. The count is the point - it is what tells an operator that an empty result means "nobody from there", not "the filter is broken".';

grant execute on function public.staff_filter_options() to anon, authenticated;
-- ---------------------------------------------------------------------------
-- 2. the export, which now obeys the same filters
-- ---------------------------------------------------------------------------
-- The roster on screen and the file on disk are the same question asked twice,
-- so they are answered by the same filters. An operator narrowing to one
-- college and pressing Download must get that college's sheet, not the whole
-- roster with a hopeful filename.

drop function if exists public.staff_export_registrations(date, date, text, text, text, text, text);

create or replace function public.staff_export_registrations (
  p_from_date  date default null,
  p_to_date    date default null,
  p_event      text default null,
  p_status     text default null,
  p_college    text default null,
  p_year       text default null,
  p_department text default null
)
returns table (
  si_no            bigint,
  name             text,
  phone_number     text,
  payment_method   text,
  utr_number       text,
  reg_date         date,
  reg_time         time,
  email            text,
  college_name     text,
  roll_number      text,
  year             text,
  department       text,
  payment_status   text,
  purchase_label   text,
  purchase_amount  integer,
  events           text,
  team_name        text,
  free_fire_id     text,
  selection_frozen boolean,
  frozen_by        text,
  created_at_utc   timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_from_ist timestamptz;
  v_to_ist   timestamptz;
begin
  -- THE gate. Not optional, and the first statement so a non-staff caller is
  -- rejected before anything else is even evaluated.
  if not (select public.staff_at_least('coordinator')) then
    raise exception 'Not authorised.' using errcode = '42501';
  end if;

  -- Plain CALENDAR dates in, Asia/Kolkata day windows out. Both ends inclusive.
  v_from_ist := case
                  when p_from_date is null then null
                  else (p_from_date::text || ' 00:00:00')::timestamp
                         at time zone 'Asia/Kolkata'
                end;
  v_to_ist := case
                when p_to_date is null then null
                else ((p_to_date + 1)::text || ' 00:00:00')::timestamp
                       at time zone 'Asia/Kolkata'
              end;

  return query
  with filtered as (
    select r.id, r.name, r.phone_number, r.utr_number, r.created_at, r.email,
           r.college_name, r.roll_number, r.year, r.department,
           r.payment_status::text, r.payment_method,
           r.purchase_label, r.purchase_amount,
           r.team_name, r.free_fire_id,
           r.selection_frozen, r.selection_frozen_by,
           (select string_agg(re.event_id, ', ' order by re.event_id)
              from public.registration_events re
             where re.registration_id = r.id) as events
      from public.registrations r
     where (v_from_ist is null or r.created_at >= v_from_ist)
       and (v_to_ist   is null or r.created_at <  v_to_ist)
       and (p_status is null or p_status = 'all' or r.payment_status::text = p_status)
       -- An event filter is a join, not a LIKE on the free-text label: the label
       -- is prose the browser once wrote, and matching on prose is how a filter
       -- starts lying about who is in a room.
       and (p_event is null or p_event = 'all' or exists (
              select 1 from public.registration_events re
               where re.registration_id = r.id and re.event_id = p_event))
       -- The three the console also filters by. btrim on BOTH sides because the
       -- value arrives as whatever the operator picked out of a dropdown and the
       -- column holds whatever a participant typed; comparing raw would drop a
       -- row over a trailing space, and a filter that silently loses rows is
       -- worse than one that is slightly forgiving.
       and (p_college    is null or p_college    = 'all'
            or btrim(r.college_name) = btrim(p_college))
       and (p_department is null or p_department = 'all'
            or btrim(r.department) = btrim(p_department))
       and (p_year       is null or p_year       = 'all'
            or r.year = p_year)
     order by r.created_at asc, r.name asc
     -- Bounded on purpose. An export is a file the browser must hold in memory
     -- and a sheet someone opens in Excel; an unbounded result would be a
     -- denial of service aimed at whoever asked for it.
     limit 50000
  )
-- Every reference here is qualified with `f.` on purpose. RETURNS TABLE
  -- declares OUT parameters named `name`, `phone_number`, `email` and so on, and
  -- an unqualified reference in this select is ambiguous between the OUT
  -- variable and the column of the same name - Postgres rejects that outright
  -- (42702) rather than picking one. `team_name` and `payment_method` are OUT
  -- parameters now too and carry the same hazard.
  select row_number() over (order by f.created_at asc, f.name asc),
         f.name, f.phone_number, f.payment_method, f.utr_number,
         (f.created_at at time zone 'Asia/Kolkata')::date,
         (f.created_at at time zone 'Asia/Kolkata')::time,
         f.email, f.college_name, f.roll_number, f.year, f.department,
         f.payment_status, f.purchase_label, f.purchase_amount, f.events,
         f.team_name, f.free_fire_id,
         f.selection_frozen, f.selection_frozen_by,
         f.created_at
    from filtered f;
end;
$$;

comment on function public.staff_export_registrations(date, date, text, text, text, text, text) is
  'Filtered, numbered roster for the Excel sheet, obeying EXACTLY the filters the roster on screen is showing - event, status, date window, college, department and year. The dates are plain CALENDAR dates turned into Asia/Kolkata day windows here; both ends inclusive. Carries payment_method and team_name so a reconciler can tell a cash payment from a cleared reference and see which squad a leader brought. staff_at_least(coordinator) is the only gate; 50,000-row cap.';

grant execute on function public.staff_export_registrations(date, date, text, text, text, text, text) to anon;
revoke execute on function public.staff_export_registrations(date, date, text, text, text, text, text) from authenticated, public;
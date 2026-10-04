-- =============================================================================
-- NEXUS - roster: exclude a college
-- Migration : 20260927000041_roster_exclude_college.sql
-- Purpose   : Let an operator ask "everybody EXCEPT this college".
--
-- WHY THIS EXISTS
--
-- The roster could filter TO a college but not AWAY from one. That asymmetry is
-- not a missing convenience: the host institution is handled on its own line
-- during reconciliation, so the sheet under discussion has to contain everyone
-- else.
--
-- WHY THE EXPORT IS REDEFINED RATHER THAN EXTENDED
--
-- Postgres has no default arguments, so a ninth parameter is a NEW signature:
-- the old function is dropped and a new one created. That is why the grants are
-- re-issued at the bottom - a DROP takes the old function's grants with it, and
-- a function that exists and answers 401 to everyone is a failure this repo has
-- already paid for once.
--
-- THE NULL ROWS, WHICH ARE THE INTERESTING PART
--
-- The exclusion uses a bare <> , which in SQL drops every row whose
-- college_name IS NULL, because NULL <> 'anything' is NULL and not TRUE. That
-- would silently lose every participant who never filled the field in. The null
-- case is OR-ed in explicitly; see the predicate for the full argument.
-- =============================================================================

-- The signature this SUPERSEDES: eight parameters. It is the one that has to go,
-- and naming it precisely matters — Postgres resolves an overloaded call by
-- argument count, so a drop written against the wrong arity leaves the old
-- function alive beside the new one and every export then fails with
-- "function ... is not unique". The first draft of this file dropped the NEW
-- nine-parameter signature instead, which exists for no reason and silently
-- achieved nothing.
drop function if exists public.staff_export_registrations(date, date, text, text, text, text, text, text);

-- or replace rather than create: this migration is meant to be re-runnable, and a
-- bare `create` fails the second time with "function already exists" — which is
-- how a half-applied migration becomes a manual problem.
create or replace function public.staff_export_registrations(
  p_from_date   date default null,
  p_to_date     date default null,
  p_event       text default null,
  p_status      text default null,
  p_college     text default null,
  p_year        text default null,
  p_department  text default null,
  p_method      text default null,          -- 'cash' | 'utr' | null/'all'
  p_exclude_college text default null       -- the one college to LEAVE OUT
)
returns table(
  si_no bigint,
  name text,
  phone_number text,
  payment_method text,
  utr_number text,
  reg_date date,
  reg_time time without time zone,
  email text,
  college_name text,
  roll_number text,
  year text,
  department text,
  payment_status text,
  purchase_label text,
  purchase_amount integer,
  events text,
  team_name text,
  free_fire_id text,
  selection_frozen boolean,
  frozen_by text,
  created_at_utc timestamp with time zone
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
       -- THE EXCLUSION. "Show me everybody who is NOT from this college" is a
       -- question the roster could not be asked before, and it is the one an
       -- operations lead asks when reconciling: the host institution is handled
       -- on its own line, so the sheet under discussion must contain everyone
       -- else. Without it the only route was exporting everything and deleting
       -- rows by hand, which is how a payment goes missing.
       --
       -- btrim on BOTH sides, exactly as p_college above, so a trailing space
       -- cannot let the excluded college survive the filter.
       --
       -- `r.college_name is null` is OR-ed in DELIBERATELY. In SQL,
       -- NULL <> 'VEMU' evaluates to NULL rather than TRUE, so a bare
       -- btrim(college_name) <> ... would silently DROP every participant who
       -- never filled the field in. An exclusion filter that quietly loses rows
       -- is worse than no filter at all: the count on screen and the spreadsheet
       -- would disagree, and nobody notices until a payment goes missing.
       -- Three-valued logic, used deliberately against ourselves here.
       and (p_exclude_college is null or p_exclude_college = 'all'
            or r.college_name is null
            or btrim(r.college_name) <> btrim(p_exclude_college))
       and (p_department is null or p_department = 'all'
            or btrim(r.department) = btrim(p_department))
       and (p_year       is null or p_year       = 'all'
            or r.year = p_year)
       -- THE NEW ONE. Compared raw and unquoted, because payment_method is a
       -- closed two-value set held by chk_registrations_payment_method - there is
       -- no whitespace or spelling variation to forgive here, and the column is
       -- written by addRegistration, never typed by a participant.
       and (p_method is null or p_method = 'all' or r.payment_method = p_method)
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

comment on function public.staff_export_registrations(date, date, text, text, text, text, text, text, text) is
  'Filtered, numbered roster for the Excel sheet, obeying EXACTLY the filters the roster on screen is showing - event, status, date window, college, department, year, how the money arrived, and the college to EXCLUDE. The exclusion is why this signature changed again: an operations lead reconciling a fest needs the sheet WITHOUT the host college, and an export that ignored the exclusion would hand them a file containing it. The payment-method filter spans statuses on purpose: ''cash'' returns awaiting_cash AND verified cash rows together, because a cash float is counted against every cash payment, not only against the ones the desk has not reached yet. payment_method and team_name are in the sheet so a reconciler can tell a cash payment from a cleared reference and see which squad a leader brought. staff_at_least(coordinator) is the only gate; 50,000-row cap.';

-- Re-issued because the DROP above took the old function''s grants with it.
grant  execute on function public.staff_export_registrations(date, date, text, text, text, text, text, text, text) to anon;
revoke execute on function public.staff_export_registrations(date, date, text, text, text, text, text, text, text) from public;
-- =============================================================================
-- NEXUS - the roster can filter by how the money arrived, and the sheet agrees
-- Migration : 20260927000036_roster_payment_method_filter.sql
-- Purpose   : Add a payment-method filter to the operations roster AND to the
--             export that roster downloads, so "every cash payment" is one
--             click and the sheet matches the screen.
--
-- WHY THE FILTER IS A NEW PARAMETER AND NOT TWO MORE STATUSES
--
-- The roster already had an `awaiting_cash` status, which looks like it should
-- be enough. It is not, and the reason is the shape of the question. A cash
-- registration is `awaiting_cash` until somebody takes the money and `verified`
-- afterwards, so "every cash registration" spans BOTH. A status filter cannot
-- express a span: every value in it means exactly one stage.
--
-- The alternative - inventing `verified_cash`, or a boolean - would split one
-- population into two and make "how many cash registrations are there?" depend
-- on which screen you counted it from. Worse, it would put a payment fact in a
-- LIFECYCLE enum, which is what migration ...026 already had to unpick once.
-- payment_method already says it, correctly, on the row.
--
-- WHY THE EXPORT IS IN THIS FILE AT ALL
--
-- Because the export is what reconciles money, and a roster filter the sheet
-- ignores is exactly the bug the console''s own comment at exportRoster() warns
-- about: "exporting everything while the screen showed one college is the kind
-- of mistake that reconciles a payment sheet against the wrong people and is
-- not noticed until the money does not add up." Adding the filter to the roster
-- without adding it here would create that bug rather than fix one.
--
-- WHY DROP THEN CREATE
--
-- Adding an input parameter changes the function''s identity, so CREATE OR
-- REPLACE is refused outright (it can only change the BODY). The DROP takes the
-- GRANT with it, which is why the grant is re-issued at the bottom - forgetting
-- that is how a function ends up existing and answering 401 to everyone.
-- Migration ...027 describes the identical situation.
--
-- The body is otherwise byte-identical to ...032''s: same OUT columns, same
-- ordering, same 50,000-row bound, same btrim forgiveness. The sheet ALREADY
-- carried a payment_method column; it simply could not be filtered on.
--
-- Idempotent: drop-if-exists, then create.
-- =============================================================================

drop function if exists public.staff_export_registrations(date, date, text, text, text, text, text);

create function public.staff_export_registrations(
  p_from_date   date default null,
  p_to_date     date default null,
  p_event       text default null,
  p_status      text default null,
  p_college     text default null,
  p_year        text default null,
  p_department  text default null,
  p_method      text default null   -- 'cash' | 'utr' | null/'all'
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

comment on function public.staff_export_registrations(date, date, text, text, text, text, text, text) is
  'Filtered, numbered roster for the Excel sheet, obeying EXACTLY the filters the roster on screen is showing - event, status, date window, college, department, year, and how the money arrived. The payment-method filter spans statuses on purpose: ''cash'' returns awaiting_cash AND verified cash rows together, because a cash float is counted against every cash payment, not only against the ones the desk has not reached yet. payment_method and team_name are in the sheet so a reconciler can tell a cash payment from a cleared reference and see which squad a leader brought. staff_at_least(coordinator) is the only gate; 50,000-row cap.';

-- Re-issued because the DROP above took the old function''s grants with it.
grant  execute on function public.staff_export_registrations(date, date, text, text, text, text, text, text) to anon;
revoke execute on function public.staff_export_registrations(date, date, text, text, text, text, text, text) from public;
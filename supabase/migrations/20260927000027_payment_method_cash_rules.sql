-- =============================================================================
-- NEXUS - the rules that read the cash method
-- Migration : 20260927000027_payment_method_cash_rules.sql
-- Purpose   : Teach the five places that already validate a UTR that a cash
--             registration is a legitimate shape, and put cash on the two
--             operator-facing reads.
--
-- WHY FIVE PLACES, AND WHY IT MATTERS
--
-- A UTR registration is described by an invariant that is asserted in more than
-- one place, on purpose - RLS narrows rows, a CHECK narrows columns, and a
-- trigger catches the writer that is neither:
--
--   1. chk_registrations_utr_state              the table
--   2. participant_insert_own_registration      the INSERT policy WITH CHECK
--   3. participant_add_own_events               the selection policies
--   4. participant_remove_own_events            the selection policies
--   5. staff_export_registrations               the sheet a reconciler reads
--
-- Updating one and not the others is the failure mode this file exists to
-- avoid, and it is a silent one: a cash participant who registers for a BUNDLE
-- would sail through the insert and then be refused at the selection step by a
-- policy that still only knows about UTR states - a failure after the row
-- exists, on a screen that has no explanation for it.
--
-- WHY THE UPDATE GUARD IS NOT TOUCHED
--
-- trg_registrations_guard_update's participant branch restricts which statuses
-- a participant may set, and 'awaiting_cash' is not in it. That is CORRECT here:
-- the method is chosen once, when the registration is created, and a
-- participant cannot flip a row from cash to UTR (or the reverse) after the
-- fact. Rewriting a security trigger to widen a state machine is exactly the
-- change that is meant to be obviously safe and is not, so the narrower
-- behaviour is kept deliberately - the method is decided at signup, and a
-- participant who picked wrong asks the operations team.
--
-- WHY staff_export_registrations IS DROPPED, NOT REPLACED
--
-- It gains a column, which changes the declared return type, and Postgres
-- refuses CREATE OR REPLACE for that outright. The DROP also takes the GRANT
-- with it, so both are re-issued below - forgetting the re-grant produces a
-- function that exists and answers 401 to everyone.
--
-- Idempotent: drop-constraint-if-exists, drop-policy-if-exists, drop-function-
-- if-exists + create.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. the table invariant
-- ---------------------------------------------------------------------------
-- The rule it replaces, restated: a UTR row has no reference until it is
-- awaiting one, and a reference from then on. cash has the mirror image - a
-- reference NEVER, because the money has not moved yet and there is nothing to
-- reference.

alter table public.registrations
  drop constraint if exists chk_registrations_utr_state;

alter table public.registrations
  add constraint chk_registrations_utr_state
    check (
      (payment_method = 'utr'
         and ((payment_status = 'awaiting_utr'     and utr_number is null)
           or (payment_status in ('unverified', 'verified', 'rejected')
               and utr_number is not null)))
      or
      (payment_method = 'cash'
         and utr_number is null
         and payment_status in ('awaiting_cash', 'unverified', 'verified', 'rejected'))
    );

comment on constraint chk_registrations_utr_state on public.registrations is
  'A UTR row has no reference while it is awaiting one and a reference from then on. A cash row NEVER has a reference - the money has not moved - and may sit in awaiting_cash, or be verified or rejected by the operations team when it is handed over at the desk.';

-- ---------------------------------------------------------------------------
-- 2. the INSERT policy
-- ---------------------------------------------------------------------------
-- Split by method rather than by status alone. Before this, the policy could
-- not tell "registered, nothing due" (free event) from "registered, money due
-- at the desk" (cash): both are a row with no reference, and only the new
-- method column tells them apart.

drop policy if exists participant_insert_own_registration on public.registrations;
create policy participant_insert_own_registration
  on public.registrations
  for insert
  to authenticated
  with check (
    user_id = auth.uid()
    and (
         -- UTR paid flow: the reference was captured at signup and is waiting
         -- for the operations team to check it against the bank.
         (payment_method = 'utr' and payment_status = 'unverified'
            and utr_number is not null)
      or -- Free entry, or a paid one the participant has not paid yet.
         (payment_method = 'utr' and payment_status = 'awaiting_utr'
            and utr_number is null)
      or -- Cash: money due at the desk. No reference, and none may be sent -
         -- a row claiming to have been paid electronically is the one mistake
         -- this branch exists to refuse.
         (payment_method = 'cash' and payment_status = 'awaiting_cash'
            and utr_number is null)
    )
  );

-- ---------------------------------------------------------------------------
-- 3. the selection policies
-- ---------------------------------------------------------------------------
-- registration_events is what a BUNDLE purchase writes, and a cash bundle
-- registration sits in awaiting_cash from the moment it is created. Without
-- 'awaiting_cash' in these two policies the bundle flow would insert its row
-- fine and then be refused at the selection step - after the row exists, on a
-- screen with no way to explain the failure.

drop policy if exists participant_add_own_events on public.registration_events;
create policy participant_add_own_events
  on public.registration_events
  for insert
  to authenticated
  with check (
    exists (
      select 1 from public.registrations r
       where r.id = registration_id
         and r.user_id = auth.uid()
         and r.payment_status in ('awaiting_utr', 'awaiting_cash',
                                  'unverified', 'rejected')
    )
  );

drop policy if exists participant_remove_own_events on public.registration_events;
create policy participant_remove_own_events
  on public.registration_events
  for delete
  to authenticated
  using (
    exists (
      select 1 from public.registrations r
       where r.id = registration_id
         and r.user_id = auth.uid()
         and r.payment_status in ('awaiting_utr', 'awaiting_cash',
                                  'unverified', 'rejected')
    )
  );

comment on policy participant_add_own_events on public.registration_events is
  'A participant may join an event to their own registration while the payment is still open - which now includes awaiting_cash, because a cash bundle has to reach its selection step exactly as a UTR one does.';

-- ---------------------------------------------------------------------------
-- 4. the money, split by how it arrives
-- ---------------------------------------------------------------------------
-- The reconciliation split gains a bucket, and it is the one an operator
-- actually asks for: "how much is coming to the desk today?" is a different
-- question from "how much is waiting on a bank reference", and folding the two
-- together is how a cash float goes unaccounted for.

create or replace function public.staff_finance_summary ()
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
    'to_verify', jsonb_build_object(
      'count', (select count(*) from public.registrations
                 where payment_status = 'unverified' and payment_method = 'utr'),
      'amount', (select coalesce(sum(purchase_amount), 0) from public.registrations
                  where payment_status = 'unverified' and payment_method = 'utr')),
    -- Money that will be handed over in a room rather than checked against a
    -- bank. Verified, so it counts as RECEIVED - the cash is in the drawer.
    'received', jsonb_build_object(
      'count', (select count(*) from public.registrations
                 where payment_status = 'verified'),
      'amount', (select coalesce(sum(purchase_amount), 0) from public.registrations
                  where payment_status = 'verified')),
    'awaiting_utr', jsonb_build_object(
      'count', (select count(*) from public.registrations
                 where payment_status = 'awaiting_utr'),
      'amount', (select coalesce(sum(purchase_amount), 0) from public.registrations
                  where payment_status = 'awaiting_utr')),
    'awaiting_cash', jsonb_build_object(
      'count', (select count(*) from public.registrations
                 where payment_status = 'awaiting_cash'),
      'amount', (select coalesce(sum(purchase_amount), 0) from public.registrations
                  where payment_status = 'awaiting_cash')),
    'rejected', (select count(*) from public.registrations
                  where payment_status = 'rejected'),
    -- Split by method as well, because "verified" is not one number: what has
    -- cleared a bank check and what is in the cash box are reconciled by
    -- different people against different records.
    'received_utr', (select coalesce(sum(purchase_amount), 0) from public.registrations
                      where payment_status = 'verified' and payment_method = 'utr'),
    'received_cash', (select coalesce(sum(purchase_amount), 0) from public.registrations
                       where payment_status = 'verified' and payment_method = 'cash'),
    'unpriced', (select count(*) from public.registrations
                  where purchase_amount is null
                    and payment_status in ('unverified', 'verified'))
  );
end;
$$;

comment on function public.staff_finance_summary() is
  'Coordinator+. The reconciliation split: to_verify (UTR referenced, not yet checked), received (verified, reported separately for UTR and cash because the two are reconciled by different people), awaiting_utr, awaiting_cash (money due at the desk), rejected, and unpriced - rows whose amount is NULL because no price was set, reported rather than counted as zero.';


-- ---------------------------------------------------------------------------
-- 5. the sheet a reconciler actually reads
-- ---------------------------------------------------------------------------
-- payment_method sits next to payment_status, not at the end, because the first
-- question about a row is "how is this one being paid?" and a column that
-- requires horizontal scrolling answers it last. The sheet is built from this
-- signature, so a new column here IS a new column in the export.

drop function if exists public.staff_export_registrations(date, date, text, text);

create or replace function public.staff_export_registrations (
  p_from_date date default null,
  p_to_date   date default null,
  p_event     text default null,
  p_status    text default null
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
           r.free_fire_id,
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
  -- (42702) rather than picking one. `payment_method` is a new OUT parameter and
  -- carries the same hazard.
  select row_number() over (order by f.created_at asc, f.name asc),
         f.name, f.phone_number, f.payment_method, f.utr_number,
         (f.created_at at time zone 'Asia/Kolkata')::date,
         (f.created_at at time zone 'Asia/Kolkata')::time,
         f.email, f.college_name, f.roll_number, f.year, f.department,
         f.payment_status, f.purchase_label, f.purchase_amount, f.events,
         f.free_fire_id,
         f.selection_frozen, f.selection_frozen_by,
         f.created_at
    from filtered f;
end;
$$;

comment on function public.staff_export_registrations is
  'Filtered, numbered roster for the Excel sheet. Takes plain CALENDAR dates and turns them into Asia/Kolkata day windows itself; both ends inclusive. Carries payment_method beside payment_status so a cash float can be reconciled separately from money cleared by bank reference, and selection_frozen so a reconciler can tell a final selection from an open one. staff_at_least(coordinator) is the only gate; 50,000-row cap.';

grant execute on function public.staff_export_registrations(date, date, text, text) to anon;
revoke execute on function public.staff_export_registrations(date, date, text, text) from authenticated, public;

-- ---------------------------------------------------------------------------
-- 6. a shape the console can rely on
-- ---------------------------------------------------------------------------
-- public_catalogue is untouched by this file: the method is a property of a
-- PAYMENT, not of an event, and it is chosen per registration. An operator
-- enabling cash does it here, by the fact that the wizard offers it, not by
-- switching a per-event flag on.


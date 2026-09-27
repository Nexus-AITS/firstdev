-- Phase 5 — event selection, roster date/event filters, and the export source.
--
-- Three asks land here, and they share one missing piece: a real relation
-- between a registration and the events it covers.
--
-- Today `registrations` carries `purchase_type` + `purchase_label`, which is
-- free text. "Filter the roster by event" is therefore not answerable from the
-- schema, and a participant cannot express "this bundle plus those two events"
-- either. Everything below is built on `registration_events`.
--
--   event_id is TEXT, deliberately, not a uuid foreign key. The events
--   themselves live in src/data/events.js and prices in public.pricing
--   (ref_id text), so an FK would need a second source of truth for the very
--   thing this column points at. Because the roster only ever FILTERS on this
--   column, the only cost is that a typo is possible — introduced by staff edit,
--   never by a participant, and rejected by the writer below.
--
-- `purchase_amount` is new and fixes a display bug on the way: Admin.jsx has
-- always rendered `r.purchase_amount`, but the column has never existed, so
-- that line silently showed nothing. There was also no persisted amount
-- anywhere — the UPI figure was computed in the browser from the price store,
-- so nothing in the database could be exported or audited. The amount is now
-- written by the database from public.pricing, which is also what makes the
-- selection page safe: a browser cannot name its own price, because it never
-- supplies one.

-- ============================================================================
-- 1. the selection table
-- ============================================================================

create table if not exists public.registration_events (
  registration_id uuid        not null references public.registrations (id) on delete cascade,
  event_id       text        not null,
  created_at     timestamptz not null default now(),
  constraint pk_registration_events primary key (registration_id, event_id)
);

comment on table public.registration_events is
  'The events a registration covers. A registration may select several; the FK cascade means removing a registration removes its selections.';

-- Filtering the roster by event reads every registration carrying that event,
-- so the event_id must lead the index.
create index if not exists idx_registration_events_event
  on public.registration_events (event_id, registration_id);

-- ============================================================================
-- 2. the persisted amount
-- ============================================================================

alter table public.registrations
  add column if not exists purchase_amount integer;

alter table public.registrations
  drop constraint if exists chk_registrations_purchase_amount;

alter table public.registrations
  add constraint chk_registrations_purchase_amount
  check (purchase_amount is null or purchase_amount >= 0);

comment on column public.registrations.purchase_amount is
  'Total the participant pays, in whole rupees, written by registration_set_events() from public.pricing. NULL on rows created before this migration: the amount was never stored, and backfilling a guess would put an invented number in front of an operator and into the payment sheet.';

-- ============================================================================
-- 3. RLS on the selection table
-- ============================================================================
--
-- Same three-way split as registrations itself: a participant owns their own
-- selections, staff read every one, anon gets nothing.

alter table public.registration_events enable row level security;

-- Staff read. Wrapped in a scalar subquery so Postgres evaluates the session
-- lookup once per statement rather than once per row — the same fix as
-- migration ...0005, and for the same measured reason.
drop policy if exists staff_read_registration_events on public.registration_events;
create policy staff_read_registration_events
  on public.registration_events
  for select
  to anon
  using ((select public.staff_at_least('coordinator')));

-- A participant may read their own selections, and add or remove one, but ONLY
-- while the payment is still open. Once a row is verified the purchase is
-- settled and the selection becomes a historical record: editing it afterwards
-- would let someone change what they are recorded as having paid for.
drop policy if exists participant_read_own_events on public.registration_events;
create policy participant_read_own_events
  on public.registration_events
  for select
  to authenticated
  using (
    exists (
      select 1 from public.registrations r
       where r.id = registration_id
         and r.user_id = auth.uid()
    )
  );

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
         and r.payment_status in ('awaiting_utr', 'unverified', 'rejected')
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
         and r.payment_status in ('awaiting_utr', 'unverified', 'rejected')
    )
  );

-- RLS narrows, it does not grant: anon/authenticated need table privileges too,
-- or these policies are never reached.
grant select, insert, delete on public.registration_events to authenticated;
grant select on public.registration_events to anon;
-- Staff have no write path on selections. If an operator needs to change what
-- someone is recorded as having bought, the correction belongs on the
-- registration row (which is audited), not on a side table with no history.
revoke insert, update, delete on public.registration_events from anon;

-- ============================================================================
-- 4. the selection writer — the database owns the price
-- ============================================================================
--
-- The participant submits a bundle id and a list of event ids. They never
-- submit an amount: the total is summed from public.pricing inside this
-- function, so a tampered client cannot decide what it owes. Everything is
-- schema-qualified and search_path is pinned empty, so a caller-controlled
-- search_path cannot redirect a name to a different object.

create or replace function public.registration_set_events (
  p_registration_id uuid,
  p_bundle_id       text default null,
  p_event_ids       text[] default '{}'
)
returns table (registration_id uuid, amount integer, currency text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_status  public.payment_status;
  v_bundle  integer;
  v_events  integer;
  v_known   text[];
  v_reg_id  uuid;
  v_amount  integer;
begin
  -- The caller must be signed in, and this row must be theirs.
  v_user_id := auth.uid();
  if v_user_id is null then
    raise exception 'Sign in before choosing events.' using errcode = '42501';
  end if;

  select r.id, r.payment_status
    into v_reg_id, v_status
    from public.registrations r
   where r.id = p_registration_id
     and r.user_id = v_user_id;

  if not found then
    raise exception 'That registration is not yours.' using errcode = '42501';
  end if;

  -- A verified payment is settled. Re-opening the selection would let someone
  -- change what they are recorded as having paid for after the fact.
  if v_status = 'verified' then
    raise exception 'This payment is already confirmed, so the selection is closed.'
      using errcode = '42501';
  end if;

  -- Reject event ids that do not exist in the live price table, so a typo
  -- cannot be stored and later show up as a phantom zero-rupee line.
  select coalesce(array_agg(p.ref_id order by p.ref_id), '{}')
    into v_known
    from public.pricing p
   where p.kind = 'event'
     and p.is_active
     and p.ref_id = any (coalesce(p_event_ids, '{}'));

  if coalesce(array_length(v_known, 1), 0)
     <> coalesce(array_length(coalesce(p_event_ids, '{}'), 1), 0) then
    raise exception 'One or more of those events is not available.'
      using errcode = '22023';
  end if;

  v_bundle := 0;
  if p_bundle_id is not null then
    select p.price into v_bundle
      from public.pricing p
     where p.kind = 'bundle' and p.ref_id = p_bundle_id and p.is_active;
    if v_bundle is null then
      raise exception 'That bundle is not available.' using errcode = '22023';
    end if;
  end if;

  select coalesce(sum(p.price), 0) into v_events
    from public.pricing p
   where p.kind = 'event'
     and p.is_active
     and p.ref_id = any (v_known);

  v_amount := coalesce(v_bundle, 0) + coalesce(v_events, 0);

  -- Replace the whole selection in one shot. The delete is scoped to this
  -- registration, and the policies above independently re-check ownership.
  delete from public.registration_events re
   where re.registration_id = v_reg_id;

  insert into public.registration_events (registration_id, event_id)
  select v_reg_id, unnest(v_known)
  where cardinality(v_known) > 0;

  -- A single label the console and the export can both read, built from what the
  -- database just priced rather than from anything the browser sent.
  update public.registrations r
     set purchase_type   = case when p_bundle_id is not null then 'bundle' else 'event' end,
         purchase_label  = case
                             when p_bundle_id is not null
                               then p_bundle_id || (case when cardinality(v_known) > 0
                                                        then ' + ' || array_to_string(v_known, ', ')
                                                        else '' end)
                             when cardinality(v_known) > 0 then array_to_string(v_known, ', ')
                             else 'none'
                           end,
         purchase_amount = v_amount,
         updated_at      = now()
   where r.id = v_reg_id;

  return query select v_reg_id, v_amount, 'INR'::text;
end;
$$;

comment on function public.registration_set_events is
  'Replace a registration''s event selection and recompute its total from public.pricing. The browser supplies ids only; the amount is never accepted from the client.';

-- The participant owns the call, so it runs as them for auth.uid() to resolve.
grant execute on function public.registration_set_events(uuid, text, text[]) to authenticated;
revoke execute on function public.registration_set_events(uuid, text, text[]) from anon;

-- ============================================================================
-- 5. the export source
-- ============================================================================
--
-- The export must run in the database, not in the browser. The roster is paged
-- at 25 rows, so a client-side export would silently produce a 25-row file and
-- the operator would reconcile a payment sheet against a quarter of the truth.
--
-- SECURITY DEFINER because it deliberately bypasses the per-row SELECT policy:
-- this is a set-returning read that has already established "is staff" once, and
-- re-checking a session for every row of a 5,000-row export is the exact cost
-- migration ...0005 removed. The staff check below is therefore mandatory and is
-- the ONLY gate — a missing check here would hand the whole roster to anyone who
-- can reach the RPC.
--
-- Dates: the operator filters by the day a registration ARRIVED, which is
-- created_at, in Asia/Kolkata — the event's own timezone. A "day" boundary taken
-- in UTC would cut the day at 05:30 IST and silently drop or duplicate
-- registrations either side of midnight, which is precisely the row someone is
-- chasing when they are looking for a missing payment.

-- The signature is `date, date, text, text`. An earlier revision took
-- timestamptz, so that overload is dropped BEFORE the new one is created —
-- PostgREST resolves an RPC by name and argument count, and two four-argument
-- versions of this name would make every call that passed nulls ambiguous.
drop function if exists public.staff_export_registrations(timestamptz, timestamptz, text, text);

create or replace function public.staff_export_registrations (
  p_from_date date default null,   -- inclusive, whole day, Asia/Kolkata
  p_to_date   date default null,   -- inclusive, whole day, Asia/Kolkata
  p_event     text default null,
  p_status    text default null
)
returns table (
  si_no           bigint,
  name            text,
  phone_number    text,
  utr_number      text,
  reg_date        date,
  reg_time        time,
  email           text,
  college_name    text,
  roll_number     text,
  year            text,
  department      text,
  payment_status  text,
  purchase_label  text,
  purchase_amount integer,
  events          text,
  created_at_utc  timestamptz
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

  -- The UI sends a plain calendar date from a date input, and the CONVERSION to
  -- IST lives here rather than in the browser. An earlier version took
  -- timestamptz and shifted it, which meant the caller had to know that "14 Aug"
  -- is 2026-08-13T18:30Z to mean midnight IST — and an operator picking the 14th
  -- silently got a window starting at 05:30 that morning, dropping every
  -- registration made between midnight and half past five.
  --
  -- Both ends are INCLUSIVE calendar days, so "the 14th" really is the whole
  -- 14th: p_to_date is pushed to the following midnight and used as an
  -- exclusive bound.
  v_from_ist := case
                  when p_from_date is null then null
                  else (p_from_date::text || ' 00:00:00')::timestamp
                         at time zone 'Asia/Kolkata'
                end;
  v_to_ist   := case
                  when p_to_date is null then null
                  else ((p_to_date + 1)::text || ' 00:00:00')::timestamp
                         at time zone 'Asia/Kolkata'
                end;

  return query
  with filtered as (
    select r.id, r.name, r.phone_number, r.utr_number, r.created_at, r.email,
           r.college_name, r.roll_number, r.year, r.department,
           r.payment_status::text, r.purchase_label, r.purchase_amount,
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
     -- denial of service aimed at whoever asked for it. 50,000 rows is far
     -- beyond any single event's roster.
     limit 50000
  )
  -- Every reference here is qualified with `f.` on purpose. RETURNS TABLE
  -- declares OUT parameters named `name`, `phone_number`, `email` and so on, and
  -- an unqualified reference in this select is ambiguous between the OUT
  -- variable and the column of the same name — Postgres rejects that outright
  -- (42702) rather than picking one.
  select row_number() over (order by f.created_at asc, f.name asc),
         f.name, f.phone_number, f.utr_number,
         (f.created_at at time zone 'Asia/Kolkata')::date,
         (f.created_at at time zone 'Asia/Kolkata')::time,
         f.email, f.college_name, f.roll_number, f.year, f.department,
         f.payment_status, f.purchase_label, f.purchase_amount, f.events,
         f.created_at
    from filtered f;
end;
$$;

comment on function public.staff_export_registrations is
  'Filtered, numbered roster for the Excel sheet. Takes plain CALENDAR dates and turns them into Asia/Kolkata day windows itself; both ends inclusive. staff_at_least(coordinator) is the only gate; 50,000-row cap.';

grant execute on function public.staff_export_registrations(date, date, text, text) to anon;
revoke execute on function public.staff_export_registrations(date, date, text, text) from authenticated, public;

-- ============================================================================
-- 6. auth hardening
-- ============================================================================
--
-- `admin_users` was retired in migration ...0004: the Supabase-Auth admin path
-- was dropped so there is exactly ONE way to reach the roster as staff. RLS is
-- enabled and the read policy was dropped with it, so the table denies
-- everything already.
--
-- What was NOT done is remove the table GRANTS. anon and authenticated still
-- hold INSERT/UPDATE/DELETE on a table that is now a tombstone. RLS with no
-- policy denies that today, so this is not a live hole — but it is a loaded
-- gun: the single most consequential line anyone could write on this table is
-- `create policy ... on admin_users`, and with these grants already in place it
-- would take effect immediately and resurrect a retired access path. Revoking
-- the writes makes that mistake fail loudly instead of silently working.
revoke insert, update, delete, truncate on public.admin_users from anon, authenticated;
revoke all on public.admin_users from anon;

-- staff_sessions is reached only through SECURITY DEFINER functions. Assert that
-- rather than trusting that it has always been true.
revoke all on public.staff_sessions from anon, authenticated;
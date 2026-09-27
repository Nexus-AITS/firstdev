-- ---------------------------------------------------------------------------
-- 1. the columns
-- ---------------------------------------------------------------------------
--
-- A bundle is a contract, so once operations are satisfied with what a
-- participant is buying, the answer has to stop moving. Without this the
-- participant can rewrite their selection at any point up to payment
-- verification, which means a roster can disagree with what was on the invoice
-- while someone reconciles it.
--
-- The flag lives on the REGISTRATION rather than as a row in a side table so it
-- travels with the record, is covered by the existing ownership RLS, and is
-- visible in the same query the roster already runs.
--
-- `selection_frozen_at` / `_by` are kept even though `_by` is in the audit log:
-- the roster is read far more often than the audit log, and "who locked this,
-- and when" is the first question anyone asks about a finalised selection.

alter table public.registrations
  add column if not exists selection_frozen    boolean not null default false,
  add column if not exists selection_frozen_at timestamptz,
  add column if not exists selection_frozen_by text;

comment on column public.registrations.selection_frozen is
  'When true the participant can no longer change their event selection. Set by the operations team; only a master can lift it. Blocks registration_set_events().';

comment on column public.registrations.selection_frozen_at is
  'When the selection was frozen. Null while it is open.';

comment on column public.registrations.selection_frozen_by is
  'Staff username that froze or last re-opened the selection.';

-- The roster is filtered and counted constantly, and "which selections are
-- final" is a question an operator asks of the whole set rather than of one
-- row, so the flag leads its own index.
create index if not exists idx_registrations_selection_frozen
  on public.registrations (selection_frozen)
  where selection_frozen;

-- ---------------------------------------------------------------------------
-- 2. a participant must not be able to clear their own freeze
-- ---------------------------------------------------------------------------
--
-- This is the part that is easy to miss. Participants hold UPDATE on their own
-- registration row, and the existing guard in ...0004 only rejects changes to
-- IDENTITY and PAYMENT fields — everything else is a detail they are allowed to
-- correct. A freeze column added without closing this hole would be advisory:
-- one PATCH with their own session sets selection_frozen back to false and the
-- lock is gone, with no audit entry and no staff involvement at all.
--
-- So the three new columns join the protected list, and they are added to the
-- STAFF branch too — an admin editing a name must not be able to silently drop
-- a freeze on the way past.
create or replace function public.guard_registration_update ()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if public.staff_at_least('admin') then
    -- Freezing is the one change the guard does not let staff make by editing
    -- the table: it is only reachable through staff_set_selection_freeze, which
    -- is where the role split (admin may freeze, only a master may lift) and the
    -- audit entry live. Without this an admin could bypass both by UPDATEing the
    -- column directly.
    --
    -- The marker is a transaction-local flag naming the permitted writer, and it
    -- is checked HERE, in the STAFF branch only. That placement is what makes it
    -- safe: a participant calling set_config() for themselves still fails
    -- staff_at_least('admin') above and falls through to the participant branch,
    -- which rejects these columns unconditionally with no marker check at all.
    if new.selection_frozen is distinct from old.selection_frozen
       or new.selection_frozen_at is distinct from old.selection_frozen_at
       or new.selection_frozen_by is distinct from old.selection_frozen_by then
      if coalesce(current_setting('nexus.freeze_write', true), '') <> 'on' then
        raise exception 'registration: use staff_set_selection_freeze() to change the selection freeze'
          using errcode = '42501';
      end if;
    end if;

    if new.payment_status is distinct from old.payment_status
       or new.utr_number is distinct from old.utr_number
       or new.payment_verified_by is distinct from old.payment_verified_by
       or new.name is distinct from old.name then
      perform public.staff_audit(
        'update_registration',
        'registration',
        new.id::text,
        jsonb_build_object(
          'from_status', old.payment_status,
          'to_status',   new.payment_status,
          'from_utr',    old.utr_number,
          'to_utr',      new.utr_number,
          'verified_by', new.payment_verified_by
        )
      );
    end if;
    return new;
  end if;

  -- Otherwise this is a participant editing their own row. They may adopt an
  -- unowned row whose email matches their verified account, and otherwise only
  -- correct details while the payment is not yet verified.
  if old.user_id is null
     and new.user_id is not null
     and new.user_id = auth.uid()
     and lower(btrim(new.email)) = lower(coalesce(auth.jwt() ->> 'email', '')) then
    return new;
  end if;

  if new.id <> old.id
     or new.user_id is distinct from old.user_id
     or new.created_at is distinct from old.created_at
     or new.payment_verified_at is distinct from old.payment_verified_at
     or new.payment_verified_by is distinct from old.payment_verified_by
     or new.selection_frozen is distinct from old.selection_frozen
     or new.selection_frozen_at is distinct from old.selection_frozen_at
     or new.selection_frozen_by is distinct from old.selection_frozen_by then
    raise exception 'registration: only the NEXUS operations team can change identity, payment-verification or event-selection fields'
      using errcode = '42501';
  end if;

  if new.payment_status = 'verified' or old.payment_status = 'verified' then
    raise exception 'registration: payment verification is an operations-team action'
      using errcode = '42501';
  end if;

  if new.payment_status not in ('awaiting_utr', 'unverified', 'rejected') then
    raise exception 'registration: unsupported payment status'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. the operations-team entry point
-- ---------------------------------------------------------------------------
--
-- The role split is the whole point of this function, and it is asymmetric on
-- purpose:
--
--   freeze    needs `admin`  — the same authority as verifying a payment. It is
--                               routine, protective, and reversible by a master.
--   UNFREEZE  needs `master` — a participant who wants their selection re-opened
--                               has to reach a master, exactly as the product
--                               requires. It is the one action that can undo a
--                               decision another role made, so it is the one that
--                               is not delegated.
--
-- Returns { ok, error } rather than raising, for the same reason the catalogue
-- RPCs do: this is called from a roster button, where a readable sentence beats
-- a 500.
create or replace function public.staff_set_selection_freeze (
  p_registration_id uuid,
  p_frozen         boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row     public.registrations;
  v_current boolean;
  v_by      text;
begin
  -- THE gate, and the first statement so a non-staff caller is rejected before
  -- anything else is evaluated.
  if not public.staff_at_least('coordinator') then
    return jsonb_build_object('ok', false, 'error', 'Staff access is required.');
  end if;

  select r.* into v_row
    from public.registrations r
   where r.id = p_registration_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'That registration no longer exists.');
  end if;

  v_current := v_row.selection_frozen;
  if v_current = coalesce(p_frozen, false) then
    -- Idempotent no-op, reported as success. Without this a double-click on the
    -- button would write a second audit entry saying nothing changed, and an
    -- operator reading the log would learn nothing from it.
    return jsonb_build_object('ok', true, 'frozen', v_current, 'changed', false);
  end if;

  if p_frozen then
    if not public.staff_at_least('admin') then
      return jsonb_build_object('ok', false,
        'error', 'Only an administrator or a master can freeze an event selection.');
    end if;
  elsif not public.staff_at_least('master') then
    return jsonb_build_object('ok', false,
      'error', 'Only a master administrator can re-open a frozen selection. Pass the request to them.');
  end if;

  select s.username into v_by from public.staff_session() s;

  perform public.staff_audit(
    case when p_frozen then 'freeze_selection' else 'unfreeze_selection' end,
    'registration',
    p_registration_id::text,
    jsonb_build_object('frozen', coalesce(p_frozen, false), 'by', v_by, 'previous', v_current)
  );

  -- Written AFTER the audit, and through the table so the guard trigger still
  -- runs. The marker is what tells the guard this is the permitted writer; it is
  -- transaction-local, so it is discarded automatically and cannot leak into a
  -- later request on the same connection.
  perform set_config('nexus.freeze_write', 'on', true);

  update public.registrations r
     set selection_frozen    = p_frozen,
         selection_frozen_at = case when p_frozen then now() else null end,
         selection_frozen_by = case when p_frozen then v_by else null end,
         updated_at          = now()
   where r.id = p_registration_id;

  return jsonb_build_object('ok', true, 'frozen', coalesce(p_frozen, false), 'changed', true);
end;
$$;

comment on function public.staff_set_selection_freeze(uuid, boolean) is
  'Freeze or re-open a registration''s event selection. Freezing needs admin; re-opening needs master. Audited both ways, and the only writer permitted to touch registrations.selection_frozen.';

grant  execute on function public.staff_set_selection_freeze(uuid, boolean) to anon;
revoke execute on function public.staff_set_selection_freeze(uuid, boolean) from authenticated, public;

-- ---------------------------------------------------------------------------
-- 4. registration_set_events respects the freeze
-- ---------------------------------------------------------------------------
--
-- Re-declared in full because the signature is unchanged and CREATE OR REPLACE
-- cannot swap a body without every line of it being restated. The behaviour is
-- otherwise identical to ...0007 — same validation, same pricing, same label —
-- and only the one guard below is new.
--
-- The freeze check sits IMMEDIATELY after the ownership check, for two reasons.
-- It must come after ownership, or the error would tell an anonymous caller
-- whether some stranger's registration happens to be frozen. And it is worded as
-- its own message because it is the one failure a participant can hit after
-- doing everything right: they paid, they picked, and operations have since
-- closed the selection. "Contact the operations team" is the whole of what they
-- can usefully be told.
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
  v_user_id uuid;
  v_status  public.payment_status;
  v_frozen  boolean;
  v_reg_id  uuid;
  v_bundle  integer;
  v_events  integer;
  v_known   text[];
  v_amount  integer;
  v_errors  text[];
  v_titles  text;
begin
  -- The caller must be signed in, and this row must be theirs.
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

  -- THE FREEZE. Checked before anything is written, so a refused attempt leaves
  -- the existing selection exactly as it was.
  if v_frozen then
    raise exception 'Your event selection is final. Contact the operations team to change it.'
      using errcode = '42501';
  end if;

  -- A verified payment is settled. Re-opening the selection would let someone
  -- change what they are recorded as having paid for after the fact.
  if v_status = 'verified' then
    raise exception 'This payment is already confirmed, so the selection is closed.'
      using errcode = '42501';
  end if;

  -- Reject event ids that are not live catalogue entries, so a typo cannot be
  -- stored and later show up as a phantom line on the roster.
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
       and p.is_active and b.is_active;

    if v_bundle is null then
      raise exception 'That bundle is not available.' using errcode = '22023';
    end if;

    -- The rule, applied. A bundle is a contract, so an illegal selection is
    -- refused outright rather than quietly priced at the bundle rate.
    v_errors := public.bundle_selection_errors(p_bundle_id, v_known);
    if coalesce(array_length(v_errors, 1), 0) > 0 then
      raise exception '%', array_to_string(v_errors, ' ')
        using errcode = '22023';
    end if;

    -- The bundle price IS the total. The events are what it buys. This is the
    -- discount the whole pricing model rests on: the components cost more
    -- individually than the bundle does, so buying the bundle is cheaper for
    -- someone who was going to take several events anyway.
    v_amount := v_bundle;
  else
    if coalesce(array_length(v_known, 1), 0) = 0 then
      raise exception 'Choose at least one event.' using errcode = '22023';
    end if;

    select coalesce(sum(p.price), 0) into v_events
      from public.pricing p
     where p.kind = 'event'
       and p.is_active
       and p.ref_id = any (v_known);

    v_amount := coalesce(v_events, 0);
  end if;

  -- Human-readable label built from the CATALOGUE titles, not from ids, and not
  -- from anything the browser sent.
  select coalesce(string_agg(ec.title, ', ' order by ec.sort_order, ec.id), '')
    into v_titles
    from public.event_catalogue ec
   where ec.id = any (v_known);

  -- Replace the whole selection in one shot. The delete is scoped to this
  -- registration, and the policies independently re-check ownership.
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
  'Replace a registration''s event selection. Refused once the selection is frozen or the payment is verified. With a bundle, the selection is validated against the bundle''s include lines and the bundle price is the TOTAL; without one, the chosen events are summed from public.pricing. The browser supplies ids only; the amount is never accepted from the client.';

grant execute on function public.registration_set_events(uuid, text, text[]) to authenticated;
revoke execute on function public.registration_set_events(uuid, text, text[]) from anon;

-- ---------------------------------------------------------------------------
-- 5. the export says which selections are final
-- ---------------------------------------------------------------------------
--
-- The spreadsheet is the artefact that leaves this building. Someone reconciles
-- a UTR against it days later, and "is this still changeable?" is a fair
-- question to be unable to answer from the file. A frozen row is exactly the row
-- where a reconciler must not go asking the participant to confirm, because the
-- answer is no.
--
-- This needs DROP + CREATE rather than CREATE OR REPLACE: adding a column
-- changes the function's declared return type, and Postgres rejects that on
-- replace outright (cannot change return type of existing function). Dropping
-- also drops the GRANT, so it is re-issued below — a detail worth stating,
-- because forgetting it produces a function that exists and answers 401 to
-- everyone.
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
           r.payment_status::text, r.purchase_label, r.purchase_amount,
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
  -- variable and the column of the same name — Postgres rejects that outright
  -- (42702) rather than picking one.
  select row_number() over (order by f.created_at asc, f.name asc),
         f.name, f.phone_number, f.utr_number,
         (f.created_at at time zone 'Asia/Kolkata')::date,
         (f.created_at at time zone 'Asia/Kolkata')::time,
         f.email, f.college_name, f.roll_number, f.year, f.department,
         f.payment_status, f.purchase_label, f.purchase_amount, f.events,
         f.selection_frozen, f.selection_frozen_by,
         f.created_at
    from filtered f;
end;
$$;

comment on function public.staff_export_registrations is
  'Filtered, numbered roster for the Excel sheet. Takes plain CALENDAR dates and turns them into Asia/Kolkata day windows itself; both ends inclusive. Carries selection_frozen so a reconciler can tell a final selection from an open one. staff_at_least(coordinator) is the only gate; 50,000-row cap.';

grant execute on function public.staff_export_registrations(date, date, text, text) to anon;
revoke execute on function public.staff_export_registrations(date, date, text, text) from authenticated, public;

-- Migration : 20260927000024_lookups_finance_event_roster.sql
-- Purpose   : Colleges and departments as DATA rather than free text, the money
--             the operations team is waiting on, and the list of people behind
--             an event's registration count.
--
-- Four things that are all the same shape of problem: a number or a list the
-- console needs, currently either absent, or assembled by the browser from
-- whatever a participant happened to type.
--
-- 1. colleges / departments
--    "AITS Tirupati", "AITS Tirupati " and "aits tirupati" were three spellings
--    of one college, and a pivot by college_name split them three ways. They are
--    rows now, unique on their NORMALISED name, seeded from the registrations
--    that already exist so nothing is lost, and offered by the registration form
--    as a dropdown. An operator adds to them from the console, so a new
--    department does not need a developer and a deploy.
--
-- 2. staff_finance_summary()
--    "Total to be verified" and "total received" were answerable only by
--    downloading the roster and totalling a column by hand. The two figures are
--    different on purpose and easy to confuse: RECEIVED is verified money,
--    TO VERIFY is money referenced but not yet checked against the bank.
--
-- 3. staff_list_event_registrations()
--    The number on every event card came from event_registered_count() with no
--    way to see WHO. An operator asking "how many?" and then "who are they?" had
--    to open the roster and filter by hand, and could not tell who had PAID from
--    who had merely started.
--
-- Every function is staff-gated in the body, like the rest of the console
-- surface. public_lookups is the deliberate exception: the registration form
-- renders for a signed-out visitor, and it is two short lists of institution
-- names - nothing personal, nothing financial.

-- ---------------------------------------------------------------------------
-- 1. colleges and departments
-- ---------------------------------------------------------------------------
create table if not exists public.colleges (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.departments (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.colleges is
  'Colleges a participant may register from. Uniqueness is on the NORMALISED name (lower + btrim), so "AITS Tirupati" and "aits tirupati " cannot both exist - which is exactly the split-by-spelling this table exists to stop.';
comment on table public.departments is
  'Departments a participant may register from. Normalised-unique for the same reason as colleges.';

-- Normalised uniqueness. Without the expression index the table would happily
-- hold three spellings of one college, and the roster would then report three
-- colleges where the operations team know of one.
create unique index if not exists uq_colleges_name
  on public.colleges (lower(btrim(name)));
create unique index if not exists uq_departments_name
  on public.departments (lower(btrim(name)));

-- Seeded from the registrations that already exist, so the dropdown opens with
-- the real college rather than an empty box on the first day. Anything a
-- participant typed that is not in a table stays perfectly readable in the
-- roster; this only proposes it as a choice from now on.
insert into public.colleges (name)
select distinct btrim(r.college_name)
  from public.registrations r
 where btrim(coalesce(r.college_name, '')) <> ''
on conflict do nothing;

insert into public.departments (name)
select distinct btrim(r.department)
  from public.registrations r
 where btrim(coalesce(r.department, '')) <> ''
on conflict do nothing;

-- The registration form is rendered for a signed-out visitor, so this one read
-- is public by design. Everything financial or personal stays behind the staff
-- gate.
revoke all on public.colleges from anon, authenticated;
revoke all on public.departments from anon, authenticated;
grant select on public.colleges to anon, authenticated;
grant select on public.departments to anon, authenticated;

create or replace function public.public_lookups ()
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'ok', true,
    'colleges', coalesce((
      select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name) order by c.name)
        from public.colleges c where c.is_active), '[]'::jsonb),
    'departments', coalesce((
      select jsonb_agg(jsonb_build_object('id', d.id, 'name', d.name) order by d.name)
        from public.departments d where d.is_active), '[]'::jsonb)
  );
$$;

comment on function public.public_lookups() is
  'The active colleges and departments, for the registration form dropdowns. Public because the form renders for a signed-out visitor: two lists of institution names, nothing personal and nothing financial.';


-- ---------------------------------------------------------------------------
-- 2. staff CRUD for the lookups
-- ---------------------------------------------------------------------------
-- One pair of functions for both tables rather than four near-identical ones: the
-- difference between them is a table NAME, and two copies of the same validation
-- is two places for the rules to drift. `p_kind` is checked against a whitelist
-- and the table name is assembled from it, so it is never a way to reach an
-- arbitrary table.
create or replace function public.staff_upsert_lookup (
  p_kind text,
  p_name text,
  p_id   uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_table text;
  v_name  text;
  v_id    uuid;
begin
  if not public.staff_at_least('admin') then
    return jsonb_build_object('ok', false,
      'error', 'Only an administrator or a master can change the college and department lists.');
  end if;

  v_table := case p_kind
    when 'college' then 'colleges'
    when 'department' then 'departments'
    else null
  end;
  if v_table is null then
    return jsonb_build_object('ok', false, 'error', 'Unknown list.');
  end if;

  v_name := btrim(coalesce(p_name, ''));
  if char_length(v_name) < 2 or char_length(v_name) > 120 then
    return jsonb_build_object('ok', false,
      'error', 'Give it between 2 and 120 characters.');
  end if;

  -- Re-activating by name is the common case: the list is short, and a master
  -- adding "CSE" to a list that already retired it should get the same row back
  -- rather than a duplicate-key error.
  if p_id is null then
    execute format(
      'update public.%I set is_active = true, updated_at = now()
        where lower(btrim(name)) = lower($1)
        returning id', v_table) into v_id using v_name;
  end if;

  if v_id is null then
    begin
      execute format(
        'insert into public.%I (name) values ($1) returning id', v_table) into v_id
        using v_name;
    exception when unique_violation then
      return jsonb_build_object('ok', false,
        'error', format('"%s" is already on the list.', v_name));
    end;
  else
    execute format(
      'update public.%I set name = $1, is_active = true, updated_at = now() where id = $2', v_table)
      using v_name, v_id;
  end if;

  perform public.staff_audit('upsert_' || p_kind, p_kind, v_id::text,
                             jsonb_build_object('name', v_name));

  return jsonb_build_object('ok', true, 'id', v_id, 'name', v_name);
end;
$$;

create or replace function public.staff_retire_lookup (p_kind text, p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_table text;
begin
  if not public.staff_at_least('admin') then
    return jsonb_build_object('ok', false,
      'error', 'Only an administrator or a master can change the college and department lists.');
  end if;

  v_table := case p_kind
    when 'college' then 'colleges'
    when 'department' then 'departments'
    else null
  end;
  if v_table is null then
    return jsonb_build_object('ok', false, 'error', 'Unknown list.');
  end if;

  -- Retire, never delete. Registrations store the college as TEXT, so removing
  -- the row would not change one existing participant's data - it would only
  -- stop the name being offered again, and lose the record that it ever was.
  -- FOUND is NOT consulted here. It is not reliably set after EXECUTE of an
  -- UPDATE, and trusting it made this function answer "No such entry" for a
  -- retire that had plainly worked - the row went inactive and the operator was
  -- told it had not. A misleading failure is worse than no answer, because it
  -- invites a retry that is already a no-op. So the row is RE-READ after the
  -- write, which is the only thing that can honestly report what happened.
  execute format(
    'update public.%I set is_active = false, updated_at = now() where id = $1', v_table)
    using p_id;

  if not exists (
    select 1 from public.colleges where id = p_id
    union all
    select 1 from public.departments where id = p_id
  ) then
    return jsonb_build_object('ok', false, 'error', 'No such entry.');
  end if;

  perform public.staff_audit('retire_' || p_kind, p_kind, p_id::text, null);
  return jsonb_build_object('ok', true, 'id', p_id);
end;
$$;

create or replace function public.staff_list_lookups ()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.staff_at_least('coordinator') then
    return jsonb_build_object('ok', false, 'error', 'Not authorised.');
  end if;
  -- ALL rows, retired included. The console needs those to show what is switched
  -- off and to offer it back; public_lookups() is the trimmed read for the form.
  return jsonb_build_object(
    'ok', true,
    'colleges', coalesce((
      select jsonb_agg(to_jsonb(c) - 'created_at' - 'updated_at'
                       order by c.is_active desc, c.name)
        from public.colleges c), '[]'::jsonb),
    'departments', coalesce((
      select jsonb_agg(to_jsonb(d) - 'created_at' - 'updated_at'
                       order by d.is_active desc, d.name)
        from public.departments d), '[]'::jsonb)
  );
end;
$$;

comment on function public.staff_upsert_lookup(text, text, uuid) is
  'Admin+. Adds or re-activates a college or department, matched case-insensitively so a re-typed name updates the existing row instead of colliding with it.';
comment on function public.staff_retire_lookup(text, uuid) is
  'Admin+. Retires a college or department. Never deletes: registrations store the name as text, so a deleted row would change no existing participant and would only lose the record that the option ever existed.';

grant execute on function public.staff_upsert_lookup(text, text, uuid) to anon, authenticated;
grant execute on function public.staff_retire_lookup(text, uuid) to anon, authenticated;
grant execute on function public.staff_list_lookups() to anon, authenticated;



-- ---------------------------------------------------------------------------
-- 3. the money
-- ---------------------------------------------------------------------------
-- Two numbers an operator is asked for constantly, which until now meant
-- downloading the roster and totalling a column by hand.
--
--   to_verify - referenced, not yet checked against the bank. This is the QUEUE:
--               money that has been sent and not confirmed.
--   received  - verified. Money that has actually arrived.
--
-- They are kept apart because conflating them is how a roster ends up looking
-- solvent while a payment sits unreconciled. Rejected is in neither: that money
-- did not arrive, and counting it as "to verify" would inflate the queue with
-- something already known to be wrong.
--
-- Every amount comes from purchase_amount, which the ...020 trigger fills from
-- public.pricing. A row whose amount is NULL is a price that was never set, and
-- it is REPORTED as `unpriced` rather than counted as zero - a zero would claim
-- the event is free, which is a different and wrong statement.
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
                 where payment_status = 'unverified'),
      'amount', (select coalesce(sum(purchase_amount), 0) from public.registrations
                  where payment_status = 'unverified')),
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
    'rejected', (select count(*) from public.registrations
                  where payment_status = 'rejected'),
    'unpriced', (select count(*) from public.registrations
                  where purchase_amount is null
                    and payment_status in ('unverified', 'verified'))
  );
end;
$$;

comment on function public.staff_finance_summary() is
  'Coordinator+. The reconciliation split: to_verify (referenced, not yet checked), received (verified), awaiting_utr, rejected, and unpriced - rows whose amount is NULL because no price was set, reported rather than counted as zero.';

grant execute on function public.staff_finance_summary() to anon, authenticated;



-- ---------------------------------------------------------------------------
-- 4. who is behind an event's count
-- ---------------------------------------------------------------------------
-- The number on a card came from event_registered_count() with no way to see
-- WHO. This is the list behind it, and it is the SAME count broken down rather
-- than a second opinion, so the two can never disagree.
--
-- A person appears once per row, and one person may now hold several rows
-- (migration ...023), so this is a list of PURCHASES. Someone who bought a
-- bundle seating this event AND registered for it directly is two entries and
-- two payments - which is the truth, and the reason the rows here can exceed the
-- number of distinct people. `people` is reported alongside so the difference is
-- visible rather than surprising.
create or replace function public.staff_list_event_registrations (p_event_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_title   text;
  v_count   int;
  v_cap     int;
  v_people  int;
begin
  if not public.staff_at_least('coordinator') then
    return jsonb_build_object('ok', false, 'error', 'Not authorised.');
  end if;

  select ec.title, ec.max_registrations into v_title, v_cap
    from public.event_catalogue ec where ec.id = p_event_id;

  if v_title is null then
    return jsonb_build_object('ok', false, 'error', 'No such event.');
  end if;

  v_count  := public.event_registered_count(p_event_id);
  v_people := (select count(distinct r.id)
                 from public.registration_events re
                 join public.registrations r on r.id = re.registration_id
                where re.event_id = p_event_id);

  return jsonb_build_object(
    'ok', true,
    'event_id', p_event_id,
    'title', v_title,
    'registered', v_count,
    'people', v_people,
    'cap', v_cap,
    'full', (v_cap is not null and v_count >= v_cap),
    -- Null when no cap is set, which reads as "no limit" rather than as zero
    -- seats left. Showing 0 for an uncapped event says the opposite of the truth.
    'seats_left', (case when v_cap is null then null else greatest(v_cap - v_count, 0) end),
    'rows', coalesce((
      select jsonb_agg(to_jsonb(s) order by s.created_at)
        from (
          select r.id, r.name, r.email, r.phone_number, r.college_name,
                 r.roll_number, r.purchase_label, r.purchase_type,
                 r.purchase_ref, r.purchase_amount, r.payment_status,
                 r.utr_number, r.created_at
            from public.registration_events re
            join public.registrations r on r.id = re.registration_id
           where re.event_id = p_event_id
             and (r.payment_status is null or r.payment_status <> 'rejected')
        ) s), '[]'::jsonb)
  );
end;
$$;

comment on function public.staff_list_event_registrations(text) is
  'Coordinator+. The people behind an event''s registration count, with what each paid and whether it is verified. Same count as event_registered_count(), broken down - a person holding both a bundle seat and a direct entry appears once per purchase, which is why rows can exceed the distinct people count. Includes the cap, seats remaining, and whether the event is full.';

grant execute on function public.staff_list_event_registrations(text) to anon, authenticated;

grant execute on function public.public_lookups() to anon, authenticated;

-- RLS is enabled on new tables in this project, and a table with RLS and no
-- policy reads as EMPTY to everyone. That is exactly what public_lookups() did: it
-- answered ok:true with two empty lists, which is a silent failure - the form would
-- have rendered an empty dropdown and looked like a data problem. So the read is
-- stated here, and only for ACTIVE rows: a retired college is not offered.

drop policy if exists public_read_active_colleges on public.colleges;
create policy public_read_active_colleges on public.colleges
  for select to anon, authenticated
  using (is_active);

drop policy if exists public_read_active_departments on public.departments;
create policy public_read_active_departments on public.departments
  for select to anon, authenticated
  using (is_active);


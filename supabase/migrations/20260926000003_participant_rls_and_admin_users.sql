-- =============================================================================
-- NEXUS — participant ownership + admin access on public.registrations
-- Migration : 20260926000003_participant_rls_and_admin_users.sql
-- Purpose   : Phase 2.
--             1. Registrations belong to a signed-in participant
--                (registrations.user_id = auth.users.id).
--             2. Admins are Supabase email/password users listed in the new
--                public.admin_users table.
--             3. RLS splits the two: a participant may insert / read / correct
--                ONLY their own row; an admin may read, verify, reject and
--                delete every row. The anon INSERT policy from ...0001 is
--                dropped — an unauthenticated visitor can no longer write.
-- Idempotent: drop-if-exists + create; safe to run more than once.
-- =============================================================================

-- 1) ownership column -------------------------------------------------------------
alter table public.registrations
  add column if not exists user_id uuid references auth.users (id) on delete set null;

create index if not exists ix_registrations_user_id
  on public.registrations (user_id);

-- 2) admin roster ----------------------------------------------------------------
-- A row here is the ONLY thing that makes a Supabase user an admin. There are
-- no INSERT / UPDATE / DELETE policies on this table, so nobody can grant
-- themselves access through the public API — `npm run db:grant-admin -- <email>`
-- (or the SQL editor) is the only way in.
create table if not exists public.admin_users (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  email      text        not null,
  full_name  text,
  created_at timestamptz not null default now(),
  created_by text
);

create unique index if not exists uq_admin_users_email
  on public.admin_users (lower(btrim(email)));

comment on table public.admin_users is
  'NEXUS operations team. A row here grants full read/verify/reject/delete on public.registrations through RLS. Managed out-of-band (npm run db:grant-admin) — the API has no write policies on this table.';

-- 3) is_admin() ------------------------------------------------------------------
-- SECURITY DEFINER so the RLS policies below can consult this table without
-- recursing through admin_users' own policies. search_path is pinned empty and
-- every reference is schema-qualified, so the function cannot be hijacked by a
-- caller-controlled search_path.
create or replace function public.is_admin ()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.admin_users
     where user_id = auth.uid()
  );
$$;

revoke execute on function public.is_admin () from public;
grant execute on function public.is_admin () to authenticated;

-- 4) admin_users RLS -------------------------------------------------------------
alter table public.admin_users enable row level security;

drop policy if exists admin_users_read_own on public.admin_users;

-- A signed-in user may check their own membership (the console does exactly
-- that after sign-in). Nothing else is readable, and nothing is writable.
create policy admin_users_read_own
  on public.admin_users
  for select
  to authenticated
  using (user_id = auth.uid());

-- 5) registrations RLS -----------------------------------------------------------
-- The anonymous write path is gone: participants must sign in with Google.
drop policy if exists anon_insert_registrations on public.registrations;

revoke all on public.registrations from anon;
revoke all on public.admin_users from anon;

-- stamp the owner from the JWT so the browser can never claim someone else's
-- user_id (and can never be trusted to supply it at all)
create or replace function public.set_registration_user_id ()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.user_id is null and auth.uid() is not null then
    new.user_id := auth.uid();
  end if;
  return new;
end;
$$;

drop trigger if exists trg_registrations_set_user_id on public.registrations;
create trigger trg_registrations_set_user_id
  before insert on public.registrations
  for each row
  execute function public.set_registration_user_id();

-- column-level guard. RLS alone says "the participant owns this row"; it cannot
-- say "and may only touch these columns". Without this, a participant could
-- POST payment_status = 'verified' on their own row and mint themselves a
-- confirmed payment.
create or replace function public.guard_registration_update ()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if public.is_admin() then
    return new;
  end if;

  -- Claiming a pre-ownership row. Registrations created before migration
  -- ...0003 have user_id IS NULL, and the policies above scope on
  -- user_id = auth.uid(), so their author could never see or correct them.
  -- A participant may adopt an unowned row only when its email is exactly the
  -- address on their verified Google account, so this cannot be used to take
  -- over somebody else's registration. (uq_registrations_email already
  -- guarantees at most one row per address.)
  if old.user_id is null
     and new.user_id is not null
     and new.user_id = auth.uid()
     and lower(btrim(new.email)) = lower(coalesce(auth.jwt() ->> 'email', '')) then
    return new;
  end if;

  -- immutable for everyone below the admin tier
  if new.id <> old.id
     or new.user_id is distinct from old.user_id
     or new.created_at is distinct from old.created_at
     or new.payment_verified_at is distinct from old.payment_verified_at
     or new.payment_verified_by is distinct from old.payment_verified_by then
    raise exception 'registration: only the NEXUS operations team can change identity or payment-verification fields'
      using errcode = '42501';
  end if;

  -- a participant may submit or correct a UTR (unverified), or be rejected —
  -- never confirm, never un-confirm a verified payment
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

drop trigger if exists trg_registrations_guard_update on public.registrations;
create trigger trg_registrations_guard_update
  before update on public.registrations
  for each row
  execute function public.guard_registration_update();

-- participant: insert only their own row, in a legitimate payment state
drop policy if exists participant_insert_own_registration on public.registrations;
create policy participant_insert_own_registration
  on public.registrations
  for insert
  to authenticated
  with check (
    user_id = auth.uid()
    -- paid flow: UTR captured at signup, waiting for admin verification
    and ((payment_status = 'unverified' and utr_number is not null)
      -- free entry: registered, nothing due, no UTR
      or (payment_status = 'awaiting_utr' and utr_number is null))
  );

-- participant: read only their own row (the "is my seat confirmed?" view)
drop policy if exists participant_select_own_registration on public.registrations;
create policy participant_select_own_registration
  on public.registrations
  for select
  to authenticated
  using (user_id = auth.uid());

-- participant: correct their own details / re-submit a UTR. The guard trigger
-- above decides which columns that actually covers.
--
-- The OR-arm on an unowned row whose email equals the signed-in account is the
-- claim path for registrations that predate user_id (migration ...0003). Without
-- it the row would be invisible to its author forever. Matching on the verified
-- JWT email is what makes the claim non-transferable.
drop policy if exists participant_update_own_registration on public.registrations;
create policy participant_update_own_registration
  on public.registrations
  for update
  to authenticated
  using (
    user_id = auth.uid()
    or (user_id is null
        and lower(btrim(email)) = lower(coalesce(auth.jwt() ->> 'email', '')))
  )
  with check (user_id = auth.uid());

-- operations team: the console's four verbs
drop policy if exists admin_select_registrations on public.registrations;
create policy admin_select_registrations
  on public.registrations
  for select
  to authenticated
  using (public.is_admin());

drop policy if exists admin_update_registrations on public.registrations;
create policy admin_update_registrations
  on public.registrations
  for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists admin_delete_registrations on public.registrations;
create policy admin_delete_registrations
  on public.registrations
  for delete
  to authenticated
  using (public.is_admin());

comment on column public.registrations.user_id is
  'Owning Supabase Auth user. Stamped from auth.uid() by trg_registrations_set_user_id, so the browser cannot spoof it. RLS scopes every non-admin policy to this column.';

-- 6) purge the demo rows ---------------------------------------------------------
-- The database is the source of truth, so the placeholder roster that used to
-- sit in supabase/seed.sql is removed for good. Matched by the exact seed
-- addresses (NOT "user_id is null"), so this stays a no-op on every re-run and
-- can never touch a real registration.
delete from public.registrations
 where lower(btrim(email)) in (
   'aarav.sample@example.com',
   'meera.example@example.com',
   'vihaan.prototype@example.com'
 );

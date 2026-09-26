-- =============================================================================
-- NEXUS — Supabase data model :: public.registrations
-- Migration : 20260926000000_create_registrations.sql
-- Status    : APPLIED 2026-09-26 to project xvteqcvvjlxhwijwxbbq via
--             npm run db:migrate (Management API + PAT in .env).
--             Idempotent: safe to run more than once.
-- Fields    : Name, Roll Number, College name, Year, Department,
--             Phone Number, Email, UTR number, Payment status
-- Pay flow  : participant submits UTR -> unverified -> admin confirms -> verified
-- Idempotent: safe to run more than once.
-- =============================================================================

-- 1) payment status enum -------------------------------------------------------
do $$
begin
  if not exists (
    select 1
      from pg_type t
      join pg_namespace n on n.oid = t.typnamespace
     where t.typname = 'payment_status'
       and n.nspname = 'public'
  ) then
    create type public.payment_status as enum ('awaiting_utr', 'unverified', 'verified', 'rejected');
  end if;
end
$$;

-- 2) table ---------------------------------------------------------------------
create table if not exists public.registrations (
  id             uuid        primary key default gen_random_uuid(),
  name           text        not null,
  roll_number    text        not null,
  college_name   text        not null,
  year           text        not null,
  department     text        not null,
  phone_number   text        not null,
  email          text        not null,
  payment_status      public.payment_status not null default 'awaiting_utr',
  utr_number          text,
  utr_submitted_at    timestamptz,
  payment_verified_at timestamptz,
  payment_verified_by text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint chk_registrations_name
    check (char_length(btrim(name)) between 2 and 120),
  constraint chk_registrations_roll
    check (char_length(btrim(roll_number)) between 3 and 40),
  constraint chk_registrations_college
    check (char_length(btrim(college_name)) between 2 and 160),
  constraint chk_registrations_year
    check (year in ('1st', '2nd', '3rd', '4th')),
  constraint chk_registrations_department
    check (char_length(btrim(department)) between 2 and 80),
  constraint chk_registrations_phone
    check (char_length(btrim(phone_number)) between 8 and 15
           and phone_number ~ '^[+0-9][0-9 -]*[0-9]$'),
  constraint chk_registrations_email
    check (email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),

  -- UTR / payment-verification states must stay consistent with each other
  constraint chk_registrations_utr_state
    check ((payment_status = 'awaiting_utr' and utr_number is null)
        or (payment_status in ('unverified', 'verified', 'rejected') and utr_number is not null)),
  constraint chk_registrations_utr_format
    check (utr_number is null or utr_number ~ '^[A-Za-z0-9-]{6,30}$'),
  constraint chk_registrations_verified_at
    check ((payment_status = 'verified' and payment_verified_at is not null)
        or (payment_status <> 'verified' and payment_verified_at is null))
);

-- 3) indexes -------------------------------------------------------------------
-- one registration per student per college (case/whitespace-insensitive)
create unique index if not exists uq_registrations_college_roll
  on public.registrations (upper(btrim(college_name)), upper(btrim(roll_number)));

-- one registration per email (case-insensitive)
create unique index if not exists uq_registrations_email
  on public.registrations (lower(btrim(email)));

-- one UTR may be used only once (blocks sharing a single transaction reference)
create unique index if not exists uq_registrations_utr
  on public.registrations (btrim(utr_number))
  where utr_number is not null;

create index if not exists idx_registrations_payment_status
  on public.registrations (payment_status);

create index if not exists idx_registrations_created_at
  on public.registrations (created_at desc);

-- 4) updated_at trigger --------------------------------------------------------
create or replace function public.set_updated_at ()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_registrations_set_updated_at on public.registrations;
create trigger trg_registrations_set_updated_at
  before update on public.registrations
  for each row
  execute function public.set_updated_at();

-- 5) payment verification audit trigger ---------------------------------------
create or replace function public.set_payment_audit_fields ()
returns trigger
language plpgsql
as $$
begin
  -- stamp UTR submission (first entry, or a re-submission after rejection)
  if new.utr_number is not null and new.utr_number is distinct from old.utr_number then
    new.utr_submitted_at := now();
  end if;

  if new.payment_status = 'verified' then
    if new.payment_verified_at is null then
      new.payment_verified_at := now();
    end if;
  else
    -- leaving 'verified' (or never there): drop stale verification audit fields
    new.payment_verified_at := null;
    new.payment_verified_by := null;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_registrations_payment_audit on public.registrations;
create trigger trg_registrations_payment_audit
  before insert or update on public.registrations
  for each row
  execute function public.set_payment_audit_fields();

-- 6) row level security — deny-by-default --------------------------------------
alter table public.registrations enable row level security;
-- Intentionally NO policies: the PostgREST API (anon / authenticated roles)
-- cannot read or write this table until an integration pass adds policies
-- on purpose. The schema stays unlinked until then.

-- 7) dashboard documentation ---------------------------------------------------
comment on table public.registrations is
  'NEXUS participant registrations with UTR payment verification. Schema applied 2026-09-26; frontend still uses the local mirror until RLS policies land.';
comment on column public.registrations.payment_status      is 'awaiting_utr (no UTR) -> unverified (UTR submitted, NOT verified) -> verified (admin confirmed) | rejected. Default: awaiting_utr.';
comment on column public.registrations.utr_number          is 'UTR / transaction reference entered by the participant; unique across all registrations.';
comment on column public.registrations.utr_submitted_at    is 'When the UTR was submitted (auto-stamped by trigger on insert / re-submit).';
comment on column public.registrations.payment_verified_at is 'When an admin confirmed the UTR (auto-stamped; cleared if status leaves verified).';
comment on column public.registrations.payment_verified_by is 'Admin identity that confirmed the UTR (email / service-role actor).';
comment on column public.registrations.name           is 'Full name of the participant.';
comment on column public.registrations.roll_number    is 'Institution roll number / student ID.';
comment on column public.registrations.college_name   is 'College / institution the participant belongs to.';
comment on column public.registrations.year           is 'Academic year: 1st | 2nd | 3rd | 4th.';
comment on column public.registrations.department     is 'Department (e.g. CSE, ECE, IT, Mech).';
comment on column public.registrations.phone_number   is 'Contact number: 8-15 chars, digits with optional +, space or dash.';
comment on column public.registrations.email          is 'Contact email; unique ignoring case (enforced by index).';

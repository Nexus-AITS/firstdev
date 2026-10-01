-- =============================================================================
-- NEXUS - pay by cash at the desk, not only by UTR
-- Migration : 20260927000026_payment_method_cash_enum.sql
-- Purpose   : Add the two things a cash registration needs that a UTR one does
--             not - HOW the money is coming, and a state meaning "registered,
--             nothing received yet" - without touching the UTR rules.
--
-- WHY A NEW ENUM VALUE AT ALL
--
-- cash is not a UTR with a blank reference. A UTR is a digital claim the
-- participant makes about money they have already moved; cash is money that has
-- not moved yet and will be handed over at the desk. Reusing `awaiting_utr` for
-- it would have been one word less and would have put "awaiting UTR" on the
-- roster beside a participant who will never paste one - the same mistake as
-- calling a NULL price zero. So the state is named for what it is.
--
-- WHY THIS FILE STOPS BEFORE THE CHECKS
--
-- `alter type ... add value` cannot be used by a statement in the SAME
-- transaction that adds it - Postgres raises "unsafe use of new value of enum
-- type". The Management API applies a whole file as one script, so the value is
-- added here and every rule that REFERENCES it lives in
-- ...027_payment_method_cash_rules.sql, which runs after. Splitting them is not
-- tidiness; it is the only order that applies.
--
-- WHAT IS *NOT* CHANGED HERE
--
-- No CHECK, policy, guard or trigger is touched in this file, on purpose. The
-- UTR rules are load-bearing in five places (table CHECK, the INSERT policy's
-- WITH CHECK, the update guard, and two registration_events policies) and every
-- one of them would have to be relaxed in the same breath. Doing that in a
-- second file means this one can never be half-applied and leave a database
-- that accepts a cash row it cannot describe.
--
-- Idempotent: add-column-if-not-exists, drop/add-constraint-if-exists, and the
-- enum value is added only when it is genuinely missing.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. how the money is coming
-- ---------------------------------------------------------------------------

alter table public.registrations
  add column if not exists payment_method text not null default 'utr';

alter table public.registrations
  drop constraint if exists chk_registrations_payment_method;

alter table public.registrations
  add constraint chk_registrations_payment_method
    check (payment_method in ('utr', 'cash'));

comment on column public.registrations.payment_method is
  'How this registration is paid: ''utr'' (the participant scans the QR and pastes a UTR reference) or ''cash'' (money is handed over at the desk). Decided by the participant, enforced by chk_registrations_payment_method, and never inferred from whether a reference happens to be present - a blank utr_number is how cash STARTS, not evidence of it.';

-- ---------------------------------------------------------------------------
-- 2. the new state
-- ---------------------------------------------------------------------------
-- Idempotent through the catalogue of enum labels rather than a bare ALTER,
-- which has no IF NOT EXISTS and would fail on the second run of db:migrate.

do $$
begin
  if not exists (
    select 1
      from pg_type t
      join pg_namespace n on n.oid = t.typnamespace
      join pg_enum   e on e.enumtypid = t.oid
     where t.typname = 'payment_status'
       and n.nspname = 'public'
       and e.enumlabel = 'awaiting_cash'
  ) then
    alter type public.payment_status add value 'awaiting_cash';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. the rows already here
-- ---------------------------------------------------------------------------
-- Every existing registration was collected by UTR - there is no cash on this
-- project yet - so `utr` is the correct backfill and the DEFAULT already does
-- it. Written out anyway, and stated rather than assumed: a row with a UTR and
-- a row with neither are different facts, and the second one does not exist.

update public.registrations
   set payment_method = 'utr'
 where payment_method is null
   or payment_method not in ('utr', 'cash');

comment on type public.payment_status is
  'The payment lifecycle. UTR: awaiting_utr (registered, no reference yet) -> unverified (reference submitted, not checked) -> verified (operations confirmed) | rejected. Cash: awaiting_cash (registered, money due at the desk) -> verified (cash taken) | rejected. Rejected rows may be corrected by their author.';

-- The rules that read these two new things are in ...027.

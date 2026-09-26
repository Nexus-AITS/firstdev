-- =============================================================================
-- NEXUS — RLS write policy for public.registrations
-- Migration : 20260926000001_registration_policies.sql
-- Status    : APPLIED 2026-09-26 to project xvteqcvvjlxhwijwxbbq via
--             npm run db:migrate (Management API + PAT in .env).
-- Purpose   : the /register wizard (anon PostgREST role) must be able to
--             insert a registration. READ stays denied (no SELECT policy) —
--             participant PII is never exposed through the API until an
--             authenticated admin pass adds scoped policies.
-- Idempotent: drop-if-exists + create; safe to run more than once.
-- =============================================================================

drop policy if exists anon_insert_registrations on public.registrations;

create policy anon_insert_registrations
  on public.registrations
  for insert
  to anon, authenticated
  with check (
    -- paid flow: UTR captured at signup, waiting for admin verification
    (payment_status = 'unverified' and utr_number is not null)
    -- free entry: registered, nothing due, no UTR
    or (payment_status = 'awaiting_utr' and utr_number is null)
  );

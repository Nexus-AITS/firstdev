-- =============================================================================
-- NEXUS — Supabase data model :: purchase context on public.registrations
-- Migration : 20260926000002_registration_purchase_context.sql
-- Status    : APPLIED 2026-09-26 to project xvteqcvvjlxhwijwxbbq via
--             npm run db:migrate (Management API + PAT in .env).
--             Idempotent: safe to run more than once.
-- Purpose   : the /register wizard knows WHICH event entry or WHICH bundle the
--             participant is buying (?event= / ?bundle= query context). These
--             two columns keep the cloud copy 1:1 with the local mirror
--             (src/data/registrations.js) so the admin panel's Purchase column
--             works against either data source.
-- =============================================================================

alter table public.registrations
  add column if not exists purchase_type  text,  -- 'event' | 'bundle' | null
  add column if not exists purchase_label text;  -- e.g. 'NEXUS BREACH' or 'BUNDLED #05 · ₹399'

-- narrow the type column to the two values the wizard can record
do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conname = 'chk_registrations_purchase_type'
       and conrelid = 'public.registrations'::regclass
  ) then
    alter table public.registrations
      add constraint chk_registrations_purchase_type
      check (purchase_type is null or purchase_type in ('event', 'bundle'));
  end if;
end
$$;

comment on column public.registrations.purchase_type  is 'What was bought: ''event'' (single-event entry) or ''bundle'' (bundled pass); null for legacy rows.';
comment on column public.registrations.purchase_label is 'Human label shown in the admin console: event title, or bundle name + number + price.';

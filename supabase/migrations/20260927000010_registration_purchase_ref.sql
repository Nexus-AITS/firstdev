-- =============================================================================
-- NEXUS — registrations.purchase_ref
-- Migration : 20260927000010_registration_purchase_ref.sql
-- Purpose   : The wizard is entered through /register?event=… or ?bundle=…, and
--             the row it writes kept only a human-readable purchase_label
--             ("NEXUS BREACH", "BUNDLED #01 · ₹299"). The profile page needs to
--             send a participant back to the EXACT wizard they left, so it needs
--             the machine id — and a label is the wrong thing to match on
--             because it carries a price that a master can change.
--
--             Nullable on purpose: a row written before this migration may not
--             be resolvable (its label may already have drifted from the
--             catalogue), and a wrong ref would resume the wrong wizard. Null
--             means "no resume target", which the profile renders honestly.
-- Idempotent: if-not-exists / where-not-exists backfill.
-- =============================================================================

alter table public.registrations
  add column if not exists purchase_ref text;

comment on column public.registrations.purchase_ref is
  'Catalogue id of what was bought — an event id or a bundle id, the same values /register takes as ?event= / ?bundle=. Nullable for rows that predate this column.';

create index if not exists ix_registrations_purchase_ref
  on public.registrations (purchase_ref);

-- Backfill events by title: the catalogue is the authority for id <-> title.
update public.registrations r
   set purchase_ref = e.id
  from public.event_catalogue e
 where r.purchase_ref is null
   and r.purchase_type = 'event'
   and btrim(r.purchase_label) = btrim(e.title);

-- Backfill bundles by the label's stable prefix, "NAME #NN · ₹…". The price
-- suffix is deliberately not matched: if a price changed since the
-- registration, the bundle is still the same bundle.
update public.registrations r
   set purchase_ref = b.id
  from public.bundle_catalogue b
 where r.purchase_ref is null
   and r.purchase_type = 'bundle'
   and r.purchase_label like (b.name || ' #' || b.number || ' ·%');

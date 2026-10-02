-- A REAL event row that exists only in the database - no entry in the compiled
-- src/data/events.js. This is exactly what a master creates in the Catalogue tab,
-- and it is the case /events/:id could not render (it 404'd).
--
-- Inserted rather than rolled back so the browser test can actually load the
-- page; scripts/verify-dynamic-event.mjs deletes it again in its cleanup.
insert into public.event_catalogue
  (id, number, title, category, realm, tagline, about, event_date, venue,
   team_size, entry_type, max_size, status, accent, sigil, sort_order, is_active)
values
  ('zz-dynamic-probe', 'PROBE', 'DYNAMIC PROBE EVENT', 'TEST', 'paradox',
   'A probe created only in the database.',
   array['This paragraph exists only in the database row, never in the compiled seed.']::text[],
   'OCT 9, 2026', 'PROBE HALL', 'SOLO', 'individual', 'individual',
   'REGISTRATION OPEN', 'violet', 'aperture', 999, true)
on conflict (id) do update
   set title = excluded.title,
       venue = excluded.venue,
       is_active = true;

-- A PRICE, or the probe would be a free event and would not exercise the bug
-- that matters: getEventFee() resolving through the compiled array returned
-- null, and `paid = fee > 0` reads a null fee as FREE - so the register wizard
-- would route a participant past the payment steps for a paid event.
insert into public.pricing (kind, ref_id, entry_type, price, is_active)
values ('event', 'zz-dynamic-probe', 'individual', 249, true)
on conflict (kind, ref_id) do update
   set price = excluded.price, is_active = true;
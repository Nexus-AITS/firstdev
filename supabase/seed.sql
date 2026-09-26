-- NEXUS — sample data for public.registrations.
-- Every value below is FAKE and safe to discard.
-- Demonstrates the UTR payment-verification flow:
--   awaiting_utr (no UTR yet) -> unverified (UTR submitted, not yet checked)
--   -> verified (admin confirmed the UTR)
-- Timestamps (utr_submitted_at / payment_verified_at) are stamped by trigger.
-- Optional: run after the migration (SQL editor, psql, or `supabase db reset`).

insert into public.registrations
  (name, roll_number, college_name, year, department, phone_number, email,
   payment_status, utr_number, payment_verified_by)
values
  ('Aarav Sample',    '21B81A0501', 'AITS Tirupati',  '3rd', 'CSE', '+91 90000 00001', 'aarav.sample@example.com',    'verified',     '402345678912', 'admin@nexus'),
  ('Meera Example',   '22B83A0214', 'AITS Tirupati',  '2nd', 'ECE', '9000000002',      'meera.example@example.com',   'unverified',   '402345678913', null),
  ('Vihaan Prototype','23B84A1137', 'JNTU Anantapur', '1st', 'IT',  '91 9000000003',   'vihaan.prototype@example.com','awaiting_utr', null,          null)
on conflict do nothing;

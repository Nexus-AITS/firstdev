-- Migration : 20260927000023_one_row_per_purchase.sql
-- Purpose   : Let one person register for MORE THAN ONE thing - a bundle and a
--             separate event - and have every purchase on the roster.
--
-- THE BUG
--
-- Two unique indexes said "one registration per human":
--
--   uq_registrations_email         (lower(btrim(email)))
--   uq_registrations_college_roll  (upper(btrim(college_name)), upper(btrim(roll_number)))
--
-- So a second purchase had nowhere to go. The wizard's own code made that a
-- silent loss rather than an error: findMine(email) matched the FIRST row for
-- that address regardless of what was being bought, and finalize() then attached
-- the new reference to it. A participant who bought a bundle and then a single
-- event ended up with ONE row - the bundle - carrying the event's UTR. The
-- roster showed the bundle, the event purchase existed nowhere, and the row's
-- own fields disagreed: one live row said purchase_type 'bundle' while its
-- purchase_ref was an event id.
--
-- The intent behind those indexes was always sound - one human, one seat per
-- thing, no accidental double-booking. What it should have said is "one row per
-- person PER PURCHASE", which is what it says now.
--
-- WHAT SURVIVES, DELIBERATELY
--
--   * The same person may not take the same bundle twice. The new key includes
--     the purchase, so the old refusal survives for the case it was really for;
--     what is gone is only the refusal that blocked a DIFFERENT purchase.
--   * uq_registrations_utr is untouched. A UTR is a payment, and one payment
--     still settles exactly one row - otherwise the second purchase would have
--     nowhere to put its own reference.
--   * A row with no purchase context (someone added from the console) is still
--     one per person, via the '' sentinel in the key.
--
-- The profile page already renders a resume link per row and the roster already
-- lists every row, so both surfaces were ready for this; nothing there changes.

-- Repaired through a MASTER-ONLY, AUDITED function rather than a bare UPDATE.
-- The bare UPDATE is refused, and correctly so: `guard_registration_update` will
-- not let anything touch a row whose payment is verified, and the row this
-- repairs IS verified. Silently reaching around that guard from a migration is
-- exactly the move the guard exists to prevent, so the repair is expressed as
-- the operator action it actually is - and it leaves a trail saying who did it
-- and why.
create or replace function public.staff_fix_registration_purchase_type ()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_fixed int;
begin
  if not public.staff_at_least('master') then
    return jsonb_build_object('ok', false,
      'error', 'Only a master administrator can repair a registration''s purchase.');
  end if;

  -- A row whose purchase_type or purchase_label disagrees with its purchase_ref
  -- is the fingerprint of the overwrite this migration fixes: those fields came
  -- from a different purchase, and whichever landed last won. The catalogue is
  -- the authority on which kind an id is and what it is called.
  --
  -- The LABEL is rebuilt too, and it has to be: the roster prints purchase_label
  -- verbatim, so a row reading "OFFER #01 Rs 200" while pointing at an event is
  -- precisely the "which bundle did they buy?" confusion this migration is about,
  -- and it would still be on screen after the type alone was fixed. The price is
  -- deliberately left out of the label - it belongs in purchase_amount, and a
  -- price the operator has since changed must not be frozen into a label.
  with resolved as (
    select ec.id, 'event'::text as kind, ec.title as label
      from public.event_catalogue ec
     union all
    select bc.id, 'bundle'::text as kind,
           bc.name || ' #' || bc.number as label
      from public.bundle_catalogue bc
  ), repaired as (
    update public.registrations r
       set purchase_type = resolved.kind,
           purchase_label = resolved.label,
           updated_at     = now()
      from resolved
     where r.purchase_ref = resolved.id
       and (r.purchase_type is distinct from resolved.kind
            or r.purchase_label is distinct from resolved.label)
    returning r.id
  )
  select count(*) into v_fixed from repaired;

  -- One audit entry, naming the reason, via the same helper every other staff
  -- action uses so the row carries the actor and role in the shape the console
  -- already renders.
  if v_fixed > 0 then
    perform public.staff_audit(
      'fix_registration_purchase', 'registration', '(batch)',
      jsonb_build_object('rows', v_fixed,
                         'reason', 'purchase_type/label disagreed with purchase_ref'));
  end if;

  return jsonb_build_object('ok', true, 'repaired', v_fixed);
end;
$$;

comment on function public.staff_fix_registration_purchase_type() is
  'Master-only, audited. Sets purchase_type from the catalogue wherever it disagrees with purchase_ref - the damage done by the one-row-per-email constraint, where a second purchase overwrote the first row''s fields. Runs inside the registration guard, so it needs an explicit master call rather than a bare UPDATE.';

grant  execute on function public.staff_fix_registration_purchase_type() to anon, authenticated;
revoke execute on function public.staff_fix_registration_purchase_type() from public;

select public.staff_fix_registration_purchase_type();

drop index if exists public.uq_registrations_email;

-- One row per person per purchase. Expressions are wrapped in coalesce so a NULL
-- is a value the index can key on: without it, every row with no purchase would
-- be treated as a duplicate of every other such row, because in a unique index
-- NULLs are all distinct from each other and the key would never collide.
create unique index if not exists uq_registrations_purchase
  on public.registrations
    (lower(btrim(email)), coalesce(purchase_type, ''), coalesce(purchase_ref, ''));

drop index if exists public.uq_registrations_college_roll;

-- The same rule on identity rather than address, for the people who register
-- from the same college with the same roll number as a relative - a real case in
-- a student event, and the reason this index existed at all.
create unique index if not exists uq_registrations_college_roll_purchase
  on public.registrations
    (upper(btrim(college_name)), upper(btrim(roll_number)),
     coalesce(purchase_type, ''), coalesce(purchase_ref, ''));

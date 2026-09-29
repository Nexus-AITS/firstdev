-- Migration : 20260927000020_registration_purchase_amount.sql
-- Purpose   : Every registration records what it cost. A single-event one never
--             did, so `purchase_amount` was NULL on the roster and in the export.
--
-- THE BUG
--
-- purchase_amount is written in exactly one place: registration_set_events.
-- That function is the event-SELECTION step, and only a bundle with pick-pools
-- has one - a plain single-event registration goes details -> payment -> UTR
-- and never calls it. So every paid individual event registered on this site
-- carried a NULL amount, while the QR the participant paid by was encoded from
-- the real price. The roster showed the label and no number, and the finance
-- export wrote an empty cell into a column it formats as currency.
--
-- It was NULL on a live row whose payment was already verified, which is the
-- worst shape: the payment is real, the amount that proves it is not recorded.
--
-- THE FIX
--
-- A BEFORE INSERT OR UPDATE trigger that fills the amount from public.pricing
-- whenever it is null and purchase_ref resolves to something priced. The
-- database fills it, never the browser - the amount a participant is charged is
-- not something a request body gets to decide, which is the same rule
-- registration_set_events already follows when it recomputes.
--
-- The same trigger also rebuilds a bundle label that is still the bare id, so a
-- row is never left saying "bundel-off-grid" even if it is written by a path
-- that has not reached the selection step yet. It only ever FILLS: a value that
-- is already set, or a label that already reads as words, is left untouched, so
-- registration_set_events still wins where both run.
--
-- Free entries resolve to 0, not NULL. A free seat is a price of zero, and the

create or replace function public.registrations_fill_purchase_amount ()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_amount integer;
  v_name   text;
  v_number text;
begin
  -- Nothing to resolve from: not a purchase, or a row with no context yet.
  if new.purchase_ref is null or btrim(new.purchase_ref) = '' then
    return new;
  end if;

  if new.purchase_type = 'bundle' then
    select p.price, b.name, b.number
      into v_amount, v_name, v_number
      from public.bundle_catalogue b
      left join lateral (
            select p.price from public.pricing p
             where p.kind = 'bundle' and p.ref_id = b.id
               and p.entry_type = 'individual' and p.is_active
             order by p.price
             limit 1
           ) p on true
     where b.id = new.purchase_ref;

    if v_amount is not null then
      if new.purchase_amount is null then
        new.purchase_amount := v_amount;
      end if;

      -- A label that is still the id, or is missing, is rebuilt from the same
      -- row that produced the amount. "NAME #NN" without the price is fine as a
      -- label - registration_set_events appends the chosen titles later - and a
      -- price the operator changes after the fact must not be frozen into a
      -- label, so this deliberately omits it.
      if new.purchase_label is null or btrim(new.purchase_label) = new.purchase_ref then
        new.purchase_label := coalesce(
          nullif(trim(coalesce(v_name, '') || ' #' || trim(coalesce(v_number, ''))), ''),
          new.purchase_ref
        );
      end if;
    end if;

  elsif new.purchase_type = 'event' then
    -- Joined to the catalogue so the rate can only be one that matches the
    -- entry type actually being charged for; a per-squad rate must never be
    -- charged as a per-person one.
    select p.price into v_amount
      from public.pricing p
      join public.event_catalogue ec
        on ec.id = p.ref_id and p.entry_type = ec.entry_type
     where p.kind = 'event'
       and p.ref_id = new.purchase_ref
       and p.is_active
     order by p.price
     limit 1;

    if v_amount is not null and new.purchase_amount is null then
      new.purchase_amount := v_amount;
    end if;

    if new.purchase_label is null or btrim(new.purchase_label) = new.purchase_ref then
      select ec.title into v_name
        from public.event_catalogue ec
       where ec.id = new.purchase_ref;
      if v_name is not null then
        new.purchase_label := v_name;
      end if;
    end if;
  end if;

  return new;
end;
$$;

comment on function public.registrations_fill_purchase_amount() is
  'BEFORE INSERT OR UPDATE on registrations. Fills purchase_amount from public.pricing when it is null and purchase_ref resolves, and rebuilds a purchase_label that is still the bare id. Never overwrites a value that is already set, and never invents a zero for an unpriced reference.';

drop trigger if exists trg_registrations_purchase_amount on public.registrations;

-- ---------------------------------------------------------------------------
-- Backfill
-- ---------------------------------------------------------------------------
-- The same rule as the trigger, so the rows already on the roster are corrected
-- rather than waiting for their next write. Scoped to what the trigger can
-- actually resolve, so a row whose reference has no price keeps its NULL - the
-- gap stays visible instead of being quietly zeroed.

update public.registrations r
   set purchase_amount = v.price
  from (
    select b.id, p.price
      from public.bundle_catalogue b
      join public.pricing p
        on p.kind = 'bundle' and p.ref_id = b.id
       and p.entry_type = 'individual' and p.is_active
    union all
    select ec.id, p.price
      from public.event_catalogue ec
      join public.pricing p
        on p.kind = 'event' and p.ref_id = ec.id
       and p.entry_type = ec.entry_type and p.is_active
  ) v
 where r.purchase_amount is null
   and r.purchase_type is not null
   and r.purchase_ref = v.id;

update public.registrations r
   set purchase_label = b.name || ' #' || b.number
  from public.bundle_catalogue b
 where r.purchase_type = 'bundle'
   and r.purchase_ref = b.id
   and (r.purchase_label is null or btrim(r.purchase_label) = b.id);

update public.registrations r
   set purchase_label = ec.title
  from public.event_catalogue ec
 where r.purchase_type = 'event'
   and r.purchase_ref = ec.id
   and (r.purchase_label is null or btrim(r.purchase_label) = r.purchase_ref);

create trigger trg_registrations_purchase_amount
  before insert or update on public.registrations
  for each row execute function public.registrations_fill_purchase_amount();

-- difference between "this costs nothing" and "we never recorded what it costs"
-- is exactly the distinction this column exists to make.
--
-- If the reference has no price row, the amount stays NULL on purpose. Inventing
-- a zero there would put a legitimate-looking 0 next to a real payment, and a
-- missing price is a data gap the operations team has to see.

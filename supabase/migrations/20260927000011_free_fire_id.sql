-- =============================================================================
-- NEXUS — the Free Fire ID
-- Migration : 20260927000011_free_fire_id.sql
-- Purpose   : FREE FIRE is a paid, ranked event, so a registration for it needs
--             one thing nothing else does: the player's in-game ID. It is what
--             the operations team checks a player against their account at the
--             match and scores on, so it is captured with the registration,
--             required for that event, and carried into the roster + export.
--
-- Two decisions worth stating, because both are product calls:
--
--   * Required per PURCHASE, not globally. `purchase_ref = 'free-fire'` is the
--     test, so the rule follows the catalogue: if FREE FIRE is ever bundled,
--     a bundle seat does not inherit a field only the direct entry needs.
--
--   * NOT unique. One game account registered four times is fraud-shaped, and a
--     unique index would catch it — but a typo would then block a participant
--     from ever re-registering, and the operations team already match the ID
--     against the account at the event. Add
--     `create unique index … on public.registrations (lower(btrim(free_fire_id)))
--      where free_fire_id is not null;` if that trade is the one you want.
--
-- Idempotent: if-not-exists / create or replace / drop-if-exists + create.
-- =============================================================================

alter table public.registrations
  add column if not exists free_fire_id text;

comment on column public.registrations.free_fire_id is
  'The player''s in-game Free Fire ID, required for purchase_ref = ''free-fire''. Checked against the account at the match.';

create index if not exists ix_registrations_free_fire_id
  on public.registrations (free_fire_id)
  where free_fire_id is not null;

-- ---------------------------------------------------------------------------
-- the rule
-- ---------------------------------------------------------------------------
-- A trigger rather than a table CHECK, and the reason is a real one: a CHECK
-- would be evaluated on EVERY update of a row that already exists without an
-- ID (registration …010 backfilled those refs), which would make the UTR step
-- impossible for exactly the participants who need to finish. Splitting the two
-- cases keeps both promises:
--
--   BEFORE INSERT            → a new FREE FIRE registration must bring an ID
--   BEFORE UPDATE OF that column → it may not be cleared afterwards
--
-- Editing other columns of a legacy row (submitting the UTR) is untouched.
create or replace function public.require_free_fire_id ()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.purchase_ref = 'free-fire'
     and nullif(btrim(new.free_fire_id), '') is null then
    raise exception 'FREE FIRE registration needs a Free Fire ID - it is checked at the match.'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_registrations_free_fire_id on public.registrations;
create trigger trg_registrations_free_fire_id
  before insert on public.registrations
  for each row
  execute function public.require_free_fire_id ();

drop trigger if exists trg_registrations_free_fire_id_clear on public.registrations;
create trigger trg_registrations_free_fire_id_clear
  before update of free_fire_id on public.registrations
  for each row
  execute function public.require_free_fire_id ();

-- ---------------------------------------------------------------------------
-- it reaches the roster export
-- ---------------------------------------------------------------------------
-- The export's result table is fixed (migration …006 creates it, …008 widens it
-- with the freeze columns and both drop-before-create for exactly this reason),
-- so adding a column here means the same drop/create pair in both files.

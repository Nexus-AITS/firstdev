-- Migration : 20260927000019_bundle_purchase_label.sql
-- Purpose   : A bundle registration records WHICH bundle, in words an operator
--             can read. It currently records the catalogue id instead.
--
-- THE BUG
--
-- Two writers fill registrations.purchase_label:
--
--   1. the browser, at row creation (src/data/registrations.js) -
--        "<name> #<number> · ₹<price>"   e.g.  "OFFER #01 · ₹200"
--   2. this function, when the participant records their event selection -
--        p_bundle_id                                  e.g.  "bundel-off-grid"
--
-- Writer 2 runs second and unconditionally, and a bundle with pick-pools CANNOT
-- finish without it, so for every bundle registration the readable label was
-- replaced by a machine id. The roster in /nexus-admin prints purchase_label
-- verbatim, which is why a master looking at a participant who bought a bundle
-- saw "bundel-off-grid" and could not tell what they had bought. The roster
-- spreadsheet export carries the same column, so the finance sheet had it too.
--
-- Writer 2 is the authority for the AMOUNT, and it has to stay the authority for
-- the LABEL as well: the browser's label is built from whatever the catalogue
-- said at page load, and a master who renames a bundle or changes its price
-- between the participant opening the page and pressing save would otherwise be
-- recorded under the old words. So the label is rebuilt here, from the same row
-- that proved the bundle is live.
--
-- What it produces, matching the format the roster and the older rows already
-- use:
--   bundle : "NAME #NN · ₹PRICE"      (plus " + TITLES" when events were picked)
--   event  : "TITLES"                 (or 'none')
--
-- purchase_ref already carries the id, so nothing is lost - the id simply stops
-- being the only thing a human can read.
--
-- The rupee sign is written as chr(8377) rather than as a literal. A migration
-- file that has crossed an editor, a shell or a git autocrlf round trip with its
-- encoding mangled is how "· ₹" turns into "-+" on a row an operator is trying
-- to read - which is exactly what happened to one. This way the sign is a
-- number, and it renders the same however the file is transported.

do $$
begin
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'registration_set_events'
  ) then
    raise exception
      'registration_set_events is missing - apply migration ...015 first. Refusing to run out of order.';
  end if;
end;
$$;

create or replace function public.registration_set_events (
  p_registration_id uuid,
  p_bundle_id       text default null,
  p_event_ids       text[] default '{}'
)
returns table (registration_id uuid, amount integer, currency text)
language plpgsql
set search_path = ''
as $$
declare
  v_user_id  uuid;
  v_status   public.payment_status;
  v_frozen   boolean;
  v_reg_id   uuid;
  v_bundle   integer;
  v_events   integer;
  v_known    text[];
  v_amount   integer;
  v_errors   text[];
  v_titles   text;
  v_unpriced text;
  v_bundle_name   text;
  v_bundle_number text;
  v_bundle_label  text;
begin
  v_user_id := auth.uid();
  if v_user_id is null then
    raise exception 'Sign in before choosing events.' using errcode = '42501';
  end if;

  select r.id, r.payment_status, r.selection_frozen
    into v_reg_id, v_status, v_frozen
    from public.registrations r
   where r.id = p_registration_id
     and r.user_id = v_user_id;

  if not found then
    raise exception 'That registration is not yours.' using errcode = '42501';
  end if;

  if v_frozen then
    raise exception 'Your event selection is final. Contact the operations team to change it.'
      using errcode = '42501';
  end if;

  if v_status = 'verified' then
    raise exception 'This payment is already confirmed, so the selection is closed.'
      using errcode = '42501';
  end if;

  select coalesce(array_agg(ec.id order by ec.id), '{}')
    into v_known
    from public.event_catalogue ec
   where ec.is_active
     and ec.id = any (coalesce(p_event_ids, '{}'));

  if coalesce(array_length(v_known, 1), 0)
     <> coalesce(array_length(coalesce(p_event_ids, '{}'), 1), 0) then
    raise exception 'One or more of those events is not available.'
      using errcode = '22023';
  end if;


  if p_bundle_id is not null then
    select p.price into v_bundle
      from public.pricing p
      join public.bundle_catalogue b on b.id = p.ref_id
     where p.kind = 'bundle' and p.ref_id = p_bundle_id
       and p.entry_type = 'individual' and p.is_active and b.is_active;

    if v_bundle is null then
      raise exception 'That bundle is not available.' using errcode = '22023';
    end if;

    -- THE FIX: the words come from the bundle's own row. Falling back to the id
    -- is deliberate - a bundle withdrawn between the page load and this call
    -- should still leave a row saying which id was bought, not a blank.
    select b.name, b.number into v_bundle_name, v_bundle_number
      from public.bundle_catalogue b
     where b.id = p_bundle_id;

    v_bundle_label := coalesce(
      nullif(trim(coalesce(v_bundle_name, '') || ' #' ||
                  trim(coalesce(v_bundle_number, '')) || ' ' ||
                  chr(8377) || v_bundle::text), ''),
      p_bundle_id
    );

    v_errors := public.bundle_selection_errors(p_bundle_id, v_known);
    if coalesce(array_length(v_errors, 1), 0) > 0 then
      raise exception '%', array_to_string(v_errors, ' ')
        using errcode = '22023';
    end if;

    v_amount := v_bundle;
  else
    if coalesce(array_length(v_known, 1), 0) = 0 then
      raise exception 'Choose at least one event.' using errcode = '22023';
    end if;

    -- A MISSING row, not a zero row. The test is the absence of an active price
    -- for this event's own entry type, never the number being 0, because 0 is a
    -- legitimate FREE entry and has to pass.
    select string_agg(ec.id, ', ' order by ec.id) into v_unpriced
      from public.event_catalogue ec
     where ec.id = any (v_known)
       and not exists (
             select 1 from public.pricing p
              where p.kind = 'event' and p.ref_id = ec.id
                and p.entry_type = ec.entry_type and p.is_active);

    if v_unpriced is not null then
      raise exception 'No price is set yet for: %. Contact the operations team.', v_unpriced
        using errcode = '22023';
    end if;

    -- Joined to the catalogue rather than filtering on ref_id alone, so the sum
    -- can only ever add up rates that match the entry type being charged for.
    select coalesce(sum(p.price), 0) into v_events
      from public.pricing p
      join public.event_catalogue ec
        on ec.id = p.ref_id and p.entry_type = ec.entry_type
     where p.kind = 'event'
       and p.is_active
       and p.ref_id = any (v_known);

    v_amount := coalesce(v_events, 0);
  end if;

  select coalesce(string_agg(ec.title, ', ' order by ec.sort_order, ec.id), '')
    into v_titles
    from public.event_catalogue ec
   where ec.id = any (v_known);

  delete from public.registration_events re
   where re.registration_id = v_reg_id;

  insert into public.registration_events (registration_id, event_id)
  select v_reg_id, unnest(v_known)
   where cardinality(v_known) > 0;

  update public.registrations r
     set purchase_type   = case when p_bundle_id is not null then 'bundle' else 'event' end,
         purchase_label  = case
                             when p_bundle_id is not null
                               then v_bundle_label || (case when cardinality(v_known) > 0
                                                        then ' + ' || v_titles
                                                        else '' end)
                             when cardinality(v_known) > 0 then v_titles
                             else 'none'
                           end,
         purchase_amount = v_amount,
         updated_at      = now()
   where r.id = v_reg_id;

  return query select v_reg_id, v_amount, 'INR'::text;
end;
$$;


comment on function public.registration_set_events is
  'Replace a registration''s event selection. Refused once the selection is frozen or the payment is verified, and refused if any chosen event has no price set - a missing price is a data gap, not a free seat. With a bundle, the selection is validated against the bundle''s include lines, the bundle price is the TOTAL, and purchase_label is rebuilt from the bundle''s own name and number ("OFFER #01 - Rs 200") rather than from its id. Without one, the chosen events are summed from public.pricing at their own entry type. The browser supplies ids only; the amount is never accepted from the client.';

grant execute on function public.registration_set_events(uuid, text, text[]) to authenticated;
revoke execute on function public.registration_set_events(uuid, text, text[]) from anon;

-- ---------------------------------------------------------------------------
-- Backfill
-- ---------------------------------------------------------------------------
-- Rows written before this migration still carry an id in purchase_label. The id
-- is resolvable exactly: purchase_ref, which migration ...010 added and which
-- this flow has always written. So the repair joins on that rather than trying
-- to parse the label back into a name, and is scoped to rows whose label is NOT
-- already the readable form - a row carrying proper words is left alone, which
-- keeps the backfill idempotent and stops a re-run overwriting a label by hand.
--
-- The event titles are appended exactly the way the function appends them, from
-- registration_events, so a repaired row reads the same as a newly written one.
--
-- This is also the only thing that can rescue rows already mangled by an
-- encoding round trip ("... #07 -+ 249", where the middot and the rupee sign
-- survived as literal characters written by the browser). Where purchase_ref
-- still resolves, the label is rebuilt from the catalogue; where it does not,
-- the row is left alone rather than guessed at, because a wrong bundle name on a
-- finance sheet is worse than a visibly odd one.

update public.registrations r
   set purchase_label =
         b.name || ' #' || b.number ||
         case when bp.price is null then '' else ' ' || chr(8377) || bp.price::text end ||
         case
           when (select count(*) from public.registration_events re
                  where re.registration_id = r.id) = 0 then ''
           else ' + ' || coalesce((
                  select string_agg(ec.title, ', ' order by ec.sort_order, ec.id)
                    from public.registration_events re
                    join public.event_catalogue ec on ec.id = re.event_id
                   where re.registration_id = r.id), '')
         end,
       updated_at = now()
  from public.bundle_catalogue b
  left join lateral (
         select p.price from public.pricing p
          where p.kind = 'bundle' and p.ref_id = b.id
          order by p.is_active desc, p.entry_type
          limit 1
       ) bp on true
 where r.purchase_type = 'bundle'
   and r.purchase_ref = b.id
   and r.purchase_label is not null
   -- "Does it already read like this bundle?" A label that STARTS with
   -- "NAME #NN" is left alone, so re-running this is a no-op and a hand-edited
   -- label is never stomped. Anything else - the bare id, or words mangled by an
   -- encoding round trip - is rebuilt from the catalogue.
   and left(btrim(r.purchase_label), length(b.name) + length(b.number) + 2)
       is distinct from b.name || ' #' || b.number;

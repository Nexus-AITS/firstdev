-- =============================================================================
-- NEXUS - the roster can create, edit and delete a registration
-- Migration : 20260927000038_roster_crud.sql
-- Purpose   : Let an operator correct a registration from the console - the UTR,
--             a mistyped roll number, a wrong college, the identifier an event
--             asks for - and add one by hand when somebody registers at the desk.
--
-- WHY AN RPC AND NOT THE REST PATCH THAT ALREADY EXISTS
--
-- staff_update_registrations is `for update using (with check)
-- staff_at_least('admin')`. That checks the CALLER'S ROLE and nothing about the
-- row that comes out: the WITH CHECK is the same expression as the USING, so it
-- passes whatever the new values are.
--
-- And trg_registrations_guard_update, which does protect identity, RETURNS EARLY
-- for staff:
--
--     if public.staff_at_least('admin') then
--       ... audit ...
--       return new;            <-- before any identity check
--     end if;
--     if new.user_id is distinct from old.user_id ... then raise ...
--
-- So today an admin can PATCH user_id, id or created_at on any registration.
-- That is survivable while the console only sends payment_status. It stops being
-- survivable the moment it sends everything an operator can type - the row could
-- be handed to another account, or its identity rewritten out from under the
-- audit log. Closing that is not a side effect of this file; it is the reason it
-- exists.
--
-- So the roster's edits go through staff_update_registration, which names the
-- columns it will ever write. Anything not on the list is not rejected field by
-- field - it is never read. id, user_id, created_at and updated_at are simply not
-- assignable, which is stronger than validating them after the fact.
--
-- WHY THE UTR AND THE STATUS ARE ONE DECISION
--
-- chk_registrations_utr_state says a UTR row may not carry a reference while it
-- is awaiting_utr, and may not lack one from unverified onward; a CASH row may
-- never carry one at all. So "paste the reference the participant read me off
-- their screen" is not one field - it is a reference AND a status, and a console
-- that sent them separately would either be refused by the CHECK with a raw
-- constraint name or leave the row inconsistent. The RPC makes the transition
-- itself, which is what the participant actually meant.
--
-- WHY CREATE IS COORDINATOR+
--
-- Reading is coordinator+, so writing a correction is admin+ - a coordinator may
-- look but not change, matching staffSetStatus. CREATE is the exception: taking a
-- registration at the desk is routine work and a reconciler doing it should not
-- have to escalate. It is still audited, and it can never claim to belong to a
-- participant: user_id is left null, and a row created at the desk is visibly
-- ownerless on the roster rather than pretending somebody signed up.
--
-- Idempotent: drop-if-exists + create.
-- =============================================================================
-- ---------------------------------------------------------------------------
-- 1. update: the roster's edit
-- ---------------------------------------------------------------------------
-- The editable set is a closed list, and it is a list of THINGS AN OPERATOR CAN
-- CORRECT rather than "every column except the dangerous ones". A new column
-- added by a later migration is therefore not editable until somebody decides it
-- should be, which is the safe default for a console.

create or replace function public.staff_update_registration (p_id uuid, p_patch jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before public.registrations%rowtype;
  v_after  public.registrations%rowtype;
  v_who    text;
  v_utr    text;
  v_status public.payment_status;
  v_method text;
  v_edits  jsonb := '{}'::jsonb;
  v_k      text;
begin
  if not public.staff_at_least('admin') then
    return jsonb_build_object('ok', false,
      'error', 'Only an administrator can edit a registration.');
  end if;

  if p_id is null then
    return jsonb_build_object('ok', false, 'error', 'No registration was named.');
  end if;

  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    return jsonb_build_object('ok', false,
      'error', 'Send the fields to change as an object.');
  end if;

  select s.username into v_who from public.staff_session() s;

  -- FOR UPDATE, so two operators editing the same row cannot interleave and lose
  -- one of the edits - the last writer would silently win.
  select * into v_before from public.registrations r where r.id = p_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'No such registration.');
  end if;

  -- THE COUPLE. Resolve what the row will END UP as before writing it, so the
  -- CHECK cannot be tripped by a combination nobody chose.
  v_method := case when p_patch ? 'payment_method'
                    then coalesce(nullif(btrim(p_patch ->> 'payment_method'), ''), 'utr')
                    else v_before.payment_method end;

  v_utr := case when p_patch ? 'utr_number'
                then nullif(btrim(coalesce(p_patch ->> 'utr_number', '')), '')
                else nullif(btrim(coalesce(v_before.utr_number, '')), '') end;

  if v_method = 'cash' and v_utr is not null then
    return jsonb_build_object('ok', false,
      'error', 'A cash registration never carries a reference. Clear it, or change the payment method to UPI first.');
  end if;

  -- A reference arriving is the moment the row stops being "awaiting": doing both
  -- together is what the participant meant, and doing them separately would be
  -- refused by the table CHECK with a name the operator cannot act on.
  if p_patch ? 'utr_number' and v_utr is not null then
    v_status := case when p_patch ? 'payment_status'
                      then (p_patch ->> 'payment_status')::public.payment_status
                      else case when v_before.payment_status = 'awaiting_utr'
                                  or v_before.payment_status = 'awaiting_cash'
                                  then 'unverified'::public.payment_status
                                  else v_before.payment_status end end;
  else
    v_status := case when p_patch ? 'payment_status'
                      then coalesce((p_patch ->> 'payment_status')::public.payment_status, v_before.payment_status)
                      else v_before.payment_status end;
  end if;

  -- Clearing the last reference is the one edit the CHECK forbids outright: the
  -- row would be unverified with nothing to verify. Said as a sentence, because
  -- the raw alternative is "chk_registrations_utr_state".
  if v_method = 'utr' and v_utr is null and v_status in ('unverified', 'verified') then
    return jsonb_build_object('ok', false,
      'error', 'That row is recorded as having a reference, so the reference cannot simply be emptied. Set the payment status to Rejected first.');
  end if;
-- The write. Every column is guarded on PRESENCE, so a partial edit changes what
  -- it names and leaves everything else alone - the same rule staff_upsert_event
  -- follows, for the same reason.
  --
  -- Absent from this list, deliberately: id, user_id, created_at, updated_at,
  -- payment_verified_at, utr_submitted_at, free_fire_id. Identity and timestamps
  -- are not operator-editable, and free_fire_id is superseded by event_id_value
  -- (migration ...037) - writing it back would let two columns hold different
  -- answers to the same question.
  update public.registrations r
     set name             = case when p_patch ? 'name' then nullif(btrim(p_patch ->> 'name'), '') else r.name end,
         email            = case when p_patch ? 'email' then lower(nullif(btrim(p_patch ->> 'email'), '')) else r.email end,
         phone_number     = case when p_patch ? 'phone_number' then nullif(btrim(p_patch ->> 'phone_number'), '') else r.phone_number end,
         roll_number      = case when p_patch ? 'roll_number' then nullif(btrim(p_patch ->> 'roll_number'), '') else r.roll_number end,
         college_name     = case when p_patch ? 'college_name' then nullif(btrim(p_patch ->> 'college_name'), '') else r.college_name end,
         year             = case when p_patch ? 'year' then nullif(btrim(p_patch ->> 'year'), '') else r.year end,
         department       = case when p_patch ? 'department' then nullif(btrim(p_patch ->> 'department'), '') else r.department end,
         team_name        = case when p_patch ? 'team_name' then nullif(btrim(p_patch ->> 'team_name'), '') else r.team_name end,
         event_id_value   = case when p_patch ? 'event_id_value' then nullif(btrim(p_patch ->> 'event_id_value'), '') else r.event_id_value end,
         purchase_type    = case when p_patch ? 'purchase_type' then nullif(btrim(p_patch ->> 'purchase_type'), '') else r.purchase_type end,
         purchase_ref     = case when p_patch ? 'purchase_ref' then nullif(btrim(p_patch ->> 'purchase_ref'), '') else r.purchase_ref end,
         purchase_label   = case when p_patch ? 'purchase_label' then nullif(btrim(p_patch ->> 'purchase_label'), '') else r.purchase_label end,
         purchase_amount  = case when p_patch ? 'purchase_amount' then (p_patch ->> 'purchase_amount')::integer else r.purchase_amount end,
         payment_method   = v_method,
         utr_number       = v_utr,
         payment_status   = v_status,
         -- Stamped, never typed: an operator confirming a payment is not
         -- back-dating it, and the sheet that reconciles reads this column.
         utr_submitted_at = case when p_patch ? 'utr_number' and v_utr is not null
                                   then coalesce(r.utr_submitted_at, now())
                                   else r.utr_submitted_at end,
         payment_verified_by = case when v_status = 'verified' and v_status is distinct from r.payment_status
                                     then v_who else r.payment_verified_by end,
         payment_verified_at = case when v_status = 'verified' and v_status is distinct from r.payment_status
                                     then now() else r.payment_verified_at end,
         selection_frozen = case when p_patch ? 'selection_frozen'
                                   then coalesce((p_patch ->> 'selection_frozen')::boolean, false)
                                   else r.selection_frozen end,
         selection_frozen_by = case when p_patch ? 'selection_frozen'
                                      and coalesce((p_patch ->> 'selection_frozen')::boolean, false)
                                      then v_who else r.selection_frozen_by end,
         selection_frozen_at = case when p_patch ? 'selection_frozen'
                                       and coalesce((p_patch ->> 'selection_frozen')::boolean, false)
                                       then now() else r.selection_frozen_at end,
         updated_at = now()
   where r.id = p_id
   returning * into v_after;
-- The diff, field by field, so the audit answers "what did this operator
  -- actually change?" without anyone reconstructing it. The trigger's own audit
  -- covers four columns only, which is why this file needs one of its own.
  -- `to_jsonb(v_before) ->> v_k`, NOT `v_before ->> v_k`: v_before is a
  -- %rowtype composite and the ->> operator does not exist on one. That raised
  -- 42883 AFTER the UPDATE had run, so every edit silently rolled back — the
  -- failure mode where the write appears to work and changes nothing.
  for v_k in
    select key from jsonb_each(p_patch)
     where key in ('name','email','phone_number','roll_number','college_name',
                   'year','department','team_name','event_id_value','purchase_type',
                   'purchase_ref','purchase_label','purchase_amount',
                   'payment_method','utr_number','payment_status','selection_frozen')
  loop
    v_edits := v_edits || jsonb_build_object(
      v_k,
      jsonb_build_object(
        'from', to_jsonb(v_before) ->> v_k,
        'to',   to_jsonb(v_after)  ->> v_k
      )
    );
  end loop;

  if v_edits = '{}'::jsonb then
    return jsonb_build_object('ok', true, 'id', p_id, 'changed', 0::int,
                              'error', 'Nothing was changed.');
  end if;

  perform public.staff_audit(
    'update_registration', 'registration', p_id::text,
    jsonb_build_object('fields', v_edits, 'by', v_who)
  );

  -- A subquery count, because Postgres has no jsonb_object_length: the
  -- json/jsonb family has jsonb_array_length for ARRAYS and nothing equivalent
  -- for objects. Calling a function that does not exist aborts the whole RPC
  -- AFTER the update and the audit have run, so the edit rolls back and the
  -- console reports a database error instead of saving.
  return jsonb_build_object(
    'ok', true, 'id', p_id,
    'changed', (select count(*)::int from jsonb_object_keys(v_edits))
  );
end;
$$;

comment on function public.staff_update_registration(uuid, jsonb) is
  'Admin+. Corrects a registration from the console: the UTR, a mistyped roll number, a wrong college, the identifier an event asks for. Writes a CLOSED list of columns - identity (id, user_id), timestamps and the superseded free_fire_id are not assignable at all, which is why this exists rather than a REST PATCH: the staff UPDATE policy checks the caller''s ROLE and nothing about the resulting row, so a PATCH could hand a registration to another account. A reference arriving also moves the status, because the two are one decision and the table CHECK refuses them apart.';

revoke execute on function public.staff_update_registration(uuid, jsonb) from public;
grant  execute on function public.staff_update_registration(uuid, jsonb) to anon, authenticated;
-- ---------------------------------------------------------------------------
-- 2. create: a registration taken at the desk
-- ---------------------------------------------------------------------------
-- Coordinator+, because taking a registration in person is routine work and the
-- person reconciling the cash float should not have to escalate to do it.
--
-- user_id is left NULL on purpose. trg_registrations_set_user_id stamps it from
-- the JWT, and a staff token has none - so the row stays ownerless and shows as
-- "no owner linked yet" on the roster. That is honest: nobody signed up on the
-- website, and a row that claimed otherwise would let that person later
-- "continue" a registration they never made.

create or replace function public.staff_create_registration (p_reg jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id      uuid;
  v_who     text;
  v_method  text;
  v_utr     text;
  v_status  public.payment_status;
  v_ref     text;
begin
  if not public.staff_at_least('coordinator') then
    return jsonb_build_object('ok', false, 'error', 'Not authorised.');
  end if;

  if p_reg is null or jsonb_typeof(p_reg) <> 'object' then
    return jsonb_build_object('ok', false, 'error', 'Send the registration as an object.');
  end if;

  if nullif(btrim(coalesce(p_reg ->> 'name', '')), '') is null
     or nullif(btrim(coalesce(p_reg ->> 'email', '')), '') is null then
    return jsonb_build_object('ok', false, 'error', 'A name and an email are required.');
  end if;

  select s.username into v_who from public.staff_session() s;

  v_method := coalesce(nullif(btrim(coalesce(p_reg ->> 'payment_method', '')), ''), 'utr');
  if v_method not in ('utr', 'cash') then
    return jsonb_build_object('ok', false, 'error', 'The payment method must be utr or cash.');
  end if;

  v_utr    := nullif(btrim(coalesce(p_reg ->> 'utr_number', '')), '');
  v_ref    := nullif(btrim(coalesce(p_reg ->> 'purchase_ref', '')), '');
  v_status := coalesce(nullif(btrim(coalesce(p_reg ->> 'payment_status', '')), ''), 'awaiting_utr')::public.payment_status;

  if v_method = 'cash' and v_utr is not null then
    return jsonb_build_object('ok', false, 'error', 'A cash registration never carries a reference.');
  end if;

  -- trg_registrations_event_id applies to this row exactly as it applies to a
  -- website registration: a desk entry for an event that asks for an identifier
  -- still has to bring one.
  insert into public.registrations
    (name, email, phone_number, roll_number, college_name, year, department,
     team_name, event_id_value, payment_method, payment_status, utr_number,
     utr_submitted_at, purchase_type, purchase_ref, purchase_label, purchase_amount)
  values
    (nullif(btrim(p_reg ->> 'name'), ''),
     lower(nullif(btrim(p_reg ->> 'email'), '')),
     nullif(btrim(coalesce(p_reg ->> 'phone_number', '')), ''),
     nullif(btrim(coalesce(p_reg ->> 'roll_number', '')), ''),
     nullif(btrim(coalesce(p_reg ->> 'college_name', '')), ''),
     nullif(btrim(coalesce(p_reg ->> 'year', '')), ''),
     nullif(btrim(coalesce(p_reg ->> 'department', '')), ''),
     nullif(btrim(coalesce(p_reg ->> 'team_name', '')), ''),
     nullif(btrim(coalesce(p_reg ->> 'event_id_value', '')), ''),
     v_method,
     v_status,
     v_utr,
     case when v_utr is not null then now() else null end,
     nullif(btrim(coalesce(p_reg ->> 'purchase_type', '')), ''),
     v_ref,
     nullif(btrim(coalesce(p_reg ->> 'purchase_label', '')), ''),
     (p_reg ->> 'purchase_amount')::integer)
  returning id into v_id;

  perform public.staff_audit(
    'create_registration', 'registration', v_id::text,
    jsonb_build_object('by', v_who, 'email', lower(btrim(p_reg ->> 'email')),
                       'purchase_ref', v_ref, 'method', v_method)
  );

  return jsonb_build_object('ok', true, 'id', v_id);
end;
$$;

comment on function public.staff_create_registration(jsonb) is
  'Coordinator+. Records a registration taken in person at the desk, for somebody who never registered on the website. user_id is left null on purpose: a staff token carries no JWT for the trigger to stamp, and a row that claimed an owner would let that person later "continue" a registration they never made. Refused by trg_registrations_event_id when the event asks for an identifier, exactly as a website registration would be.';

revoke execute on function public.staff_create_registration(jsonb) from public;
grant  execute on function public.staff_create_registration(jsonb) to anon, authenticated;
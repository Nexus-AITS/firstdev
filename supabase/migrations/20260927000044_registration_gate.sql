-- ---------------------------------------------------------------------------
-- 20260927000044 - the master registration gate
--
-- ONE SWITCH that stops new registrations for the whole site, and says so.
--
-- WHY IT IS ENFORCED IN THE DATABASE AND NOT IN THE BUTTON
--
-- Hiding or disabling the Register button is a courtesy, not a control. The
-- browser is not a trust boundary: the participant INSERT policy on
-- public.registrations is what actually lets a row in, so anybody with devtools
-- - or any script written against the public anon key, which is public by design
-- - could keep registering with the button gone. A switch that only moved the UI
-- would have produced exactly the situation this exists to prevent: the console
-- says CLOSED, the page says CLOSED, and the roster grows anyway.
--
-- So the control is a BEFORE INSERT trigger. The UI reads the same row to decide
-- what to show, which means the two can never disagree: one source of truth, and
-- the interface is a projection of it.
--
-- WHY IT LIVES ON site_settings
--
-- That table is already the single-row site-wide settings row
-- (chk_site_settings_single_row) and is already publicly readable. A second table
-- for one more boolean would have been a second place to look for "is
-- registration open", which is precisely the ambiguity a kill switch must not
-- have.
--
-- WHAT IT DOES NOT DO, stated rather than left to be discovered
--
-- It blocks NEW rows only. It deliberately does not block UPDATE: somebody who
-- registered an hour before the gates closed and has not pasted their UTR yet
-- must still be able to finish. Closing registration and stranding a
-- half-finished payment at the desk is a worse outcome than the one this is meant
-- to prevent. Staff writes are exempt too (see the trigger) so a master can still
-- add a walk-in on the door.
-- ---------------------------------------------------------------------------

alter table public.site_settings
  add column if not exists registrations_open boolean not null default true;

-- The message the public sees. A master has to be able to say WHY, because
-- "registrations closed" with no reason generates a queue of messages asking.
alter table public.site_settings
  add column if not exists registrations_note text;

-- When it was last CLOSED, not last changed: kept separately so the console can
-- say "closed 4 hours ago" without trusting the audit log.
alter table public.site_settings
  add column if not exists registrations_closed_at timestamptz;

comment on column public.site_settings.registrations_open is
  'The master kill switch for new registrations. Enforced by enforce_registration_gate() on INSERT, not by the UI.';

comment on column public.site_settings.registrations_note is
  'Why registration is closed, shown on the public pages. Blank falls back to a default sentence.';

-- The check constraint guarantees at most one row, not that one exists, and a
-- gate whose read returns nothing is a gate that is open or shut depending on how
-- the caller copes. Insert explicitly; the conflict clause keeps it to one row.
insert into public.site_settings (id, dashboard_url, registrations_open)
values (true, null, true)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- public_registration_gate() - what the SITE asks
-- ---------------------------------------------------------------------------
-- Public and unauthenticated, because a closed gate has to be readable by the
-- visitor who has to be told. It carries NO other column of site_settings: the
-- partner dashboard URL is an operations secret and this function is how the
-- browser gets its answer, so it returns four fields and not the row.
--
-- `ok` is always true and is never an error path: nothing here can fail in a way
-- a caller could handle, and a closed gate is an ANSWER, not a fault.
create or replace function public.public_registration_gate ()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'ok', true,
    'open', coalesce((select s.registrations_open from public.site_settings s), true),
    'note', (select s.registrations_note from public.site_settings s),
    'closed_at', (select s.registrations_closed_at from public.site_settings s)
  );
$$;

comment on function public.public_registration_gate() is
  'Whether new registrations are accepted site-wide, and the note shown when they are not. Public: a visitor who must be told has no session. Returns four fields rather than the row, so the partner dashboard URL stays an operations secret.';

revoke execute on function public.public_registration_gate() from public;
grant  execute on function public.public_registration_gate() to anon, authenticated;

-- ---------------------------------------------------------------------------
-- enforce_registration_gate() - the actual control
-- ---------------------------------------------------------------------------
-- BEFORE INSERT FOR EACH ROW, so it sits inside the same transaction as the write
-- it refuses: there is no window in which the row lands and the gate is noticed.
--
-- STAFF ARE EXEMPT via staff_at_least('coordinator'). That helper is STABLE
-- SECURITY DEFINER and reads the staff session from the request headers, so it
-- answers correctly inside a trigger. Without the exemption a master could not
-- add somebody standing at the door - and worse, the console own
-- staff_create_registration is SECURITY DEFINER, which bypasses RLS but NOT
-- triggers, so the exemption is the only thing keeping the console working.
create or replace function public.enforce_registration_gate ()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_open boolean;
  v_note text;
begin
  select s.registrations_open, s.registrations_note
    into v_open, v_note
    from public.site_settings s;

  -- No settings row means no gate. Failing closed on a missing row would take the
  -- whole site down the first time somebody cleared the table; failing open on a
  -- row that says false cannot happen, because that is a present row.
  if v_open is distinct from false then
    return new;
  end if;

  if public.staff_at_least('coordinator') then
    return new;
  end if;

  -- 23514 (check_violation) on purpose. It is what every other rule in this
  -- schema uses to refuse a write, so the site error handling already recognises
  -- it, and it is honest: this is a rule being enforced, not a crash.
  raise exception using
    errcode = '23514',
    message = coalesce(nullif(btrim(v_note), ''), 'Registrations are closed.'),
    detail = 'Registration closed by the organisers. This is a rule, not a fault.';
end;
$$;

comment on function public.enforce_registration_gate() is
  'BEFORE INSERT guard on registrations: refuses a new participant row while the master gate is closed. Blocks INSERT only, never UPDATE, so somebody who registered before the gates closed can still finish paying; staff are exempt so the console can still add a walk-in.';

drop trigger if exists trg_enforce_registration_gate on public.registrations;
create trigger trg_enforce_registration_gate
  before insert on public.registrations
  for each row execute function public.enforce_registration_gate();

-- ---------------------------------------------------------------------------
-- staff_set_registration_gate() - the master button
-- ---------------------------------------------------------------------------
-- MASTER ONLY, and deliberately not admin. Every other switch in this console
-- stops at admin; this one stops the whole site accepting money, so the person who
-- can close it should be the person who can reopen it, and nobody below them. An
-- admin who could click this could also un-click it, which makes the switch a
-- no-op with extra steps.
create or replace function public.staff_set_registration_gate (
  p_open boolean,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before boolean;
  v_after  jsonb;
begin
  if not public.staff_at_least('master') then
    return jsonb_build_object(
      'ok', false,
      'error', 'Only a master administrator can close or reopen registrations.'
    );
  end if;

  if p_open is null then
    return jsonb_build_object('ok', false, 'error', 'Say whether registration is open or closed.');
  end if;

  select s.registrations_open into v_before from public.site_settings s;

  update public.site_settings s
     set registrations_open      = p_open,
         registrations_note      = case when p_open then null
                                       else nullif(btrim(coalesce(p_note, '')), '')
                                  end,
         registrations_closed_at = case when p_open then null else now() end,
         updated_at              = now(),
         updated_by              = (select st.username from public.staff_session() st)
   where s.id = true
  returning jsonb_build_object(
              'open',      s.registrations_open,
              'note',      s.registrations_note,
              'closed_at', s.registrations_closed_at
            ) into v_after;

  -- The row is guaranteed by chk_site_settings_single_row plus the insert above,
  -- so not-found means the table was emptied out from under this function. Saying
  -- so beats reporting success for a switch that did not move.
  if not found then
    return jsonb_build_object(
      'ok', false,
      'error', 'The settings row is missing - registrations were not changed.'
    );
  end if;

  perform public.staff_audit(
    case when p_open then 'open_registrations' else 'close_registrations' end,
    'site',
    'registration_gate',
    jsonb_build_object('was_open', v_before, 'now', v_after)
  );

  return jsonb_build_object('ok', true, 'gate', v_after);
end;
$$;

comment on function public.staff_set_registration_gate(boolean, text) is
  'The master-only close/reopen switch. Sets site_settings.registrations_open, which enforce_registration_gate() enforces on every participant INSERT. Audited with the before and after states.';

revoke execute on function public.staff_set_registration_gate(boolean, text) from public;
grant  execute on function public.staff_set_registration_gate(boolean, text) to authenticated;

-- ---------------------------------------------------------------------------
-- staff_registration_gate() - what the CONSOLE asks
-- ---------------------------------------------------------------------------
-- Coordinator and up: anybody who can see the roster needs to know whether the
-- site is currently taking registrations, or they cannot explain to a participant
-- why their form stopped working.
create or replace function public.staff_registration_gate ()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case
           when public.staff_at_least('coordinator')
             then public.public_registration_gate()
           else jsonb_build_object('ok', false, 'error', 'Not authorised.')
         end;
$$;

comment on function public.staff_registration_gate() is
  'The registration gate for the console. Coordinator and up, so an operator looking at a participant who cannot register can see whether the gates are shut.';

revoke execute on function public.staff_registration_gate() from public;
grant  execute on function public.staff_registration_gate() to authenticated;

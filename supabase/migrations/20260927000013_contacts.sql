-- =============================================================================
-- NEXUS — contact details
-- Migration : 20260927000013_contacts.sql
-- Purpose   : A /contact page whose contents the operations team owns, rather
--             than an address and a phone number hardcoded in a React component
--             (which is why the numbers were wrong the last time they changed).
--
--             One row per way to reach NEXUS, each with the PURPOSE it is for
--             ("payment issues", "event queries"), because a participant asking
--             "where do I complain about my seat?" should not have to guess
--             which of four numbers is the right one.
--
-- Access shape, matching the catalogue exactly:
--   - the table itself has NO client write policy, and no read policy either:
--     the public page reads through public_contacts(), and the console reads
--     through staff_list_contacts(). A participant with a Supabase session gets
--     no more access to this table than an anonymous visitor does.
--   - both write paths are SECURITY DEFINER RPCs that re-check the staff role
--     themselves, so hiding the console tab is a courtesy, not the control.
--
-- Nothing is seeded. Inventing a phone number for a college fest is not a
-- helpful default — the first rows should be the real ones, typed by whoever
-- actually answers them, from the Contacts tab.
--
-- Idempotent: if-not-exists / create or replace / drop-if-exists + create.
-- =============================================================================

create table if not exists public.contacts (
  id          uuid primary key default gen_random_uuid(),
  kind        text        not null default 'email',
  label       text        not null,
  purpose     text,
  value       text        not null,
  note        text,
  is_active   boolean     not null default true,
  sort_order  integer     not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  updated_by  text
);

comment on table public.contacts is
  'How to reach NEXUS. Rows are created and retired from the console''s Contacts tab; the public /contact page reads only the active ones, through public_contacts().';

-- The kind decides how the page turns the value into a link, so the two common
-- mistakes are refused at the source: a phone number filed under "email", and an
-- address with no @ in it. A `website` or `text` row (an office address, say) is
-- left unconstrained on purpose.
alter table public.contacts
  drop constraint if exists contacts_kind_check;
alter table public.contacts
  add constraint contacts_kind_check
  check (kind in ('email', 'phone', 'website', 'text'));

alter table public.contacts
  drop constraint if exists contacts_value_matches_kind;
alter table public.contacts
  add constraint contacts_value_matches_kind
  check (
    (kind <> 'email'  or value ~ '@')
    and (kind <> 'phone' or value ~ '[0-9]')
  );

create index if not exists ix_contacts_active_order
  on public.contacts (sort_order, created_at)
  where is_active;

-- RLS with no policies at all: every read goes through a function that decides
-- what the caller may see. Enabled anyway, so that adding a policy later is a
-- deliberate act rather than an accident.
alter table public.contacts enable row level security;

-- ---------------------------------------------------------------------------
-- public_contacts() — what the /contact page renders
-- ---------------------------------------------------------------------------
create or replace function public.public_contacts ()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', c.id,
             'kind', c.kind,
             'label', c.label,
             'purpose', c.purpose,
             'value', c.value,
             'note', c.note,
             'sort_order', c.sort_order
           ) order by c.sort_order, c.created_at)
      from public.contacts c
     where c.is_active
  ), '[]'::jsonb);
$$;

comment on function public.public_contacts is
  'Active contact rows, ordered. Public by design: it returns exactly what the /contact page shows and nothing that has been retired.';

revoke execute on function public.public_contacts() from public;
grant execute on function public.public_contacts() to anon, authenticated;

-- ---------------------------------------------------------------------------
-- staff_list_contacts() — the console's list, retired rows included
-- ---------------------------------------------------------------------------
-- A retired contact is not the same as a deleted one: participants may have
-- written the number down, and the audit trail is the record of what was
-- published. So the console needs to see is_active = false rows to re-activate
-- or to understand what used to be there.
create or replace function public.staff_list_contacts ()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.staff_at_least('coordinator') then
    return jsonb_build_object('ok', false,
      'error', 'Only the operations team can read the contact list.');
  end if;

  return jsonb_build_object(
    'ok', true,
    'contacts', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', c.id, 'kind', c.kind, 'label', c.label, 'purpose', c.purpose,
               'value', c.value, 'note', c.note, 'is_active', c.is_active,
               'sort_order', c.sort_order, 'updated_at', c.updated_at,
               'updated_by', c.updated_by
             ) order by c.sort_order, c.created_at)
        from public.contacts c
    ), '[]'::jsonb)
  );
end;
$$;

revoke execute on function public.staff_list_contacts() from public;
grant execute on function public.staff_list_contacts() to anon, authenticated;

-- ---------------------------------------------------------------------------
-- staff_upsert_contact() — create or edit one row
-- ---------------------------------------------------------------------------
-- `p_contact` carries the id when editing and omits it when creating, the same
-- contract staff_upsert_event uses.
--
-- The write is ADMIN+, not master-only: contact details are what a participant
-- reads when something has gone wrong, and the operations team that verifies
-- payments is the same team that answers the phone. If you would rather keep it
-- to masters, it is the one `staff_at_least('admin')` below.
create or replace function public.staff_upsert_contact (p_contact jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id    uuid := nullif(trim(coalesce(p_contact ->> 'id', '')), '')::uuid;
  v_kind  text := lower(nullif(trim(coalesce(p_contact ->> 'kind', 'email')), ''));
  v_label text := nullif(trim(coalesce(p_contact ->> 'label', '')), '');
  v_value text := nullif(trim(coalesce(p_contact ->> 'value', '')), '');
  v_new   boolean;
begin
  if not public.staff_at_least('admin') then
    return jsonb_build_object('ok', false,
      'error', 'Only an administrator can change the contact list.');
  end if;

  if v_kind is null or v_kind not in ('email', 'phone', 'website', 'text') then
    return jsonb_build_object('ok', false,
      'error', 'Choose what this is: email, phone, website or text.');
  end if;

  if v_label is null then
    return jsonb_build_object('ok', false, 'error', 'Give this contact a label, e.g. "Payment help".');
  end if;

  if v_value is null then
    return jsonb_build_object('ok', false, 'error', 'A contact needs a value to contact you on.');
  end if;

  -- The same guard the table has, raised as a message the operator can act on
  -- instead of a constraint violation with a constraint name in it.
  if v_kind = 'email' and v_value !~ '@' then
    return jsonb_build_object('ok', false, 'error', 'That does not look like an email address.');
  end if;
  if v_kind = 'phone' and v_value !~ '[0-9]' then
    return jsonb_build_object('ok', false, 'error', 'That does not look like a phone number.');
  end if;

  select not exists (select 1 from public.contacts c where c.id = v_id) into v_new;

  insert into public.contacts as c
    (id, kind, label, purpose, value, note, is_active, sort_order, updated_by)
  values
    (coalesce(v_id, gen_random_uuid()),
     v_kind,
     v_label,
     nullif(trim(coalesce(p_contact ->> 'purpose', '')), ''),
     v_value,
     nullif(trim(coalesce(p_contact ->> 'note', '')), ''),
     coalesce((p_contact ->> 'is_active')::boolean, true),
     coalesce(nullif(trim(p_contact ->> 'sort_order'), '')::int, 0),
     (select s.username from public.staff_session() s))
  on conflict (id) do update
     set kind       = excluded.kind,
         label      = excluded.label,
         purpose    = excluded.purpose,
         value      = excluded.value,
         note       = excluded.note,
         is_active  = excluded.is_active,
         sort_order = excluded.sort_order,
         updated_at = now(),
         updated_by = excluded.updated_by
  returning c.id into v_id;

  perform public.staff_audit(
    case when v_new then 'create_contact' else 'update_contact' end,
    'contact', v_id::text,
    jsonb_build_object('label', v_label, 'kind', v_kind, 'value', v_value)
  );

  return jsonb_build_object('ok', true, 'id', v_id, 'created', v_new);
end;
$$;

revoke execute on function public.staff_upsert_contact(jsonb) from public;
grant execute on function public.staff_upsert_contact(jsonb) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- staff_retire_contact() — take one off the public page
-- ---------------------------------------------------------------------------
-- Retire, never delete: a phone number a participant already has written down
-- does not stop existing because we hide it, and the audit trail is the record
-- of what was published. Re-publishing is an upsert with is_active = true.
create or replace function public.staff_retire_contact (p_contact_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_label text;
begin
  if not public.staff_at_least('admin') then
    return jsonb_build_object('ok', false,
      'error', 'Only an administrator can change the contact list.');
  end if;

  update public.contacts c
     set is_active = false, updated_at = now(),
         updated_by = (select s.username from public.staff_session() s)
   where c.id = p_contact_id
  returning c.label into v_label;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'No such contact.');
  end if;

  perform public.staff_audit('retire_contact', 'contact', p_contact_id::text,
                             jsonb_build_object('label', v_label));
  return jsonb_build_object('ok', true, 'id', p_contact_id);
end;
$$;

revoke execute on function public.staff_retire_contact(uuid) from public;
grant execute on function public.staff_retire_contact(uuid) to anon, authenticated;

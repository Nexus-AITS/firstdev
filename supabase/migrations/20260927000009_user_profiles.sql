-- =============================================================================
-- NEXUS — participant profiles
-- Migration : 20260927000009_user_profiles.sql
-- Purpose   : One row per signed-in participant holding
--             (a) what the social login said about them — provider, subject id,
--                 avatar, raw metadata, last sign-in — captured automatically,
--             and
--             (b) the details the /register wizard asks for — roll number,
--                 college, year, department, phone — so a participant enters
--                 them once and every later registration is prefilled.
--
--             The row is written by a trigger on auth.users, NOT by the
--             client: there is no INSERT policy below, so a participant cannot
--             fabricate a profile for anyone else, and the social columns
--             cannot be edited by the person they describe.
-- Idempotent: if-not-exists / create or replace / drop-if-exists + create.
-- =============================================================================

create table if not exists public.user_profiles (
  user_id         uuid primary key references auth.users (id) on delete cascade,
  -- identity, mirrored from auth.users ----------------------------------
  email           text,
  full_name       text,
  avatar_url      text,
  auth_provider   text,
  provider_id     text,
  user_metadata   jsonb,
  last_sign_in_at timestamptz,
  -- registration details, owned by the participant -----------------------
  roll_number     text,
  college_name    text,
  year            text,
  department      text,
  phone_number    text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on table public.user_profiles is
  'Per-participant profile. The identity columns are mirrored from auth.users by trg_user_profiles_sync and are not client-writable; the registration columns belong to the participant and prefill the /register wizard.';

comment on column public.user_profiles.provider_id is
  'Social subject id (the Google `sub`), read from auth.identities. It may be null on the very first insert because GoTrue writes the identity row after the user row; the UPDATE trigger fills it in.';

create index if not exists ix_user_profiles_college
  on public.user_profiles (lower(btrim(college_name)));

-- updated_at is a database concern, like every other timestamp in this schema:
-- a browser clock is not a trustworthy source and this column exists to sort on.
drop trigger if exists trg_user_profiles_touch on public.user_profiles;
create trigger trg_user_profiles_touch
  before update on public.user_profiles
  for each row
  execute function public.set_updated_at ();

-- ---------------------------------------------------------------------------
-- social-login sync
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER, and it has to be: the trigger fires in the role that
-- writes auth.users (supabase_auth_admin), which has no rights on a
-- public table with row level security and no policy for it. The function is
-- owned by the role running this migration, so the write goes through without
-- exposing an invoker-writable path — the client still has no INSERT policy.
--
-- search_path is pinned empty and every reference is schema-qualified, so a
-- caller-controlled search_path cannot redirect any of it.
create or replace function public.sync_user_profile ()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_provider   text := coalesce(new.raw_app_meta_data ->> 'provider', 'email');
  v_meta       jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  v_subject    text;
  v_name       text;
  v_avatar     text;
begin
  -- The subject id lives on the identity row, which GoTrue may not have
  -- written yet when this fires for a brand-new user.
  select i.provider_id into v_subject
    from auth.identities i
   where i.user_id = new.id
     and i.provider = v_provider
   limit 1;

  v_name := nullif(
    coalesce(v_meta ->> 'full_name', v_meta ->> 'name', v_meta ->> 'user_name', ''),
    ''
  );
  v_avatar := nullif(coalesce(v_meta ->> 'avatar_url', v_meta ->> 'picture', ''), '');

  insert into public.user_profiles (
    user_id, email, full_name, avatar_url, auth_provider, provider_id,
    user_metadata, last_sign_in_at
  ) values (
    new.id,
    new.email,
    coalesce(v_name, split_part(coalesce(new.email, ''), '@', 1)),
    v_avatar,
    v_provider,
    v_subject,
    v_meta,
    new.last_sign_in_at
  )
  on conflict (user_id) do update
    -- Only the identity half is refreshed. roll_number / college_name / year /
    -- department / phone_number / full_name are the participant's own: a later
    -- sign-in must not overwrite what they typed on their profile, and
    -- full_name is deliberately NOT refreshed for the same reason — it is
    -- seeded from the social name at creation and then belongs to them.
    set email           = excluded.email,
        avatar_url      = coalesce(excluded.avatar_url, user_profiles.avatar_url),
        auth_provider   = excluded.auth_provider,
        provider_id     = coalesce(user_profiles.provider_id, excluded.provider_id),
        user_metadata   = excluded.user_metadata,
        last_sign_in_at = greatest(
          coalesce(user_profiles.last_sign_in_at, excluded.last_sign_in_at),
          coalesce(excluded.last_sign_in_at, user_profiles.last_sign_in_at)
        );

  return new;
end;
$$;

revoke execute on function public.sync_user_profile () from public, anon;
grant execute on function public.sync_user_profile () to supabase_auth_admin;

drop trigger if exists trg_user_profiles_sync on auth.users;
create trigger trg_user_profiles_sync
  after insert or update on auth.users
  for each row
  execute function public.sync_user_profile ();

-- ---------------------------------------------------------------------------
-- backfill: everyone who signed in BEFORE this migration
-- ---------------------------------------------------------------------------
-- The trigger only sees rows that are written from now on, so without this the
-- first cohort of participants — every existing Google account — would have no
-- profile until their next sign-in. `where not exists` keeps the rerun a no-op
-- and can never overwrite a profile that already exists.
insert into public.user_profiles (
  user_id, email, full_name, avatar_url, auth_provider, provider_id,
  user_metadata, last_sign_in_at
)
select
  u.id,
  u.email,
  coalesce(
    nullif(coalesce(u.raw_user_meta_data ->> 'full_name',
                    u.raw_user_meta_data ->> 'name',
                    u.raw_user_meta_data ->> 'user_name', ''), ''),
    split_part(coalesce(u.email, ''), '@', 1)
  ),
  nullif(coalesce(u.raw_user_meta_data ->> 'avatar_url',
                  u.raw_user_meta_data ->> 'picture', ''), ''),
  coalesce(u.raw_app_meta_data ->> 'provider', 'email'),
  (select i.provider_id
     from auth.identities i
    where i.user_id = u.id and i.provider = coalesce(u.raw_app_meta_data ->> 'provider', 'email')
    limit 1),
  coalesce(u.raw_user_meta_data, '{}'::jsonb),
  u.last_sign_in_at
  from auth.users u
 where not exists (
   select 1 from public.user_profiles p where p.user_id = u.id
 );

-- ---------------------------------------------------------------------------
-- ensure_my_profile() — the read the browser actually calls
-- ---------------------------------------------------------------------------
-- Returns the caller's row, creating it first if it does not exist. The
-- "creating it first" half is what makes the endpoint safe to call on every
-- page load: a participant whose row was somehow missed (a sign-up that raced
-- the migration, a restored database) gets a profile instead of an empty form
-- with no way to save it.
create or replace function public.ensure_my_profile ()
returns setof public.user_profiles
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid ();
begin
  if v_uid is null then
    return;
  end if;

  insert into public.user_profiles (
    user_id, email, full_name, avatar_url, auth_provider, provider_id,
    user_metadata, last_sign_in_at
  )
  select
    u.id, u.email,
    coalesce(
      nullif(coalesce(u.raw_user_meta_data ->> 'full_name',
                      u.raw_user_meta_data ->> 'name',
                      u.raw_user_meta_data ->> 'user_name', ''), ''),
      split_part(coalesce(u.email, ''), '@', 1)
    ),
    nullif(coalesce(u.raw_user_meta_data ->> 'avatar_url',
                    u.raw_user_meta_data ->> 'picture', ''), ''),
    coalesce(u.raw_app_meta_data ->> 'provider', 'email'),
    (select i.provider_id
       from auth.identities i
      where i.user_id = u.id
        and i.provider = coalesce(u.raw_app_meta_data ->> 'provider', 'email')
      limit 1),
    coalesce(u.raw_user_meta_data, '{}'::jsonb),
    u.last_sign_in_at
    from auth.users u
   where u.id = v_uid
  on conflict (user_id) do nothing;

  return query
    select * from public.user_profiles where user_id = v_uid;
end;
$$;

revoke execute on function public.ensure_my_profile () from public, anon;
grant execute on function public.ensure_my_profile () to authenticated;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
-- Two facts are being enforced:
--   * a participant sees and edits ONLY their own profile;
--   * nobody — participant included — can insert or delete one. Creation is the
--     trigger's job and deletion follows auth.users via the foreign key, so
--     there is deliberately no INSERT / DELETE policy to leave open.
alter table public.user_profiles enable row level security;

drop policy if exists participant_read_own_profile on public.user_profiles;
create policy participant_read_own_profile
  on public.user_profiles
  for select
  to authenticated
  using (user_id = auth.uid());

drop policy if exists participant_update_own_profile on public.user_profiles;
create policy participant_update_own_profile
  on public.user_profiles
  for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Support view: the operations team can read a participant's profile when
-- answering "you registered for what?". Read-only — the console has no business
-- editing someone's college.
--
-- `to anon, authenticated`, matching every other staff policy in …0004: the
-- console authenticates with staff_login and sends the anon key, so its requests
-- run in the anon role. A staff policy scoped `to authenticated` alone would
-- never apply to the very callers it is written for.
-- The `(select …)` wrapper keeps the function call out of the per-row path,
-- exactly as the staff policies in …0004 do.
drop policy if exists staff_read_user_profiles on public.user_profiles;
create policy staff_read_user_profiles
  on public.user_profiles
  for select
  to anon, authenticated
  using ((select public.staff_at_least ('coordinator')));

-- anon is the CONSOLE's role, not an anonymous visitor: a staff member has no
-- Supabase session, so their requests carry the anon key and are identified only
-- by the X-Nexus-Staff-Token header. They get SELECT because RLS narrows, it
-- does not grant — without the table privilege, staff_read_user_profiles would
-- never even be evaluated. Deliberately no UPDATE/DELETE for anon: the console
-- reads profiles for support and has no business editing anyone's college.
revoke insert, update, delete, truncate, references, trigger on public.user_profiles from anon;
revoke insert, delete, truncate, references, trigger on public.user_profiles from authenticated;

grant select on public.user_profiles to anon;
grant select, update on public.user_profiles to authenticated;

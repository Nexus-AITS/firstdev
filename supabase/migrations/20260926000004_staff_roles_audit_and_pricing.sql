-- =============================================================================
-- NEXUS — staff accounts, roles, audit trail, and DB-owned pricing
-- Migration : 20260926000004_staff_roles_audit_and_pricing.sql
-- Purpose   : Phase 3. Replaces the Supabase-Auth admin path with a fully
--             independent staff system, and moves pricing into the database.
--
-- Why a separate system: Phase 2 authorised operators by a row in
-- public.admin_users, i.e. by a Supabase Auth account. That tied admin access
-- to the *same* identity provider as the participant Google sign-in — one
-- compromised or shared Google session was one step from the roster. Staff
-- accounts here are username + password only, so a social login can never
-- reach them. The two systems share no table, no session and no token.
--
-- Roles (enforced by RLS, not by the page):
--   master        — everything, including staff management and pricing
--   admin         — accept / reject / correct participants
--   coordinator   — read and search only
--
-- Sessions are opaque tokens, stored hashed, with a hard 60-minute expiry
-- enforced in the database. Nothing in the browser can extend them.
--
-- Idempotent: drop-if-exists + create; safe to run more than once.
-- =============================================================================

-- 1) staff roles ---------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_type
     where typname = 'staff_role' and typnamespace = 'public'::regnamespace
  ) then
    create type public.staff_role as enum ('master', 'admin', 'coordinator');
  end if;
end
$$;

-- 2) staff accounts -----------------------------------------------------------
-- password_hash is a pgcrypto bcrypt digest. bcrypt is deliberately slow,
-- which is the property that makes an offline guessing attack expensive.
create table if not exists public.staff_users (
  id              uuid primary key default gen_random_uuid(),
  username        text        not null,
  password_hash   text        not null,
  full_name       text,
  role            public.staff_role not null default 'coordinator',
  is_active       boolean     not null default true,
  -- brute-force brakes: a locked account cannot even be attempted
  failed_attempts int         not null default 0,
  locked_until    timestamptz,
  last_login_at   timestamptz,
  created_at      timestamptz not null default now(),
  created_by      text,
  constraint chk_staff_users_username
    check (username ~ '^[a-z0-9._-]{3,32}$')
);

-- Case-insensitive uniqueness without depending on the citext extension.
create unique index if not exists uq_staff_users_username
  on public.staff_users (lower(username));

comment on table public.staff_users is
  'NEXUS operations staff. Username + bcrypt password only — deliberately NOT Supabase Auth, so no social login can ever grant roster access.';
comment on column public.staff_users.role is
  'master = everything incl. staff + pricing; admin = accept/reject participants; coordinator = read + search only.';


-- 3) staff sessions -----------------------------------------------------------
-- token_hash is sha256 of the opaque token, never the token itself: a database
-- dump therefore yields no usable live session.
create table if not exists public.staff_sessions (
  id         uuid primary key default gen_random_uuid(),
  staff_id   uuid        not null references public.staff_users (id) on delete cascade,
  token_hash text        not null,
  created_at timestamptz not null default now(),
  -- hard 60-minute cap, set at issue time
  expires_at timestamptz not null,
  revoked_at timestamptz,
  ip         text,
  user_agent text
);

create unique index if not exists uq_staff_sessions_token_hash
  on public.staff_sessions (token_hash);
create index if not exists ix_staff_sessions_staff_id
  on public.staff_sessions (staff_id);
create index if not exists ix_staff_sessions_expires_at
  on public.staff_sessions (expires_at);

-- 4) audit trail --------------------------------------------------------------
-- Append-only. Every state change on a registration is written by a trigger, so
-- it is recorded no matter which client caused it and cannot be skipped.
create table if not exists public.staff_audit_log (
  id         bigserial primary key,
  staff_id   uuid references public.staff_users (id) on delete set null,
  username   text,
  role       public.staff_role,
  action     text not null,
  entity     text not null,
  entity_id  text,
  details    jsonb,
  created_at timestamptz not null default now()
);

create index if not exists ix_staff_audit_created_at
  on public.staff_audit_log (created_at desc);
create index if not exists ix_staff_audit_entity
  on public.staff_audit_log (entity, entity_id);
create index if not exists ix_staff_audit_staff
  on public.staff_audit_log (staff_id, created_at desc);

comment on table public.staff_audit_log is
  'Append-only record of every staff action: who, which role, what, to which row, and when. Written server-side (trigger or SECURITY DEFINER function) so a client cannot omit an entry.';

-- 5) pricing ------------------------------------------------------------------
-- Public read: prices are already shown on the public events and bundled pages,
-- so this exposes no new information. Writes are master-only.
create table if not exists public.pricing (
  id         uuid primary key default gen_random_uuid(),
  kind       text        not null,   -- 'bundle' | 'event'
  ref_id     text        not null,   -- bundles.js id / events.js id
  price      integer     not null,   -- INR; 0 means FREE, never null
  is_active  boolean     not null default true,
  updated_at timestamptz not null default now(),
  updated_by text,
  constraint chk_pricing_kind check (kind in ('bundle', 'event')),
  constraint chk_pricing_price check (price >= 0 and price <= 1000000)
);

create unique index if not exists uq_pricing_ref
  on public.pricing (kind, ref_id);

comment on table public.pricing is
  'Source of truth for bundle and event prices. Read publicly; written only by a master via the admin panel. The JS constants are a fallback for when the database is unreachable, never the authority.';


-- 6) session resolution --------------------------------------------------------
-- The session shape is a real composite TYPE, not just a `returns table(...)`.
-- A function's rowtype cannot be used in a %rowtype declaration, and
-- staff_audit / staff_login / staff_update all need to hold one in a variable.
-- Declaring the type first is what makes `public.staff_session%rowtype` legal.
do $$
begin
  if not exists (
    select 1 from pg_type
     where typname = 'staff_session' and typnamespace = 'public'::regnamespace
  ) then
    create type public.staff_session as (
      id         uuid,
      username   text,
      full_name  text,
      role       public.staff_role,
      session_id uuid,
      expires_at timestamptz
    );
  end if;
end
$$;

-- sha256 hex of the raw token. Defined first because staff_session() calls it,
-- and Postgres validates a `language sql` body at creation time. The column
-- therefore never holds the token itself, and the lookup is one indexed hit.
create or replace function public.staff_token_hash (p_token text)
returns text
language sql
immutable
as $$
  select case
    when p_token is null or p_token = '' then null
    else encode(sha256(convert_to(p_token, 'UTF8')), 'hex')
  end;
$$;

-- PostgREST exposes incoming headers as a JSON GUC. The client sends the staff
-- token in X-Nexus-Staff-Token; this resolves it to a live staff row. Expiry,
-- revocation and deactivation are all checked HERE, so a 60-minute session
-- really ends after 60 minutes no matter what the browser believes.
create or replace function public.staff_session ()
returns public.staff_session
language sql
stable
security definer
set search_path = ''
as $$
  select row(s.id, s.username, s.full_name, s.role, sess.id, sess.expires_at)
    from public.staff_sessions sess
    join public.staff_users s on s.id = sess.staff_id
   where sess.token_hash = public.staff_token_hash(
           coalesce(
             current_setting('request.headers', true)::jsonb ->> 'x-nexus-staff-token',
             ''
           )
         )
     and sess.revoked_at is null
     and sess.expires_at > now()
     and s.is_active
   limit 1;
$$;

revoke execute on function public.staff_session () from public;
grant execute on function public.staff_session () to anon, authenticated;

-- Current role, or NULL when there is no live session. This is the single
-- predicate every staff RLS policy consults.
create or replace function public.staff_role ()
returns public.staff_role
language sql
stable
security definer
set search_path = ''
as $$
  select (select role from public.staff_session());
$$;

revoke execute on function public.staff_role () from public;
grant execute on function public.staff_role () to anon, authenticated;

-- At-least-a-role helper. Ranks the enum so 'is this an admin or better?' is a
-- comparison rather than an enumeration the caller has to keep in sync.
create or replace function public.staff_at_least (p_role public.staff_role)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    case public.staff_role()
      when 'master'       then 3
      when 'admin'        then 2
      when 'coordinator'  then 1
      else 0
    end >= case p_role
      when 'master'       then 3
      when 'admin'        then 2
      when 'coordinator'  then 1
      else 0
    end,
    false
  );
$$;

revoke execute on function public.staff_at_least (public.staff_role) from public;
grant execute on function public.staff_at_least (public.staff_role) to anon, authenticated;


-- 7) audit writer --------------------------------------------------------------
-- pgcrypto is installed in the `extensions` schema on Supabase, and every
-- function below pins `search_path = ''` as a hardening measure. Those two facts
-- together mean pgcrypto must be schema-QUALIFIED: an unqualified `gen_salt()`
-- is unresolvable under an empty search_path, and the failure is at runtime
-- (inside a function body) rather than at migration time.
--
-- Every staff action funnels through here so the shape of an entry is decided
-- in one place. SECURITY DEFINER because the callers may not hold INSERT on the
-- log themselves — that is the point: a client cannot record an action, and
-- the database records it whether or not the client wants it to.
create or replace function public.staff_audit (
  p_action  text,
  p_entity  text,
  p_entity_id text default null,
  p_details jsonb default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session public.staff_session%rowtype;
begin
  select * into v_session from public.staff_session();
  -- A NULL session means this was not a staff action (a participant editing
  -- their own details); those are not staff actions and are not logged here.
  if v_session.id is null then
    return;
  end if;

  insert into public.staff_audit_log
    (staff_id, username, role, action, entity, entity_id, details)
  values
    (v_session.id, v_session.username, v_session.role,
     p_action, p_entity, p_entity_id, p_details);
end;
$$;

revoke execute on function public.staff_audit (text, text, text, jsonb) from public;

-- 8) login / logout -----------------------------------------------------------
-- `drop ... cascade` before each redefinition: CREATE OR REPLACE keeps the
-- existing body, so an edited function body would silently not be applied. The
-- dependent RLS policies are recreated further down in this same file.
drop function if exists public.staff_login (text, text, text, text) cascade;

-- A deliberately generic failure message. Distinguishing "no such user" from
-- "wrong password" would turn this into a username enumeration oracle.
create or replace function public.staff_login (
  p_username text,
  p_password text,
  p_ip       text default null,
  p_agent    text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user       public.staff_users%rowtype;
  v_token      text;
  v_session_id uuid;
  v_expires    timestamptz;
  v_fail       text;
begin
  v_fail := 'Those credentials were not recognised.';

  select * into v_user
    from public.staff_users
   where lower(username) = lower(trim(coalesce(p_username, '')))
   limit 1;

  -- Compare against a real bcrypt hash even when no user matched, so a missing
  -- username and a wrong password take the same time. A timing difference here
  -- is enough to enumerate valid usernames.
  if v_user.id is null then
    perform extensions.crypt(coalesce(p_password, ''), extensions.gen_salt('bf', 10));
    return jsonb_build_object('ok', false, 'error', v_fail);
  end if;

  -- Brute-force brake: 5 failures locks the account for 15 minutes.
  if v_user.locked_until is not null and v_user.locked_until > now() then
    return jsonb_build_object(
      'ok', false,
      'error', 'This account is temporarily locked. Try again shortly.'
    );
  end if;

  if not v_user.is_active then
    return jsonb_build_object('ok', false, 'error', 'This account is not active.');
  end if;

  if v_user.password_hash is distinct from extensions.crypt(coalesce(p_password, ''), v_user.password_hash) then
    update public.staff_users
       set failed_attempts = failed_attempts + 1,
           locked_until = case when failed_attempts + 1 >= 5
                                then now() + interval '15 minutes'
                                else locked_until end
     where id = v_user.id;
    return jsonb_build_object('ok', false, 'error', v_fail);
  end if;

  -- Success: mint an opaque token. 256 bits of entropy from the database's
  -- CSPRNG. pgcrypto is qualified for the same reason as `extensions.crypt`.
  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  v_expires := now() + interval '60 minutes';

  insert into public.staff_sessions (staff_id, token_hash, expires_at, ip, user_agent)
  values (v_user.id, public.staff_token_hash(v_token), v_expires, p_ip, p_agent)
  returning id into v_session_id;

  update public.staff_users
     set failed_attempts = 0, locked_until = null, last_login_at = now()
   where id = v_user.id;

  insert into public.staff_audit_log (staff_id, username, role, action, entity, entity_id, details)
  values (v_user.id, v_user.username, v_user.role, 'login', 'staff_session', v_session_id::text,
          jsonb_build_object('ip', p_ip));

  return jsonb_build_object(
    'ok', true,
    'token', v_token,
    'username', v_user.username,
    'full_name', v_user.full_name,
    'role', v_user.role,
    'expires_at', v_expires
  );
end;
$$;

revoke execute on function public.staff_login (text, text, text, text) from public;
-- Granted to anon on purpose: there is no session yet at login time, and this
-- function is the only way to obtain one.
grant execute on function public.staff_login (text, text, text, text) to anon, authenticated;

-- Explicit sign-out. Revokes THIS session only — a staff member signing out on
-- one machine must not end their session on another.
create or replace function public.staff_logout ()
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session public.staff_session%rowtype;
begin
  select * into v_session from public.staff_session();
  if v_session.id is null then
    return false;
  end if;

  update public.staff_sessions set revoked_at = now() where id = v_session.session_id;

  insert into public.staff_audit_log (staff_id, username, role, action, entity, entity_id)
  values (v_session.id, v_session.username, v_session.role, 'logout', 'staff_session',
          v_session.session_id::text);

  return true;
end;
$$;

revoke execute on function public.staff_logout () from public;
grant execute on function public.staff_logout () to anon, authenticated;


-- 9) staff management (master only) --------------------------------------------
-- Everything here re-checks the role in the function body as well as in the
-- RLS policy on staff_users. Defence in depth: even if a policy were dropped,
-- the function still refuses.
create or replace function public.staff_create (
  p_username text,
  p_password text,
  p_full_name text,
  p_role     public.staff_role
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me      public.staff_session%rowtype;
  v_user_id uuid;
begin
  select * into v_me from public.staff_session();
  if v_me.role is distinct from 'master' then
    return jsonb_build_object('ok', false, 'error', 'Only a master administrator can add staff.');
  end if;

  if coalesce(trim(p_username), '') !~ '^[a-z0-9._-]{3,32}$' then
    return jsonb_build_object('ok', false,
      'error', 'Username must be 3–32 characters: a–z, 0–9, dot, dash, underscore.');
  end if;

  -- Length floor only; strength is the operator's call, not a policy's.
  if length(coalesce(p_password, '')) < 10 then
    return jsonb_build_object('ok', false, 'error', 'Password must be at least 10 characters.');
  end if;

  if exists (select 1 from public.staff_users where lower(username) = lower(trim(p_username))) then
    return jsonb_build_object('ok', false, 'error', 'That username is already taken.');
  end if;

  insert into public.staff_users (username, password_hash, full_name, role, created_by)
  values (trim(p_username), extensions.crypt(p_password, extensions.gen_salt('bf', 10)),
          nullif(trim(p_full_name), ''), p_role, v_me.username)
  returning id into v_user_id;

  insert into public.staff_audit_log (staff_id, username, role, action, entity, entity_id, details)
  values (v_me.id, v_me.username, v_me.role, 'create_staff', 'staff_user', v_user_id::text,
          jsonb_build_object('new_username', trim(p_username), 'new_role', p_role));

  return jsonb_build_object('ok', true, 'id', v_user_id);
end;
$$;

revoke execute on function public.staff_create (text, text, text, public.staff_role) from public;
grant execute on function public.staff_create (text, text, text, public.staff_role)
  to anon, authenticated;


-- Activate / deactivate, change role, or reset a password. One function with
-- NULLs meaning "leave alone" keeps the audit surface small: every account
-- change is one action name with one details blob.
create or replace function public.staff_update (
  p_user_id      uuid,
  p_is_active    boolean default null,
  p_role         public.staff_role default null,
  p_full_name    text default null,
  p_new_password text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me   public.staff_session%rowtype;
  v_user public.staff_users%rowtype;
begin
  select * into v_me from public.staff_session();
  if v_me.role is distinct from 'master' then
    return jsonb_build_object('ok', false, 'error', 'Only a master administrator can manage staff.');
  end if;

  select * into v_user from public.staff_users where id = p_user_id;
  if v_user.id is null then
    return jsonb_build_object('ok', false, 'error', 'No such staff account.');
  end if;

  if p_new_password is not null and length(p_new_password) < 10 then
    return jsonb_build_object('ok', false, 'error', 'Password must be at least 10 characters.');
  end if;

  -- Guard against locking the last master out. With no active master, nobody
  -- could ever add or re-enable one again — a self-inflicted permanent lockout.
  if v_user.role = 'master'
     and ((p_is_active is not null and p_is_active is false)
       or (p_role is not null and p_role <> 'master')) then
    if (select count(*) from public.staff_users where role = 'master' and is_active) <= 1 then
      return jsonb_build_object('ok', false,
        'error', 'This is the only active master. Promote another master first.');
    end if;
  end if;

  update public.staff_users
     set is_active     = coalesce(p_is_active, is_active),
         role          = coalesce(p_role, role),
         full_name     = coalesce(nullif(trim(p_full_name), ''), full_name),
         password_hash = case when p_new_password is not null
                              then extensions.crypt(p_new_password, extensions.gen_salt('bf', 10))
                              else password_hash end,
         -- a credential change also clears any lockout
         failed_attempts = case when p_new_password is not null then 0 else failed_attempts end,
         locked_until    = case when p_new_password is not null then null else locked_until end
   where id = p_user_id;

  insert into public.staff_audit_log (staff_id, username, role, action, entity, entity_id, details)
  values (v_me.id, v_me.username, v_me.role, 'update_staff', 'staff_user', p_user_id::text,
          jsonb_build_object(
            'target_username', v_user.username,
            'is_active_set',   p_is_active is not null,
            'role_set',        p_role is not null,
            'password_reset',  p_new_password is not null
          ));

  return jsonb_build_object('ok', true);
end;
$$;

revoke execute on function public.staff_update (uuid, boolean, public.staff_role, text, text) from public;
grant execute on function public.staff_update (uuid, boolean, public.staff_role, text, text)
  to anon, authenticated;

-- Revoke every live session for a staff member (e.g. after a suspected
-- compromise). Takes effect on the next request because staff_session() re-checks
-- the session row every time.
create or replace function public.staff_revoke_sessions (p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me    public.staff_session%rowtype;
  v_count int;
begin
  select * into v_me from public.staff_session();
  if v_me.role is distinct from 'master' then
    return jsonb_build_object('ok', false, 'error', 'Only a master administrator can revoke sessions.');
  end if;

  update public.staff_sessions
     set revoked_at = now()
   where staff_id = p_user_id and revoked_at is null;
  get diagnostics v_count = row_count;

  insert into public.staff_audit_log (staff_id, username, role, action, entity, entity_id, details)
  values (v_me.id, v_me.username, v_me.role, 'revoke_sessions', 'staff_user', p_user_id::text,
          jsonb_build_object('sessions_revoked', v_count));

  return jsonb_build_object('ok', true, 'revoked', v_count);
end;
$$;

revoke execute on function public.staff_revoke_sessions (uuid) from public;
grant execute on function public.staff_revoke_sessions (uuid) to anon, authenticated;


-- 10) retire the Phase 2 Supabase-Auth admin path --------------------------------
-- The old admin_* policies keyed off is_admin() (a Supabase Auth account). They
-- are dropped so there is exactly ONE way to reach the roster as staff, and that
-- way is a staff_users session. Leaving both would mean a Google account that
-- was once added to admin_users could still read the roster.
drop policy if exists admin_select_registrations on public.registrations;
drop policy if exists admin_update_registrations on public.registrations;
drop policy if exists admin_delete_registrations on public.registrations;
drop policy if exists admin_users_read_own on public.admin_users;

-- 11) RLS on the staff tables --------------------------------------------------
alter table public.staff_users enable row level security;
alter table public.staff_sessions enable row level security;
alter table public.staff_audit_log enable row level security;
alter table public.pricing enable row level security;

-- staff_users: a master may read the roster of accounts; nobody else may, and
-- no role may ever write directly (that is what staff_create / staff_update are
-- for — so every change is audited).
--
-- The GRANT/REVOKE order matters. Supabase grants ALL on public tables to anon
-- and authenticated by default; a policy alone is not enough, because RLS is
-- only consulted for tables the role may touch. So: revoke everything, then
-- grant back exactly the privileges a policy actually guards. Getting this
-- backwards (revoke after granting) silently produces "permission denied"
-- with an empty result rather than an obvious failure.
drop policy if exists staff_users_read on public.staff_users;
create policy staff_users_read
  on public.staff_users
  for select
  to anon, authenticated
  using (public.staff_at_least('master'));

revoke all on public.staff_users from anon, authenticated;
grant select on public.staff_users to anon, authenticated;

-- staff_sessions: no direct access at all. Sessions are created and revoked
-- only by staff_login / staff_logout, which are the audited path. No grant.
drop policy if exists staff_sessions_read on public.staff_sessions;
revoke all on public.staff_sessions from anon, authenticated;

-- audit log: readable by master (oversight) and admin (they verify their own
-- work). A coordinator is read-only on registrations but not on the audit trail.
drop policy if exists staff_audit_read on public.staff_audit_log;
create policy staff_audit_read
  on public.staff_audit_log
  for select
  to anon, authenticated
  using (public.staff_at_least('admin'));

revoke all on public.staff_audit_log from anon, authenticated;
-- Re-grant only SELECT: the log is append-only and written by SECURITY DEFINER
-- functions, so no client role can insert, update or delete an entry.
grant select on public.staff_audit_log to anon, authenticated;

-- pricing: public read (prices are already on the public site). Writes are
-- master-only, and every write is audited by the trigger below.
drop policy if exists pricing_public_read on public.pricing;
create policy pricing_public_read
  on public.pricing
  for select
  to anon, authenticated
  using (is_active);

drop policy if exists pricing_master_write on public.pricing;
create policy pricing_master_write
  on public.pricing
  for all
  to anon, authenticated
  using (public.staff_at_least('master'))
  with check (public.staff_at_least('master'));

-- 12) staff RLS on registrations -----------------------------------------------
-- coordinator: read only. admin: read + update (accept/reject). master: all.
drop policy if exists staff_read_registrations on public.registrations;
create policy staff_read_registrations
  on public.registrations
  for select
  to anon, authenticated
  using (public.staff_at_least('coordinator'));

drop policy if exists staff_update_registrations on public.registrations;
create policy staff_update_registrations
  on public.registrations
  for update
  to anon, authenticated
  using (public.staff_at_least('admin'))
  with check (public.staff_at_least('admin'));

-- Deleting a registration destroys the only record that a real payment was made,
-- so it is reserved for a master.
drop policy if exists staff_delete_registrations on public.registrations;
create policy staff_delete_registrations
  on public.registrations
  for delete
  to anon, authenticated
  using (public.staff_at_least('master'));

-- Registrations: the two audiences connect as DIFFERENT roles, which is what
-- makes the split clean.
--
--   authenticated — a Google-signed-in participant. RLS narrows them to their
--                   own row (participant_*_own_* policies).
--   anon         — a staff member. They have no Supabase session at all; the
--                   X-Nexus-Staff-Token header is the entire identity. They need
--                   table-level SELECT/UPDATE/DELETE for the staff_* policies to
--                   be reachable, because RLS narrows, it does not grant.
--
-- So anon gets no INSERT: a staff member must never create a registration, and
-- only a signed-in participant may, under the policy that pins user_id to
-- auth.uid(). anon does get SELECT because without it staff_at_least() would
-- never even be evaluated.
revoke all on public.registrations from anon;
grant select, update, delete on public.registrations to anon;


-- 13) automatic audit trail ---------------------------------------------------
-- The guard trigger from ...0003 keyed off is_admin(), which no longer exists.
-- It is replaced here by the same guard plus the new staff hierarchy.
create or replace function public.guard_registration_update ()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Staff: at least an admin may verify. RLS already enforced this, but the
  -- check is repeated so the guard is correct on its own.
  if public.staff_at_least('admin') then
    -- Record the change, with before/after so the log answers "what did this
    -- admin actually change?" without anyone having to remember to ask.
    if new.payment_status is distinct from old.payment_status
       or new.utr_number is distinct from old.utr_number
       or new.payment_verified_by is distinct from old.payment_verified_by
       or new.name is distinct from old.name then
      perform public.staff_audit(
        'update_registration',
        'registration',
        new.id::text,
        jsonb_build_object(
          'from_status', old.payment_status,
          'to_status',   new.payment_status,
          'from_utr',    old.utr_number,
          'to_utr',      new.utr_number,
          'verified_by', new.payment_verified_by
        )
      );
    end if;
    return new;
  end if;

  -- Otherwise this is a participant editing their own row. They may adopt an
  -- unowned row whose email matches their verified account, and otherwise only
  -- correct details while the payment is not yet verified.
  if old.user_id is null
     and new.user_id is not null
     and new.user_id = auth.uid()
     and lower(btrim(new.email)) = lower(coalesce(auth.jwt() ->> 'email', '')) then
    return new;
  end if;

  if new.id <> old.id
     or new.user_id is distinct from old.user_id
     or new.created_at is distinct from old.created_at
     or new.payment_verified_at is distinct from old.payment_verified_at
     or new.payment_verified_by is distinct from old.payment_verified_by then
    raise exception 'registration: only the NEXUS operations team can change identity or payment-verification fields'
      using errcode = '42501';
  end if;

  if new.payment_status = 'verified' or old.payment_status = 'verified' then
    raise exception 'registration: payment verification is an operations-team action'
      using errcode = '42501';
  end if;

  if new.payment_status not in ('awaiting_utr', 'unverified', 'rejected') then
    raise exception 'registration: unsupported payment status'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

-- Audit DELETE as well. A trigger cannot call staff_audit() from an AFTER
-- trigger and still see the row, so the id is captured in BEFORE.
create or replace function public.audit_registration_delete ()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform public.staff_audit(
    'delete_registration',
    'registration',
    old.id::text,
    jsonb_build_object(
      'name', old.name, 'email', old.email,
      'status', old.payment_status, 'utr', old.utr_number
    )
  );
  return old;
end;
$$;

drop trigger if exists trg_registrations_guard_update on public.registrations;
create trigger trg_registrations_guard_update
  before update on public.registrations
  for each row
  execute function public.guard_registration_update();

drop trigger if exists trg_registrations_audit_delete on public.registrations;
create trigger trg_registrations_audit_delete
  before delete on public.registrations
  for each row
  execute function public.audit_registration_delete();

-- Pricing edits are audited the same way: a trigger, so no client can change a
-- price without an entry appearing.
create or replace function public.audit_pricing_change ()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform public.staff_audit(
    case when tg_op = 'INSERT' then 'create_price'
         when tg_op = 'UPDATE' then 'update_price'
         else 'delete_price' end,
    'pricing',
    coalesce(new.id, old.id)::text,
    jsonb_build_object(
      'kind',       coalesce(new.kind, old.kind),
      'ref_id',     coalesce(new.ref_id, old.ref_id),
      'from_price', case when tg_op <> 'INSERT' then old.price end,
      'to_price',   case when tg_op <> 'DELETE' then new.price end
    )
  );
  return coalesce(new, old);
end;
$$;

drop trigger if exists trg_pricing_audit on public.pricing;
create trigger trg_pricing_audit
  after insert or update or delete on public.pricing
  for each row
  execute function public.audit_pricing_change();

-- 14) bootstrap the first master ----------------------------------------------
-- staff_create() requires an existing master, which is a chicken-and-egg
-- problem. This is the ONLY anonymous path into staff_users, it works only while
-- the table is empty, and it writes an audit row saying exactly that.
create or replace function public.staff_bootstrap_master (
  p_username text,
  p_password text,
  p_full_name text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
begin
  if exists (select 1 from public.staff_users) then
    return jsonb_build_object('ok', false,
      'error', 'Staff already exist. Ask an existing master to add more.');
  end if;

  if coalesce(trim(p_username), '') !~ '^[a-z0-9._-]{3,32}$' then
    return jsonb_build_object('ok', false,
      'error', 'Username must be 3–32 characters: a–z, 0–9, dot, dash, underscore.');
  end if;

  if length(coalesce(p_password, '')) < 12 then
    return jsonb_build_object('ok', false,
      'error', 'The first master password must be at least 12 characters.');
  end if;

  insert into public.staff_users (username, password_hash, full_name, role, created_by)
  values (trim(p_username), extensions.crypt(p_password, extensions.gen_salt('bf', 10)),
          nullif(trim(p_full_name), ''), 'master', 'bootstrap')
  returning id into v_user_id;

  insert into public.staff_audit_log (username, role, action, entity, entity_id, details)
  values (trim(p_username), 'master', 'bootstrap_master', 'staff_user', v_user_id::text,
          jsonb_build_object('note', 'first master created; bootstrap path is now closed'));

  return jsonb_build_object('ok', true, 'id', v_user_id, 'role', 'master');
end;
$$;

revoke execute on function public.staff_bootstrap_master (text, text, text) from public;
grant execute on function public.staff_bootstrap_master (text, text, text) to anon, authenticated;

-- 15) housekeeping ------------------------------------------------------------
-- Expired/revoked sessions accumulate. Deleting them is safe at any time: a
-- row that is already unusable becomes definitively unusable.
create or replace function public.staff_purge_sessions ()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count int;
begin
  if not public.staff_at_least('master') then
    return jsonb_build_object('ok', false, 'error', 'Only a master administrator can purge sessions.');
  end if;

  delete from public.staff_sessions
   where expires_at < now() - interval '7 days'
      or (revoked_at is not null and revoked_at < now() - interval '7 days');
  get diagnostics v_count = row_count;

  return jsonb_build_object('ok', true, 'removed', v_count);
end;
$$;

revoke execute on function public.staff_purge_sessions () from public;
grant execute on function public.staff_purge_sessions () to anon, authenticated;

-- is_admin() is now unused (Phase 2's Supabase-Auth gate is retired). It is
-- dropped rather than left behind, so a future reader cannot mistake a dead
-- function for a live access path.
drop function if exists public.is_admin ();


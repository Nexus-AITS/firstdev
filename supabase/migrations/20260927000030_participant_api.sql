-- =============================================================================
-- NEXUS - a partner-facing read API, authenticated by key
-- Migration : 20260927000030_participant_api.sql
-- Purpose   : Let an authorised external system - the hackathon site, a results
--             dashboard, a certificate generator - read who registered, in JSON,
--             with a credential the database can revoke.
--
-- WHY AN API KEY AND NOT THE STAFF TOKEN
--
-- Because a staff token is a PERSON and expires in 60 minutes; a machine
-- calling every few minutes would be signing in as a human forever, and the
-- audit log would fill with one operator's logins. The staff system is built
-- for a desk; this is for a server.
--
-- WHY A HASH AND NOT THE KEY ITSELF
--
-- The staff system already does this for sessions (staff_token_hash), and the
-- reason applies more sharply here: a database leak should not hand the attacker
-- working credentials. The key is shown ONCE, at creation, and never again. A
-- master who loses it mints a new one; nobody can read the old one back, because
-- it is not stored.
--
-- WHY SCOPES, AND WHY THE DEFAULT IS THE NARROW ONE
--
-- This endpoint hands out names, roll numbers, colleges, EMAIL ADDRESSES and
-- PHONE NUMBERS. A key that can read all of that is a key that can leak it. So
-- the default scope is `read:verified` - confirmed participants only - and
-- `read:all` (which also includes rows still awaiting payment) is a separate
-- grant a master has to hand over deliberately.
--
-- WHY IT IS A PostgREST RPC RATHER THAN A SERVERLESS FUNCTION
--
-- Because the whole point of this project is that the DATABASE decides. A
-- function that assembled the JSON in JavaScript would be a second definition
-- of "who registered", and the operations console and a partner site would drift
-- apart exactly the way every other screen on this site used to. The function
-- below is the only place the shape is written down. A thin api/registrations.js
-- is provided purely so a consumer needs no Supabase SDK, and it calls THIS.
--
-- SECURITY DEFINER on the read, because the caller connects as `anon` and RLS
-- would otherwise show it nothing. The gate is inside the body, on the key - the
-- same shape as staff_session() and for the same reason.
--
-- Idempotent: create-table-if-not-exists, create-or-replace.
-- =============================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- 1. the keys
-- ---------------------------------------------------------------------------

create table if not exists public.api_keys (
  id           uuid        primary key default gen_random_uuid(),
  name         text        not null,
  -- The first few characters, kept so an operator can tell two keys apart in
  -- the console without the secret ever being stored or recoverable.
  key_prefix   text        not null,
  key_hash     text        not null unique,
  -- read:verified (the default) | read:all. A key with an empty array reads
  -- NOTHING, which is the safe direction for a key created with a mistake.
  scopes       text[]      not null default array['read:verified']::text[],
  is_active    boolean     not null default true,
  created_at   timestamptz not null default now(),
  created_by   text,
  last_used_at timestamptz,
  revoked_at   timestamptz,
  note         text
);

comment on table public.api_keys is
  'Machine credentials for the participant read API. Only a SHA-256 HASH of each key is stored, so a database dump contains no working credential; key_prefix exists so the console can identify a key without being able to reveal it. Scopes are read:verified (confirmed participants only - the default) and read:all (also rows still awaiting payment, which is a materially larger set of personal data).';

-- The hashing is a FUNCTION, not an inline digest() call, so there is exactly
-- one definition of "what a correct key looks like" and the mint and the verify
-- cannot drift apart - the same reason staff_token_hash exists.
--
-- THE SCHEMA IS LOOKED UP, NOT ASSUMED
--
-- pgcrypto's functions are in `extensions` on this project, not `public`, and
-- `create extension if not exists pgcrypto` is a no-op on a project that already
-- has it, so a hardcoded `public.digest(...)` fails with "function does not
-- exist" on exactly the setup that already has the extension. Migration ...012
-- hits the same thing with pg_trgm's operator class and resolves it by looking
-- the object up; this does the same, and raises a loud error rather than
-- silently falling back to an un-indexed path if it is nowhere to be found.
do $$
declare
  v_schema text;
begin
  select n.nspname into v_schema
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where p.proname = 'digest'
   limit 1;

  if v_schema is null then
    raise exception 'pgcrypto is not installed: API keys could not be hashed';
  end if;

  execute format($f$
    create or replace function public.api_key_hash (p_key text)
    returns text
    language sql
    immutable
    set search_path = ''
    as $q$ select encode(%1$s.digest(btrim(coalesce(p_key, '')), 'sha256'), 'hex'); $q$;
  $f$, v_schema);

  -- The same problem, the same answer, for the one place that needs random
  -- bytes. Wrapping it means staff_api_key_mint - which is SECURITY DEFINER with
  -- an empty search_path - never has to name a schema it cannot know.
  execute format($f$
    create or replace function public.api_new_secret ()
    returns text
    language sql
    volatile
    set search_path = ''
    as $q$ select 'nxk_' || encode(%1$s.gen_random_bytes(24), 'hex'); $q$;
  $f$, v_schema);
end;
$$;

comment on function public.api_new_secret() is
  'A fresh 48-character API key, hex-encoded behind an nxk_ prefix so it is recognisable in a config file. A wrapper rather than a direct gen_random_bytes call because pgcrypto lives in a schema that varies by project, and every function here runs with an empty search_path.';


-- ---------------------------------------------------------------------------
-- 2. the session
-- ---------------------------------------------------------------------------
-- Mirrors staff_session() exactly: the credential travels in a header, PostgREST
-- exposes headers as a JSON GUC, and revocation / deactivation are all
-- re-checked HERE so nothing about the key survives in a client's belief.

create or replace function public.api_session ()
returns jsonb
language sql
stable
set search_path = ''
as $$
  -- Returns SQL NULL when there is no usable key, NOT the JSON literal null.
  --
  -- That distinction is the whole point of this function and it is easy to get
  -- wrong: wrapping the lookup in coalesce(..., 'null'::jsonb) produces a jsonb
  -- value that IS null but is NOT SQL NULL, so a caller's `if v_session is null`
  -- never fires. Every bad key then fell through to the "no read scope" branch
  -- and was told it had the wrong scope, when it had in fact never been
  -- recognised at all - and a REVOKED key reported the same thing as a
  -- malformed one. A subquery with no rows is SQL NULL, which is what "no key"
  -- has to mean.
  select (
    select jsonb_build_object(
             'id', k.id,
             'name', k.name,
             'scopes', to_jsonb(k.scopes))
      from public.api_keys k
     where k.key_hash = public.api_key_hash(
             coalesce(current_setting('request.headers', true)::jsonb
                        ->> 'x-nexus-api-key', ''))
       and k.is_active
       and k.revoked_at is null
     limit 1);
$$;

comment on function public.api_session() is
  'The caller''s API key, resolved from the X-Nexus-Api-Key header to a live key row. null when the header is absent, unknown, revoked or deactivated. The only gate api_registrations() consults.';

revoke execute on function public.api_session() from public;
grant  execute on function public.api_session() to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. minting, listing, revoking
-- ---------------------------------------------------------------------------
-- Master only, and the key is returned exactly once - in the response to the
-- call that created it. There is deliberately no "show me the key" function,
-- because there is nothing to show: the plaintext was never stored.

create or replace function public.staff_api_key_mint (
  p_name   text,
  p_scopes text[] default array['read:verified']::text[],
  p_note   text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name   text := nullif(btrim(coalesce(p_name, '')), '');
  v_scopes text[];
  v_secret text;
  v_id     uuid;
begin
  if not public.staff_at_least('master') then
    return jsonb_build_object('ok', false,
      'error', 'Only a master administrator can create an API key.');
  end if;

  if v_name is null or char_length(v_name) < 2 then
    return jsonb_build_object('ok', false, 'error', 'Give the key a name.');
  end if;

  -- Whitelisted, so a typo is refused at creation rather than producing a key
  -- that silently authenticates and then reads nothing.
  if p_scopes is null or cardinality(p_scopes) = 0 then
    return jsonb_build_object('ok', false,
      'error', 'Choose at least one scope: read:verified, or read:all.');
  end if;
  if exists (select 1 from unnest(p_scopes) s
              where s not in ('read:verified', 'read:all')) then
    return jsonb_build_object('ok', false,
      'error', 'Unknown scope. Use read:verified, read:all, or both.');
  end if;
  v_scopes := array(select distinct unnest(p_scopes));

  -- 24 random bytes, hex, with a recognisable prefix. Long enough that it is
  -- not guessable, prefixed so it is obvious in a config file what it is.
  --
  -- public.api_new_secret() is the schema-resolving wrapper created in the DO
  -- block above: gen_random_bytes lives in `extensions` here, and this function
  -- runs with `search_path = ''` for safety, so it cannot be reached by name
  -- without the schema being filled in at migration time.
  v_secret := public.api_new_secret();

  insert into public.api_keys (name, key_prefix, key_hash, scopes, created_by, note)
  values (v_name, left(v_secret, 12), public.api_key_hash(v_secret), v_scopes,
          (select s.username from public.staff_session() s),
          nullif(btrim(coalesce(p_note, '')), ''))
  returning id into v_id;

  perform public.staff_audit('create_api_key', 'api_key', v_id::text,
    jsonb_build_object('name', v_name, 'scopes', to_jsonb(v_scopes)));

  -- The ONLY time the plaintext leaves the database.
  return jsonb_build_object('ok', true, 'id', v_id, 'name', v_name,
                            'key', v_secret, 'scopes', to_jsonb(v_scopes),
                            'warning',
                            'Copy this key now. It is stored only as a hash and cannot be shown again.');
end;
$$;

comment on function public.api_key_hash(text) is
  'The SHA-256 hex digest of a key, trimmed first so a pasted key with a stray newline still verifies. One definition shared by minting and by verification.';

create or replace function public.staff_api_keys ()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.staff_at_least('master') then
    return jsonb_build_object('ok', false,
      'error', 'Only a master administrator can see API keys.');
  end if;
  return jsonb_build_object('ok', true, 'keys', coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', k.id, 'name', k.name, 'key_prefix', k.key_prefix,
             'scopes', to_jsonb(k.scopes), 'is_active', k.is_active,
             'created_at', k.created_at, 'created_by', k.created_by,
             'last_used_at', k.last_used_at, 'revoked_at', k.revoked_at,
             'note', k.note) order by k.created_at desc)
      from public.api_keys k), '[]'::jsonb));
end;
$$;

create or replace function public.staff_api_key_revoke (p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text;
begin
  if not public.staff_at_least('master') then
    return jsonb_build_object('ok', false,
      'error', 'Only a master administrator can revoke an API key.');
  end if;

  update public.api_keys
     set is_active = false, revoked_at = now()
   where id = p_id and revoked_at is null
  returning name into v_name;

  if v_name is null then
    return jsonb_build_object('ok', false, 'error', 'No such active key.');
  end if;

  perform public.staff_audit('revoke_api_key', 'api_key', p_id::text,
    jsonb_build_object('name', v_name));
  return jsonb_build_object('ok', true, 'id', p_id);
end;
$$;

comment on function public.staff_api_key_mint(text, text[], text) is
  'Master only. Creates a partner API key and returns the plaintext ONCE - only a SHA-256 hash is stored, so there is no function that can show it again. Scopes are whitelisted at creation.';
comment on function public.staff_api_keys() is
  'Master only. Every key with its prefix, scopes, and last use. Never returns a secret, because none is recoverable.';
comment on function public.staff_api_key_revoke(uuid) is
  'Master only. Deactivates a key immediately - api_session() checks is_active and revoked_at on every request, so revocation takes effect on the next call, not at the next deploy.';

grant execute on function public.staff_api_key_mint(text, text[], text) to anon, authenticated;
grant execute on function public.staff_api_keys() to anon, authenticated;
grant execute on function public.staff_api_key_revoke(uuid) to anon, authenticated;


-- ---------------------------------------------------------------------------
-- 4. the read
-- ---------------------------------------------------------------------------
-- The one definition of "who registered", shared by the partner API and by the
-- console's push (migration ...031). Both call THIS, so what an operator sends
-- by hand and what a key holder can fetch are the same object by construction
-- rather than by two functions agreeing.
--
-- THE SCOPE IS HONOURED HERE, NOT BY THE CALLER
--
-- A verified-only key asking for everything gets everything it asked for and
-- nothing it did not: the filter is applied in this function using the KEY's
-- scopes, so a client cannot pass p_only_verified to widen what its key is
-- allowed to see. The parameter only ever narrows, and only when the key
-- already holds read:all.

create or replace function public.api_registrations (
  p_event_id       text   default null,
  p_only_verified  boolean default null,
  p_limit          integer default 500,
  p_offset         integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_session  jsonb := public.api_session();
  v_scopes   text[];
  v_verified boolean;
  v_rows     jsonb;
  v_count    integer;
  v_total    integer;
  v_limit    integer;
  v_offset   integer;
begin
  if v_session is null then
    return jsonb_build_object('ok', false,
      'error', 'A valid NEXUS API key is required. Send it in the X-Nexus-Api-Key header.');
  end if;

  v_scopes := array(select jsonb_array_elements_text(v_session -> 'scopes'));

  -- A key with neither read scope reads nothing at all. Refusing loudly beats
  -- returning an empty array that reads as "nobody has registered".
  if not (v_scopes @> array['read:verified']) then
    return jsonb_build_object('ok', false,
      'error', 'This API key has no read scope.');
  end if;

  -- The DEFAULT is the narrow one: a key that cannot see unverified rows never
  -- sees them, whatever it asks for.
  v_verified := coalesce(p_only_verified, true);
  if not v_verified and not (v_scopes @> array['read:all']) then
    v_verified := true;
  end if;

  v_limit  := least(greatest(coalesce(p_limit, 500), 1), 5000);
  v_offset := greatest(coalesce(p_offset, 0), 0);

  with chosen as (
    select r.id, r.created_at
      from public.registrations r
     where (p_event_id is null or p_event_id = 'all'
            or exists (select 1 from public.registration_events re
                        where re.registration_id = r.id and re.event_id = p_event_id))
       and (r.payment_status = 'verified'
            or (not v_verified and r.payment_status in ('unverified', 'awaiting_utr', 'awaiting_cash')))
     order by r.created_at, r.id
     offset v_offset limit v_limit
  )
  select count(*)::integer,
         coalesce(jsonb_agg(public.registration_api_row(c.id) order by c.created_at), '[]'::jsonb)
    into v_total, v_rows
    from chosen c;

  return jsonb_build_object(
    'ok', true,
    'key', v_session ->> 'name',
    'scopes', to_jsonb(v_scopes),
    'verified_only', v_verified,
    'count', v_total,
    'offset', v_offset,
    'limit', v_limit,
    'registrations', v_rows);
end;
$$;

comment on function public.api_registrations(text, boolean, integer, integer) is
  'The participant read API, for a caller holding a valid X-Nexus-Api-Key. Returns name, roll number, college, department, year, email, phone, the events each person is registered for, their team, and what they paid. The key''s OWN scopes decide whether rows still awaiting payment are included - p_only_verified can only narrow, never widen - so a verified-only key cannot be talked into reading the whole roster.';


-- ---------------------------------------------------------------------------
-- 5. one row
-- ---------------------------------------------------------------------------
-- Split out so the shape of a person is written down ONCE. api_registrations
-- aggregates it, and ...031's push sends it, so adding a field is one edit here
-- rather than two that can disagree.
--
-- The events are TITLES, not catalogue ids. A partner site displaying them
-- cannot resolve "nexus-breach" without a copy of our catalogue, and the title
-- is what an operator would say out loud. The id travels alongside it, so a
-- consumer that does want to key on something stable has it.

create or replace function public.registration_api_row (p_registration_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'reference', r.id,
    'name', r.name,
    'roll_number', r.roll_number,
    'college', r.college_name,
    'department', r.department,
    'year', r.year,
    'email', r.email,
    'phone_number', r.phone_number,
    'events', coalesce((
      select jsonb_agg(jsonb_build_object('id', ec.id, 'title', ec.title)
                       order by ec.sort_order, ec.id)
        from public.registration_events re
        join public.event_catalogue ec on ec.id = re.event_id
       where re.registration_id = r.id), '[]'::jsonb),
    -- The team, for the events whose team is formed here. Null (not an empty
    -- object) when there is no team, so a consumer can tell "this person is
    -- not on a team" from "this person's team is empty".
    'team', case
              when public.registration_team_cap(r.id) is null then null
              else public.registration_team(r.id)
            end,
    'purchase', jsonb_build_object(
      'type', r.purchase_type,
      'label', r.purchase_label,
      'amount', r.purchase_amount,
      'method', r.payment_method,
      'status', r.payment_status),
    'registered_at', r.created_at)
    from public.registrations r
   where r.id = p_registration_id;
$$;

comment on function public.registration_api_row(uuid) is
  'One participant as one JSON object: identity, college details, the events they hold a seat for, their team, and what they paid and how. The single definition of the shape the partner API and the console push both send.';

revoke execute on function public.registration_api_row(uuid) from public;

-- api_registrations is what a partner calls. It is granted to anon because the
-- anon role is what a server-to-server caller uses when it holds only the
-- public anon key plus its own API key - and it is granted EXECUTE ONLY, with
-- no table grant behind it, so the anon role still cannot read public.
-- registrations or registration_members by any other route.
grant execute on function public.api_registrations(text, boolean, integer, integer) to anon, authenticated;
revoke execute on function public.api_registrations(text, boolean, integer, integer) from public;

-- ---------------------------------------------------------------------------
-- 6. what an operator can see about a key's use
-- ---------------------------------------------------------------------------
-- api_session() is STABLE and used once per call, so touching last_used_at here
-- would make the read volatile for no benefit. A small separate writer, called
-- by the transport, is the honest shape.

create or replace function public.staff_api_key_touch (p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.staff_at_least('master') then
    return;
  end if;
  update public.api_keys set last_used_at = now() where id = p_id;
end;
$$;

comment on function public.staff_api_key_touch(uuid) is
  'Master only. Records that a key was just used, so the console can show which credentials are live and which have gone quiet. Kept out of the read path so api_session() stays STABLE.';

grant execute on function public.staff_api_key_touch(uuid) to anon, authenticated;


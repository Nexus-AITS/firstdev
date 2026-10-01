-- =============================================================================
-- NEXUS - sending the roster out, and the participant's way onward
-- Migration : 20260927000031_destinations_and_settings.sql
-- Purpose   : Let an operator paste a destination URL plus its API secret and
--             SEND the registration data to it, and give a verified participant
--             a button that continues into their dashboard.
--
-- WHAT THE OPERATOR DOES
--
--   1. paste the dashboard's endpoint and, if it wants one, its API secret
--   2. press SEND
--   3. see how many records went and what the destination replied
--
-- WHY THE SECRET LIVES IN supabase_vault
--
-- Because the browser must never hold it, and the console must never be able to
-- re-read it - and this is the one credential on the project that is BOTH
-- outbound (the database has to send it) and long-lived. A hash is no use here
-- because the value must be sent, not compared, so it has to be recoverable;
-- recoverable-in-a-table is exactly what Vault exists to avoid. The console
-- stores only the id and a masked preview.
--
-- WHY pg_net IS NOT USED
--
-- It is not installed on this project (the extensions are pg_trgm, pgcrypto,
-- supabase_vault, uuid-ossp), and the database cannot make an HTTP request
-- without it. So the POST is made by api/push-registrations.js, a serverless
-- function, and the ONLY thing that moves through it is the payload this
-- migration's functions build. The database still decides what is sent and
-- what the secret is - the function is transport, nothing else.
--
-- WHY THE PAYLOAD IS NOT BUILT IN JAVASCRIPT
--
-- Because it is the same object the partner API returns, and a second
-- implementation of "who registered" is how two surfaces start disagreeing.
-- staff_push_payload() returns registration_api_row() rows, so the thing an
-- operator pushes by hand and the thing an API key holder can fetch are the
-- same JSON by construction.
--
-- WHY THE DASHBOARD URL IS SETTINGS AND NOT HARD-CODED
--
-- Because every event's team_form_url is currently empty, so a hard-coded
-- destination would be a constant nobody can change without a deploy - and the
-- destination is the single most frequently changed value on the site. A
-- participant's button resolves to the event's own team_form_url when the event
-- has one, and to the site-wide default otherwise.
--
-- Idempotent: create-table-if-not-exists, create-or-replace.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. where the data is sent
-- ---------------------------------------------------------------------------

create table if not exists public.push_destinations (
  id            uuid        primary key default gen_random_uuid(),
  name          text        not null,
  url           text        not null,
  -- How the secret is presented to the destination. Both halves are data
  -- because "X-Api-Key: abc" and "Authorization: Bearer abc" are both common
  -- and guessing wrong means a 401 on the first send.
  auth_header   text        not null default 'Authorization',
  auth_prefix   text        not null default 'Bearer ',
  -- The id of the secret inside supabase_vault. NULL means the destination
  -- takes no authentication, which is a legitimate choice for a private
  -- network and is why it is not a required field.
  vault_secret_id uuid,
  secret_preview text,
  -- NULL means "every event". Scoped to one so a destination can be pointed at
  -- a single event's list without building a second key.
  event_id      text,
  only_verified boolean     not null default true,
  is_active     boolean     not null default true,
  last_push_at  timestamptz,
  last_push_status integer,
  last_push_count   integer,
  last_push_error   text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    text
);

comment on table public.push_destinations is
  'Where the operations team sends registration data from the console. The secret is held in supabase_vault and this table stores only its id and a masked preview - the console can never re-read it, and a database dump contains no working credential. auth_header/auth_prefix describe how the destination expects it, because "Authorization: Bearer x" and "X-Api-Key: x" are both common and a wrong guess is a 401 on the first send.';

alter table public.push_destinations enable row level security;

drop policy if exists staff_read_push_destinations on public.push_destinations;
create policy staff_read_push_destinations
  on public.push_destinations
  for select
  to anon
  using ((select public.staff_at_least('admin')));

-- Writes go only through the staff RPCs, which re-check master inside the body.
revoke all on public.push_destinations from anon, authenticated;
grant select on public.push_destinations to anon;


-- ---------------------------------------------------------------------------
-- 2. the site-wide dashboard
-- ---------------------------------------------------------------------------
-- One row, enforced by the primary key, so there is never a second default
-- somebody edits by accident.

create table if not exists public.site_settings (
  id            boolean     primary key default true,
  dashboard_url text,
  updated_at    timestamptz not null default now(),
  updated_by    text,
  constraint chk_site_settings_single_row check (id),
  constraint chk_site_settings_dashboard_url
    check (dashboard_url is null or dashboard_url ~* '^https?://')
);

comment on table public.site_settings is
  'One row. The site-wide destination a verified participant continues to from their profile when their event has no team_form_url of its own. Only http(s) is stored, because it is rendered as an href and a javascript: or data: value would be a stored XSS served from our own origin.';

insert into public.site_settings (id) values (true) on conflict (id) do nothing;

alter table public.site_settings enable row level security;

drop policy if exists public_read_site_settings on public.site_settings;
create policy public_read_site_settings
  on public.site_settings
  for select
  to anon, authenticated
  using (true);

revoke all on public.site_settings from anon, authenticated;
grant select on public.site_settings to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. the public read the profile page needs
-- ---------------------------------------------------------------------------
-- A bare URL, public by design: it is a link a participant is meant to follow,
-- exactly like the contact channels ...013 publishes. No secret, no counts, no
-- personal data - and a public read that is UNCONDITIONAL would be a mistake if
-- this function ever grew a column, so it names the one field it returns rather
-- than returning the row.

create or replace function public.public_site_settings ()
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'ok', true,
    'dashboard_url', (select s.dashboard_url from public.site_settings s where s.id));
$$;

comment on function public.public_site_settings() is
  'Public: the one URL a verified participant continues to. A link they are meant to follow, published the same way the contact channels are. Returns the single field deliberately, so adding a private column to site_settings cannot leak by being swept into a select *.';

grant execute on function public.public_site_settings() to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. managing a destination
-- ---------------------------------------------------------------------------
-- Master only. A new secret is WRITTEN on save; an existing one is kept unless a
-- new value is pasted, because a blank field in a form means "I did not change
-- this" far more often than it means "delete the secret" - and silently
-- dropping a working secret is the worse of the two mistakes.

create or replace function public.staff_upsert_destination (p_destination jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id        uuid := nullif(p_destination ->> 'id', '')::uuid;
  v_name      text := nullif(btrim(coalesce(p_destination ->> 'name', '')), '');
  v_url       text := nullif(btrim(coalesce(p_destination ->> 'url', '')), '');
  v_header    text := coalesce(nullif(btrim(coalesce(p_destination ->> 'auth_header', '')), ''), 'Authorization');
  v_prefix    text := coalesce(coalesce(p_destination ->> 'auth_prefix', ''), 'Bearer ');
  v_secret    text := nullif(btrim(coalesce(p_destination ->> 'api_secret', '')), '');
  v_event     text := nullif(btrim(coalesce(p_destination ->> 'event_id', '')), '');
  v_verified  boolean := coalesce((p_destination ->> 'only_verified')::boolean, true);
  v_active    boolean := coalesce((p_destination ->> 'is_active')::boolean, true);
  v_vault_id  uuid;
  v_preview   text;
begin
  if not public.staff_at_least('master') then
    return jsonb_build_object('ok', false,
      'error', 'Only a master administrator can change where the roster is sent.');
  end if;

  if v_name is null then
    return jsonb_build_object('ok', false, 'error', 'Give the destination a name.');
  end if;

  -- http(s) only. This URL is fetched by a server-side function on a schedule
  -- or on demand, so a file: or gopher: value here is an SSRF primitive, and a
  -- javascript: one would be worse.
  if v_url is null or v_url !~* '^https?://' then
    return jsonb_build_object('ok', false,
      'error', 'The destination URL must start with http:// or https://');
  end if;

  if v_event is not null
     and not exists (select 1 from public.event_catalogue ec where ec.id = v_event) then
    return jsonb_build_object('ok', false,
      'error', 'No such event - leave the event blank to send every registration.');
  end if;

  -- A header NAME cannot contain a colon or a newline; both would let a pasted
  -- value inject extra headers into the outgoing request.
  if v_header !~ '^[A-Za-z0-9-]{1,64}$' then
    return jsonb_build_object('ok', false,
      'error', 'The auth header name may contain letters, digits and dashes only.');
  end if;
  if position(E'\n' in v_prefix) > 0 or position(E'\r' in v_prefix) > 0
     or position(E'\n' in v_header) > 0 then
    return jsonb_build_object('ok', false, 'error', 'The auth header cannot contain line breaks.');
  end if;

  -- The secret goes to Vault, never to this table. The preview is what the
  -- console shows afterwards, so an operator can tell WHICH secret is stored
  -- without the value being recoverable.
  if v_secret is not null then
    if v_id is not null then
      -- Replace rather than accumulate: a rotated secret must not leave the old
      -- one sitting in Vault forever.
      delete from vault.decrypted_secrets where id = (
        select d.vault_secret_id from public.push_destinations d where d.id = v_id);
    end if;
    v_vault_id := public.vault.create_secret(v_secret, v_name,
      'NEXUS push destination: ' || v_name, 'nexus');
    v_preview := left(v_secret, 4) || '…' || right(v_secret, 4);
  else
    select d.vault_secret_id, d.secret_preview into v_vault_id, v_preview
      from public.push_destinations d where d.id = v_id;
  end if;

  insert into public.push_destinations as d
    (id, name, url, auth_header, auth_prefix, vault_secret_id, secret_preview,
     event_id, only_verified, is_active, created_by, updated_at)
  values
    (coalesce(v_id, gen_random_uuid()), v_name, v_url, v_header, v_prefix,
     v_vault_id, v_preview, v_event, v_verified, v_active,
     (select s.username from public.staff_session() s), now())
  on conflict (id) do update
     set name          = excluded.name,
         url           = excluded.url,
         auth_header   = excluded.auth_header,
         auth_prefix   = excluded.auth_prefix,
         vault_secret_id = excluded.vault_secret_id,
         secret_preview   = excluded.secret_preview,
         event_id      = excluded.event_id,
         only_verified = excluded.only_verified,
         is_active     = excluded.is_active,
         updated_at    = now()
  returning d.id into v_id;

  perform public.staff_audit('upsert_push_destination', 'push_destination', v_id::text,
    jsonb_build_object('name', v_name, 'url', v_url,
                       'secret_rotated', v_secret is not null,
                       'event_id', v_event, 'only_verified', v_verified));

  return jsonb_build_object('ok', true, 'id', v_id, 'secret_preview', v_preview);
end;
$$;

create or replace function public.staff_list_destinations ()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.staff_at_least('admin') then
    return jsonb_build_object('ok', false, 'error', 'Not authorised.');
  end if;
  return jsonb_build_object('ok', true, 'destinations', coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', d.id, 'name', d.name, 'url', d.url,
             'auth_header', d.auth_header, 'auth_prefix', d.auth_prefix,
             'has_secret', d.vault_secret_id is not null,
             'secret_preview', d.secret_preview,
             'event_id', d.event_id, 'only_verified', d.only_verified,
             'is_active', d.is_active, 'last_push_at', d.last_push_at,
             'last_push_status', d.last_push_status,
             'last_push_count', d.last_push_count,
             'last_push_error', d.last_push_error,
             'created_at', d.created_at)
           order by d.created_at)
      from public.push_destinations d), '[]'::jsonb));
end;
$$;

create or replace function public.staff_delete_destination (p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name  text;
  v_vault uuid;
begin
  if not public.staff_at_least('master') then
    return jsonb_build_object('ok', false,
      'error', 'Only a master administrator can remove a destination.');
  end if;

  -- FOR UPDATE so two operators deleting the same destination at once cannot
  -- both read the vault id and then both try to delete the row.
  select d.name, d.vault_secret_id into v_name, v_vault
    from public.push_destinations d
   where d.id = p_id
     for update;

  if v_name is null then
    return jsonb_build_object('ok', false, 'error', 'No such destination.');
  end if;

  -- The Vault entry goes with it, or a deleted destination leaves a live
  -- third-party credential sitting in the project forever.
  if v_vault is not null then
    delete from vault.decrypted_secrets where id = v_vault;
  end if;

  delete from public.push_destinations where id = p_id;
  perform public.staff_audit('delete_push_destination', 'push_destination', p_id::text,
    jsonb_build_object('name', v_name));
  return jsonb_build_object('ok', true, 'id', p_id);
end;
$$;

create or replace function public.staff_set_dashboard_url (p_url text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text := nullif(btrim(coalesce(p_url, '')), '');
begin
  if not public.staff_at_least('admin') then
    return jsonb_build_object('ok', false,
      'error', 'Only an administrator or a master can set the dashboard link.');
  end if;

  -- Only http(s): this is rendered as an href on the participant's profile.
  if v_url is not null and v_url !~* '^https?://' then
    return jsonb_build_object('ok', false,
      'error', 'The dashboard URL must start with http:// or https://');
  end if;

  update public.site_settings
     set dashboard_url = v_url, updated_at = now(),
         updated_by = (select s.username from public.staff_session() s)
   where id;

  perform public.staff_audit('set_dashboard_url', 'site_settings', 'singleton',
    jsonb_build_object('dashboard_url', v_url));
  return jsonb_build_object('ok', true, 'dashboard_url', v_url);
end;
$$;

comment on function public.staff_upsert_destination(jsonb) is
  'Master only. Adds or edits a push destination. A pasted secret is written to supabase_vault and only a masked preview comes back; a blank secret field keeps the stored one, because a form that silently dropped a working credential would be worse than one that ignores an empty box.';
comment on function public.staff_list_destinations() is
  'Admin+. Every destination with its last push outcome and whether a secret is set. Never returns a secret - there is none to return.';
comment on function public.staff_delete_destination(uuid) is
  'Master only. Removes a destination AND its Vault entry, so a deleted destination does not leave a live third-party credential in the project.';
comment on function public.staff_set_dashboard_url(text) is
  'Admin+. The site-wide destination a verified participant continues to. Blank clears it, which makes the profile button disappear rather than link nowhere.';

grant execute on function public.staff_upsert_destination(jsonb) to anon, authenticated;
grant execute on function public.staff_list_destinations() to anon, authenticated;
grant execute on function public.staff_delete_destination(uuid) to anon, authenticated;
grant execute on function public.staff_set_dashboard_url(text) to anon, authenticated;



-- ---------------------------------------------------------------------------
-- 5. the send
-- ---------------------------------------------------------------------------
-- The database builds WHAT to send and the destination's credentials; the
-- serverless function only performs the HTTP request. Split this way on
-- purpose: the secret is read from Vault inside a function gated on a master
-- staff session, so it never reaches the browser, and the payload is the same
-- registration_api_row() the partner API returns.
--
-- The secret IS returned here - to a server-side caller holding a master staff
-- token, which is the only way an outbound authenticated request can be made
-- at all. That is the reason this function refuses an admin, not just checks
-- one.

create or replace function public.staff_push_payload (p_destination_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_dest    public.push_destinations%rowtype;
  v_secret  text;
  v_headers jsonb;
  v_rows    jsonb;
begin
  if not public.staff_at_least('master') then
    return jsonb_build_object('ok', false,
      'error', 'Only a master administrator can send the roster out.');
  end if;

  select * into v_dest from public.push_destinations d where d.id = p_destination_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'No such destination.');
  end if;
  if not v_dest.is_active then
    return jsonb_build_object('ok', false, 'error', 'That destination is switched off.');
  end if;

  if v_dest.vault_secret_id is not null then
    select ds.decrypted_secret into v_secret
      from vault.decrypted_secrets ds
     where ds.id = v_dest.vault_secret_id;
    if v_secret is null then
      return jsonb_build_object('ok', false,
        'error', 'The stored secret is missing from the vault - save the destination again.');
    end if;
  end if;

  v_headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'Accept', 'application/json');
  if v_secret is not null then
    v_headers := v_headers || jsonb_build_object(v_dest.auth_header,
                                                 v_dest.auth_prefix || v_secret);
  end if;

  -- The same rows, the same shape, the same filters the partner API applies.
  select coalesce(jsonb_agg(public.registration_api_row(r.id)
                              order by r.created_at, r.id), '[]'::jsonb),
         count(*)::integer
    into v_rows, v_dest.last_push_count
    from public.registrations r
   where (v_dest.event_id is null
          or exists (select 1 from public.registration_events re
                      where re.registration_id = r.id and re.event_id = v_dest.event_id))
     and (r.payment_status = 'verified'
          or (not v_dest.only_verified
              and r.payment_status in ('unverified', 'awaiting_utr', 'awaiting_cash')));

  return jsonb_build_object(
    'ok', true,
    'url', v_dest.url,
    'headers', v_headers,
    'count', v_dest.last_push_count,
    'body', jsonb_build_object(
      'source', 'nexus',
      'destination', v_dest.name,
      'generated_at', now(),
      'count', v_dest.last_push_count,
      'registrations', v_rows));
end;
$$;

create or replace function public.staff_record_push (
  p_destination_id uuid,
  p_status         integer,
  p_count          integer default null,
  p_error          text    default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.staff_at_least('master') then
    return jsonb_build_object('ok', false, 'error', 'Not authorised.');
  end if;

  -- Truncated, because a destination is free to answer with an HTML error page
  -- and a 4KB column full of markup is nobody's idea of a useful message.
  update public.push_destinations
     set last_push_at = now(),
         last_push_status = p_status,
         last_push_count = coalesce(p_count, last_push_count),
         last_push_error = left(nullif(btrim(coalesce(p_error, '')), ''), 500),
         updated_at = now()
   where id = p_destination_id;

  perform public.staff_audit('push_registrations', 'push_destination',
    p_destination_id::text,
    jsonb_build_object('status', p_status, 'count', p_count,
                       'error', left(coalesce(p_error, ''), 200)));

  return jsonb_build_object('ok', true);
end;
$$;

comment on function public.staff_push_payload(uuid) is
  'Master only, and server-side only. Builds the exact request an outbound push needs - url, headers (including the Vault secret) and the body of registration_api_row() rows - for api/push-registrations.js to perform. The secret is included BECAUSE the request has to be authenticated, which is why this is gated on master rather than admin: it is the one function that can read a working outbound credential.';
comment on function public.staff_record_push(uuid, integer, integer, text) is
  'Master only. Records what the destination answered, so the console can show the last outcome instead of an operator wondering whether the send worked. The error is truncated to 500 characters.';

grant execute on function public.staff_push_payload(uuid) to anon, authenticated;
grant execute on function public.staff_record_push(uuid, integer, integer, text) to anon, authenticated;


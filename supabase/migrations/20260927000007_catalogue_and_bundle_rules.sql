-- =============================================================================
-- NEXUS - events and bundles in the database, real bundle rules, catalogue CRUD
-- Migration : 20260927000007_catalogue_and_bundle_rules.sql
-- Purpose   : Phase 6. Finish the frontend work Phase 5 staged, and answer the
--             bundle question that Phase 5 deliberately left open.
--
-- WHY THIS EXISTS
--
-- Migration ...0006 gave the database a real registration -> event relation, a
-- persisted amount, and a filtered export. What it could NOT do was validate a
-- BUNDLE, because a bundle was a JavaScript object: `includes` and `pick` lived
-- in src/data/bundles.js and the database had never heard of them. So the
-- writer summed a bundle price plus the price of whatever events the browser
-- named, which means a client could claim bundle #01 (hackathon + 1 off-grid
-- event) and then submit a list of the most expensive events it liked and be
-- charged for exactly that list. The bundle was a label, not a rule.
--
-- This migration makes the catalogue real:
--
--   event_catalogue    one row per event, the shape events.js already had
--   bundle_catalogue   one row per bundle
--   bundle_includes    the include lines: a fixed seat, or a pick-pool
--
-- and then enforces the two rules the Bundled page has always promised in copy
-- but never in code:
--
--   1. A bundle is a CONTRACT, not a suggestion. The participant must select
--      every fixed seat and exactly the required number of events from each
--      pool, all distinct, and the bundle price is the TOTAL. It is not added
--      to the events. That is what "per bundle" on the card has always meant.
--   2. No two bundles may be the same. A unique index over a content signature
--      makes a duplicate bundle impossible rather than merely discouraged, so
--      the console cannot create bundle #09 as a copy of #04 and quietly pay
--      out twice for one offer.
--
-- The JS files stay exactly where they are, as the offline fallback and the
-- generator for the seed. A page that cannot reach the database still renders
-- the same eleven events, because the arrays were never the thing that changed
-- most often; the numbers were, and those were already in public.pricing.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. the catalogue
-- ---------------------------------------------------------------------------

create table if not exists public.event_catalogue (
  id          text        primary key,
  number      text        not null,
  title       text        not null,
  category    text,
  mode        text,                              -- esports only
  realm       text        not null,             -- forge | paradox | arena
  tagline     text        not null default '',
  about       text[]      not null default '{}',
  event_date  text        not null default '',
  venue       text        not null default '',
  team_size   text        not null default '',
  -- 'individual' or a digit string. Text rather than integer because the site
  -- genuinely has a non-numeric value here and has always rendered both.
  max_size    text        not null default '',
  status      text        not null default '',
  accent      text,
  sigil       text,
  link_key    text,
  sort_order  integer     not null default 0,
  is_active   boolean     not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  updated_by  text,
  constraint chk_event_catalogue_realm
    check (realm in ('forge', 'paradox', 'arena'))
);

comment on table public.event_catalogue is
  'The event catalogue. Read publicly when active; written only by a master through staff_upsert_event(). The copy in src/data/events.js is the offline fallback and the source of the seed, never the authority once the database answers.';

create table if not exists public.bundle_catalogue (
  id          text        primary key,
  number      text        not null,
  name        text        not null,
  group_id    text        not null,
  kicker      text,
  title_lines text[]      not null default '{}',
  sort_order  integer     not null default 0,
  is_active   boolean     not null default true,
  -- The signature of the include lines, maintained by trigger. Read the
  -- comment on bundle_content_key() for what "the same bundle" means.
  content_key text        not null default '',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  updated_by  text,
  constraint chk_bundle_catalogue_not_empty check (length(trim(name)) > 0)
);

comment on table public.bundle_catalogue is
  'Payment bundles. content_key is maintained from bundle_includes and is unique among ACTIVE bundles, so two live bundles can never contain the same thing.';

-- The include lines. A row is EITHER a fixed seat (event_id) OR a pick-pool
-- (pick_realm + pick_count), never both and never neither. The CHECK is what
-- makes that structural: a half-filled include line is a rule the validator
-- cannot evaluate, so the database refuses to store one.
create table if not exists public.bundle_includes (
  bundle_id          text    not null references public.bundle_catalogue (id) on delete cascade,
  position           integer not null,
  event_id           text    references public.event_catalogue (id) on delete restrict,
  pick_realm         text,
  pick_count         integer,
  exclude_hackathon  boolean not null default false,
  constraint pk_bundle_includes primary key (bundle_id, position),
  constraint chk_bundle_includes_shape check (
    (event_id is not null and pick_realm is null and pick_count is null)
    or
    (event_id is null and pick_realm is not null and pick_count is not null and pick_count > 0)
  ),
  constraint chk_bundle_includes_realm
    check (pick_realm is null or pick_realm in ('forge', 'paradox', 'arena'))
);

comment on table public.bundle_includes is
  'One include line per bundle, in the order the card prints it. A fixed seat names an event; a pool names a realm and how many of its events the buyer chooses.';

create index if not exists idx_bundle_includes_bundle
  on public.bundle_includes (bundle_id, position);
create index if not exists idx_event_catalogue_realm
  on public.event_catalogue (realm, sort_order)
  where is_active;
-- ---------------------------------------------------------------------------
-- 2. "no two bundles may be the same"
-- ---------------------------------------------------------------------------
--
-- The Bundled page shows two bundles with the same name and the same price
-- (#04 and #06 are both "NEXUS REBUILDERS BUNDLED" at Rs 399) and the only
-- thing that distinguishes them is the CONTENT. So "the same bundle" has to
-- mean the same content, not the same label, and the check has to survive an
-- operator renaming a bundle, or renaming becomes a way around it.
--
-- The signature is built from the include lines, SORTED, so two bundles that
-- list the same seats in a different order are the same bundle. Each line
-- contributes a token:
--
--   fixed seat   E:<event_id>
--   pool         P:<realm>:<count>:<excluded>
--
-- Sorting is not cosmetic: bundle #05 lists forge-then-paradox and a rebuilt
-- #06 would naturally be written paradox-then-forge. Without the ORDER BY those
-- two would have different keys and the duplicate would slip through.

create or replace function public.bundle_content_key (p_bundle_id text)
returns text
language sql
stable
set search_path = ''
as $$
  select coalesce(string_agg(t.token, '|' order by t.token), '')
    from (
      select 'E:' || bi.event_id as token
        from public.bundle_includes bi
       where bi.bundle_id = p_bundle_id and bi.event_id is not null
      union all
      select 'P:' || bi.pick_realm || ':' || bi.pick_count::text || ':'
             || case when bi.exclude_hackathon then 'x' else '-' end
        from public.bundle_includes bi
       where bi.bundle_id = p_bundle_id and bi.pick_realm is not null
    ) t;
$$;

comment on function public.bundle_content_key is
  'Order-independent signature of a bundle''s include lines. Two bundles with the same key offer exactly the same thing.';

-- Recompute the parent's key whenever its include lines change.
--
-- Statement-level, not row-level: a bundle is edited by DELETEs and INSERTs of
-- every line at once, and a row trigger would fire once per line to recompute
-- the same value. transition tables give the whole set in one pass.
-- Recompute a bundle's key whenever its include lines change.
--
-- ROW-level, deliberately, and not with transition tables. Postgres refuses
-- transition tables on a multi-event trigger outright (0A000), and the
-- statement-level alternative needs one trigger per event plus a TG_OP switch to
-- pick which relation exists. A bundle has a handful of include lines, so
-- recomputing a short aggregate per changed row is not a cost worth that
-- complexity -- and this form cannot be wrong about which relation it can see.
create or replace function public.bundle_touch_content_key ()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id text := coalesce(new.bundle_id, old.bundle_id);
begin
  update public.bundle_catalogue b
     set content_key = public.bundle_content_key(v_id),
         updated_at  = now()
   where b.id = v_id;
  return null;
end;
$$;

drop trigger if exists trg_bundle_content_key on public.bundle_includes;
create trigger trg_bundle_content_key
  after insert or update or delete on public.bundle_includes
  for each row
  execute function public.bundle_touch_content_key();

-- The uniqueness itself. PARTIAL on is_active because retiring a bundle must
-- not be blocked by a live one it happens to match, and because two retired
-- duplicates left over from an earlier season are not an error worth failing a
-- deploy over.
create unique index if not exists uq_bundle_catalogue_content
  on public.bundle_catalogue (content_key)
  where is_active and content_key <> '';

comment on index public.uq_bundle_catalogue_content is
  'At most one ACTIVE bundle per content signature. This is what makes "no two bundles are the same" a database guarantee rather than a review convention.';

-- A bundle with NO include lines is not a bundle. It would be a free-for-all
-- that the selection writer cannot price, since the price covers "everything on
-- the card" and the card would be blank. The index above skips the empty key (an
-- empty bundle would otherwise collide with every other empty one), so this
-- CHECK is what actually refuses one. Added NOT VALID first and validated
-- separately, because a project that already has an empty active bundle should
-- report that rather than fail the whole migration.
alter table public.bundle_catalogue
  drop constraint if exists chk_bundle_catalogue_has_includes;
alter table public.bundle_catalogue
  add constraint chk_bundle_catalogue_has_includes
  check (not is_active or content_key <> '') not valid;
alter table public.bundle_catalogue
  validate constraint chk_bundle_catalogue_has_includes;
-- ---------------------------------------------------------------------------
-- 3. RLS: the public reads, a master writes
-- ---------------------------------------------------------------------------
--
-- Identical shape to public.pricing, deliberately: events and bundles are shown
-- on the public site with no session, so the read policy is public-and-active.
-- What they must NOT be is writable by the public, which is why the write policy
-- is master-only and the table grants are revoked first.

alter table public.event_catalogue  enable row level security;
alter table public.bundle_catalogue enable row level security;
alter table public.bundle_includes enable row level security;

drop policy if exists event_public_read on public.event_catalogue;
create policy event_public_read
  on public.event_catalogue
  for select
  to anon, authenticated
  using (is_active);

drop policy if exists bundle_public_read on public.bundle_catalogue;
create policy bundle_public_read
  on public.bundle_catalogue
  for select
  to anon, authenticated
  using (is_active);

-- Include lines are public only when they belong to a live bundle. An orphaned
-- line under a retired bundle is internal bookkeeping, not something the site
-- should be able to read by guessing ids.
drop policy if exists bundle_include_public_read on public.bundle_includes;
create policy bundle_include_public_read
  on public.bundle_includes
  for select
  to anon, authenticated
  using (exists (
    select 1 from public.bundle_catalogue b
     where b.id = bundle_id and b.is_active
  ));

drop policy if exists event_master_write on public.event_catalogue;
create policy event_master_write
  on public.event_catalogue
  for all
  to anon, authenticated
  using (public.staff_at_least('master'))
  with check (public.staff_at_least('master'));

drop policy if exists bundle_master_write on public.bundle_catalogue;
create policy bundle_master_write
  on public.bundle_catalogue
  for all
  to anon, authenticated
  using (public.staff_at_least('master'))
  with check (public.staff_at_least('master'));

drop policy if exists bundle_include_master_write on public.bundle_includes;
create policy bundle_include_master_write
  on public.bundle_includes
  for all
  to anon, authenticated
  using (public.staff_at_least('master'))
  with check (public.staff_at_least('master'));

-- staff_at_least is hoisted into a scalar subquery for the same measured reason
-- as migration ...0005: a per-row session lookup over a growing catalogue is
-- the exact cost that made the roster feel slow.
drop policy if exists event_staff_read on public.event_catalogue;
create policy event_staff_read
  on public.event_catalogue
  for select
  to anon
  using ((select public.staff_at_least('coordinator')));

drop policy if exists bundle_staff_read on public.bundle_catalogue;
create policy bundle_staff_read
  on public.bundle_catalogue
  for select
  to anon
  using ((select public.staff_at_least('coordinator')));

drop policy if exists bundle_include_staff_read on public.bundle_includes;
create policy bundle_include_staff_read
  on public.bundle_includes
  for select
  to anon
  using ((select public.staff_at_least('coordinator')));

-- RLS narrows, it does not grant.
revoke all on public.event_catalogue from anon, authenticated;
grant select on public.event_catalogue to anon, authenticated;
grant insert, update, delete on public.event_catalogue to anon;

revoke all on public.bundle_catalogue from anon, authenticated;
grant select on public.bundle_catalogue to anon, authenticated;
grant insert, update, delete on public.bundle_catalogue to anon;

revoke all on public.bundle_includes from anon, authenticated;
grant select on public.bundle_includes to anon, authenticated;
grant insert, update, delete on public.bundle_includes to anon;
-- ---------------------------------------------------------------------------
-- 4. is this selection a legal way to buy that bundle?
-- ---------------------------------------------------------------------------
--
-- This is the function the whole migration exists for. It answers one question
-- about a (bundle, chosen events) pair, and it is a FUNCTION rather than an
-- inline check because several callers need the identical answer: the selection
-- writer, the console's "what may this bundle allow" hint, and the test suite.
-- A rule stated once and called from three places cannot drift; the same rule
-- copy-pasted three times eventually will.
--
-- The rules, in the order a person would state them:
--
--   * every FIXED seat of the bundle must be in the selection
--   * every pool must be satisfied EXACTLY - count events, from that realm
--   * a pool that excludes the hackathon may not be filled with it
--   * nothing outside the bundle may be in the selection
--   * the same event may not be chosen twice
--
-- A pool being OVER-filled is an error rather than "the extras are ignored",
-- because a participant who selects four off-grid events against a pool that
-- says three has been told something untrue about what they bought, and the
-- amount the database stores would not match the card.

create or replace function public.bundle_selection_errors (
  p_bundle_id   text,
  p_event_ids   text[]
)
returns text[]
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_errors  text[] := '{}';
  v_fixed   text[];
  v_pools   record;
  v_chosen  text[];
  v_pool    text[];
  v_extra   text[];
  v_hack    text;
begin
  if p_bundle_id is null then
    return v_errors;
  end if;

  -- De-duplicate first. A repeated id is not two seats, and letting it through
  -- would let one event satisfy two slots of a pool.
  select coalesce(array_agg(distinct x order by x), '{}')
    into v_chosen
    from unnest(coalesce(p_event_ids, '{}')) x;

  if coalesce(array_length(v_chosen, 1), 0)
     <> coalesce(array_length(coalesce(p_event_ids, '{}'), 1), 0) then
    -- array_append, NOT `||`. The `||` operator on a text[] and a text is not an
    -- append: Postgres reads it as array concatenation and tries to parse the
    -- message as an array literal, so every error path in this function would
    -- raise 22P02 "malformed array literal" instead of returning a reason.
    v_errors := array_append(v_errors, 'The same event cannot be chosen twice.');
  end if;

  -- "The hackathon" is a category, not an id, so it is resolved from the
  -- catalogue rather than hardcoded. Renaming nexus-breach must not silently
  -- stop excluding it.
  select ec.id into v_hack
    from public.event_catalogue ec
   where ec.realm = 'forge' and upper(coalesce(ec.category, '')) = 'HACKATHON'
   limit 1;

  select coalesce(array_agg(bi.event_id), '{}')
    into v_fixed
    from public.bundle_includes bi
   where bi.bundle_id = p_bundle_id and bi.event_id is not null;

  -- A fixed seat the buyer did not take.
  if exists (
    select 1 from unnest(v_fixed) f
     where not (f = any (v_chosen))
  ) then
    v_errors := array_append(v_errors,
      'This bundle includes an event that is not in your selection.');
  end if;

  for v_pools in
    select bi.pick_realm, bi.pick_count, bi.exclude_hackathon
      from public.bundle_includes bi
     where bi.bundle_id = p_bundle_id and bi.pick_realm is not null
  loop
    -- The candidate pool is the realm's ACTIVE events, minus the hackathon when
    -- the include excludes it. This is also exactly what the page renders as the
    -- "any N" list, so the rule and the copy come from one definition.
    select coalesce(array_agg(ec.id), '{}')
      into v_pool
      from public.event_catalogue ec
     where ec.realm = v_pools.pick_realm
       and ec.is_active
       and (not v_pools.exclude_hackathon or ec.id is distinct from v_hack);

    -- Counted against the CHOICE, not the pool: an event that exists but was not
    -- selected fills nothing, which is the whole point of a pick.
    if (
      select count(*) from unnest(v_chosen) c
       where c = any (v_pool)
    ) <> v_pools.pick_count then
      v_errors := array_append(v_errors,
        format('Choose exactly %s %s event(s) from this bundle.',
               v_pools.pick_count, v_pools.pick_realm));
    end if;
  end loop;

  -- Anything chosen that the bundle does not account for. A fixed seat or a
  -- pool member is accounted for; everything else was never on the card.
  select coalesce(array_agg(x), '{}')
    into v_extra
    from unnest(v_chosen) x
   where not (
     x = any (v_fixed)
     or exists (
       select 1
         from public.bundle_includes bi
         join public.event_catalogue ec on ec.realm = bi.pick_realm
        where bi.bundle_id = p_bundle_id
          and bi.pick_realm is not null
          and x = ec.id
     )
   );

  if coalesce(array_length(v_extra, 1), 0) > 0 then
    v_errors := array_append(v_errors,
      format('This bundle does not include: %s.', array_to_string(v_extra, ', ')));
  end if;

  return v_errors;
end;
$$;

comment on function public.bundle_selection_errors is
  'Reasons the (bundle, chosen events) pair is not a legal purchase. Empty array = legal. Used by the selection writer, the console and the test suite so the rule exists once.';

revoke execute on function public.bundle_selection_errors(text, text[]) from public;
grant execute on function public.bundle_selection_errors(text, text[]) to anon, authenticated;
-- ---------------------------------------------------------------------------
-- 5. the selection writer, with the bundle rule actually applied
-- ---------------------------------------------------------------------------
--
-- This replaces the Phase 5 version, and the difference is the point of the
-- whole migration. The old body computed:
--
--     amount = bundle price + sum(prices of whatever events were submitted)
--
-- so a bundle was an ADDENDUM to a list of events the client chose freely. With
-- the catalogue in the database that is no longer expressible as an offer: the
-- bundle price COVERS the events, exactly as the card says ("Rs 349 per bundle"
-- over three inclusion lines). So:
--
--   bundle given   amount = the bundle price, full stop, and the selection is
--                  validated against the bundle's include lines
--   no bundle      amount = sum of the chosen event prices (a plain a-la-carte
--                  purchase of one or more events)
--
-- The browser still submits ids only. It never names an amount, and the
-- signature is unchanged, so a client that tries to pass one is still rejected
-- by PostgREST for not matching the function.

create or replace function public.registration_set_events (
  p_registration_id uuid,
  p_bundle_id       text default null,
  p_event_ids       text[] default '{}'
)
returns table (registration_id uuid, amount integer, currency text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_status  public.payment_status;
  v_reg_id  uuid;
  v_bundle  integer;
  v_events  integer;
  v_known   text[];
  v_amount  integer;
  v_errors  text[];
  v_titles  text;
begin
  -- The caller must be signed in, and this row must be theirs.
  v_user_id := auth.uid();
  if v_user_id is null then
    raise exception 'Sign in before choosing events.' using errcode = '42501';
  end if;

  select r.id, r.payment_status
    into v_reg_id, v_status
    from public.registrations r
   where r.id = p_registration_id
     and r.user_id = v_user_id;

  if not found then
    raise exception 'That registration is not yours.' using errcode = '42501';
  end if;

  -- A verified payment is settled. Re-opening the selection would let someone
  -- change what they are recorded as having paid for after the fact.
  if v_status = 'verified' then
    raise exception 'This payment is already confirmed, so the selection is closed.'
      using errcode = '42501';
  end if;

  -- Reject event ids that are not live catalogue entries, so a typo cannot be
  -- stored and later show up as a phantom line on the roster.
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
       and p.is_active and b.is_active;

    if v_bundle is null then
      raise exception 'That bundle is not available.' using errcode = '22023';
    end if;

    -- The rule, applied. A bundle is a contract, so an illegal selection is
    -- refused outright rather than quietly priced at the bundle rate.
    v_errors := public.bundle_selection_errors(p_bundle_id, v_known);
    if coalesce(array_length(v_errors, 1), 0) > 0 then
      raise exception '%', array_to_string(v_errors, ' ')
        using errcode = '22023';
    end if;

    -- The bundle price IS the total. The events are what it buys.
    v_amount := v_bundle;
  else
    if coalesce(array_length(v_known, 1), 0) = 0 then
      raise exception 'Choose at least one event.' using errcode = '22023';
    end if;

    select coalesce(sum(p.price), 0) into v_events
      from public.pricing p
     where p.kind = 'event'
       and p.is_active
       and p.ref_id = any (v_known);

    v_amount := coalesce(v_events, 0);
  end if;

  -- Human-readable label built from the CATALOGUE titles, not from ids, and not
  -- from anything the browser sent. The roster and the export both read this,
  -- and an operator reconciling a UTR should see "NEXUS BREACH" rather than
  -- "nexus-breach".
  select coalesce(string_agg(ec.title, ', ' order by ec.sort_order, ec.id), '')
    into v_titles
    from public.event_catalogue ec
   where ec.id = any (v_known);

  -- Replace the whole selection in one shot. The delete is scoped to this
  -- registration, and the policies independently re-check ownership.
  delete from public.registration_events re
   where re.registration_id = v_reg_id;

  insert into public.registration_events (registration_id, event_id)
  select v_reg_id, unnest(v_known)
  where cardinality(v_known) > 0;

  update public.registrations r
     set purchase_type   = case when p_bundle_id is not null then 'bundle' else 'event' end,
         purchase_label  = case
                             when p_bundle_id is not null
                               then p_bundle_id || (case when cardinality(v_known) > 0
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
  'Replace a registration''s event selection. With a bundle, the selection is validated against the bundle''s include lines and the bundle price is the TOTAL; without one, the chosen events are summed from public.pricing. The browser supplies ids only; the amount is never accepted from the client.';

grant execute on function public.registration_set_events(uuid, text, text[]) to authenticated;
revoke execute on function public.registration_set_events(uuid, text, text[]) from anon;
-- ---------------------------------------------------------------------------
-- 6. catalogue CRUD for the console
-- ---------------------------------------------------------------------------
--
-- All master-only, all audited, all through SECURITY DEFINER so the RLS
-- policies above are not the only thing standing between a request and a
-- catalogue edit. The function re-checks the role itself and returns an
-- `{ ok: false, error }` shape rather than raising, because these are called
-- from a form where a readable message is worth more than a 500.

create or replace function public.staff_upsert_event (p_event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id    text := p_event ->> 'id';
  v_realm text := p_event ->> 'realm';
  v_title text := coalesce(nullif(trim(p_event ->> 'title'), ''), null);
  v_new   boolean;
begin
  if not public.staff_at_least('master') then
    return jsonb_build_object('ok', false,
      'error', 'Only a master administrator can change the event catalogue.');
  end if;

  if v_id is null or v_id !~ '^[a-z0-9][a-z0-9-]{1,48}$' then
    return jsonb_build_object('ok', false,
      'error', 'Event id must be 2-49 characters: a-z, 0-9 and dashes.');
  end if;

  if v_title is null then
    return jsonb_build_object('ok', false, 'error', 'An event needs a title.');
  end if;

  if v_realm is null or v_realm not in ('forge', 'paradox', 'arena') then
    return jsonb_build_object('ok', false,
      'error', 'Choose a realm: technical, non-technical or esports.');
  end if;

  select not exists (select 1 from public.event_catalogue ec where ec.id = v_id)
    into v_new;

  insert into public.event_catalogue as ec
    (id, number, title, category, mode, realm, tagline, about, event_date, venue,
     team_size, max_size, status, accent, sigil, link_key, sort_order, is_active,
     updated_by)
  values
    (v_id,
     coalesce(nullif(trim(p_event ->> 'number'), ''), 'NEW'),
     v_title,
     nullif(trim(coalesce(p_event ->> 'category', '')), ''),
     nullif(trim(coalesce(p_event ->> 'mode', '')), ''),
     v_realm,
     coalesce(p_event ->> 'tagline', ''),
     coalesce(array(select jsonb_array_elements_text(coalesce(p_event -> 'about', '[]'::jsonb))), '{}'),
     coalesce(p_event ->> 'event_date', ''),
     coalesce(p_event ->> 'venue', ''),
     coalesce(p_event ->> 'team_size', ''),
     coalesce(p_event ->> 'max_size', ''),
     coalesce(nullif(trim(p_event ->> 'status'), ''), 'REGISTRATION OPEN'),
     nullif(trim(coalesce(p_event ->> 'accent', '')), ''),
     nullif(trim(coalesce(p_event ->> 'sigil', '')), ''),
     nullif(trim(coalesce(p_event ->> 'link_key', '')), ''),
     coalesce(nullif(trim(p_event ->> 'sort_order'), '')::int, 0),
     coalesce((p_event ->> 'is_active')::boolean, true),
     (select s.username from public.staff_session() s))
  on conflict (id) do update
     set number     = excluded.number,
         title      = excluded.title,
         category   = excluded.category,
         mode       = excluded.mode,
         realm      = excluded.realm,
         tagline    = excluded.tagline,
         about      = excluded.about,
         event_date = excluded.event_date,
         venue      = excluded.venue,
         team_size  = excluded.team_size,
         max_size   = excluded.max_size,
         status     = excluded.status,
         accent     = excluded.accent,
         sigil      = excluded.sigil,
         link_key   = excluded.link_key,
         sort_order = excluded.sort_order,
         is_active  = excluded.is_active,
         updated_at = now(),
         updated_by = excluded.updated_by;

  perform public.staff_audit(
    case when v_new then 'create_event' else 'update_event' end,
    'event', v_id,
    jsonb_build_object('title', v_title, 'realm', v_realm));

  return jsonb_build_object('ok', true, 'id', v_id);
end;
$$;

revoke execute on function public.staff_upsert_event(jsonb) from public;
grant  execute on function public.staff_upsert_event(jsonb) to anon, authenticated;
-- A bundle is written in ONE call, includes and all. Writing the parent and its
-- lines separately would leave a window where a bundle is live with no includes
-- (which the CHECK refuses), so the console would have to order three requests
-- correctly or fail, and any failure would be a half-built bundle.

create or replace function public.staff_upsert_bundle (p_bundle jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id      text := p_bundle ->> 'id';
  v_group   text := coalesce(nullif(trim(p_bundle ->> 'group_id'), ''), 'nexus-forge');
  v_name    text := coalesce(nullif(trim(p_bundle ->> 'name'), ''), null);
  v_lines   jsonb := coalesce(p_bundle -> 'includes', '[]'::jsonb);
  v_line    jsonb;
  v_event   text;
  v_realm   text;
  v_count   int;
  v_excl    boolean;
  v_key     text;
  v_clash   text;
  v_pos     int := 0;
  v_new     boolean;
begin
  if not public.staff_at_least('master') then
    return jsonb_build_object('ok', false,
      'error', 'Only a master administrator can change the bundle catalogue.');
  end if;

  if v_id is null or v_id !~ '^[a-z0-9][a-z0-9-]{1,48}$' then
    return jsonb_build_object('ok', false,
      'error', 'Bundle id must be 2-49 characters: a-z, 0-9 and dashes.');
  end if;

  if v_name is null then
    return jsonb_build_object('ok', false, 'error', 'A bundle needs a name.');
  end if;

  if jsonb_array_length(v_lines) = 0 then
    return jsonb_build_object('ok', false,
      'error', 'A bundle must include at least one event or pick-pool.');
  end if;

  -- Validate every line BEFORE writing anything, so a rejected bundle leaves no
  -- trace. A half-written bundle is the failure mode a form cannot recover from.
  for v_line in select * from jsonb_array_elements(v_lines)
  loop
    v_event := nullif(trim(coalesce(v_line ->> 'event', '')), '');
    v_realm := nullif(trim(coalesce(v_line ->> 'pick', '')), '');
    v_count := nullif(v_line ->> 'count', '')::int;
    v_excl  := coalesce((v_line ->> 'excludeHackathon')::boolean, false);

    if v_event is not null then
      if not exists (
        select 1 from public.event_catalogue ec
         where ec.id = v_event and ec.is_active
      ) then
        return jsonb_build_object('ok', false,
          'error', format('No active event called "%s".', v_event));
      end if;
    elsif v_realm is not null
          and v_realm in ('forge', 'paradox', 'arena')
          and v_count is not null and v_count > 0 then
      null; -- a well-formed pool
    else
      return jsonb_build_object('ok', false,
        'error', 'Each line must be either an event, or a realm with a count above zero.');
    end if;

    v_pos := v_pos + 1;
  end loop;

  select not exists (select 1 from public.bundle_catalogue bc where bc.id = v_id)
    into v_new;

  -- The parent first, HELD RETIRED with an empty key.
  --
  -- is_active is forced to false here on purpose. Both the CHECK ("an active
  -- bundle must have includes") and the partial unique index would reject an
  -- active bundle whose content_key is still '', which is the state this row is
  -- in for the few statements between here and the last include line landing.
  -- Writing it retired and re-activating once the key is real means there is no
  -- instant at which a live, incomplete or duplicate bundle is visible, and the
  -- trigger refills the key as the lines land.
  insert into public.bundle_catalogue as bc
    (id, number, name, group_id, kicker, title_lines, sort_order, is_active,
     content_key, updated_by)
  values
    (v_id,
     coalesce(nullif(trim(p_bundle ->> 'number'), ''), 'NEW'),
     v_name,
     v_group,
     nullif(trim(coalesce(p_bundle ->> 'kicker', '')), ''),
     coalesce(array(select jsonb_array_elements_text(coalesce(p_bundle -> 'title_lines', '[]'::jsonb))), '{}'),
     coalesce(nullif(trim(p_bundle ->> 'sort_order'), '')::int, 0),
     false,
     '',
     (select s.username from public.staff_session() s))
  on conflict (id) do update
     set number      = excluded.number,
         name        = excluded.name,
         group_id    = excluded.group_id,
         kicker      = excluded.kicker,
         title_lines = excluded.title_lines,
         sort_order  = excluded.sort_order,
         is_active   = false,
         content_key = '',
         updated_at  = now(),
         updated_by  = excluded.updated_by;

  delete from public.bundle_includes bi where bi.bundle_id = v_id;

  v_pos := 0;
  for v_line in select * from jsonb_array_elements(v_lines)
  loop
    v_event := nullif(trim(coalesce(v_line ->> 'event', '')), '');
    v_realm := nullif(trim(coalesce(v_line ->> 'pick', '')), '');
    v_count := nullif(v_line ->> 'count', '')::int;
    v_excl  := coalesce((v_line ->> 'excludeHackathon')::boolean, false);
    v_pos   := v_pos + 1;

    insert into public.bundle_includes
      (bundle_id, position, event_id, pick_realm, pick_count, exclude_hackathon)
    values
      (v_id, v_pos,
       case when v_event is not null then v_event end,
       case when v_realm is not null and v_realm in ('forge', 'paradox', 'arena')
            then v_realm end,
       case when v_event is null and v_realm is not null and v_realm in ('forge', 'paradox', 'arena')
            then v_count end,
       case when v_event is null then v_excl else false end);
  end loop;

  v_key := public.bundle_content_key(v_id);

  -- The duplicate check, stated as a message rather than a raw unique-violation,
  -- because "that bundle already exists" is the one error an operator in this
  -- console genuinely needs to read. Checked BEFORE re-activating, so a rejected
  -- save leaves the bundle retired rather than live and unpayable.
  select bc.id into v_clash
    from public.bundle_catalogue bc
   where bc.content_key = v_key
     and bc.id <> v_id
     and bc.is_active
     and bc.content_key <> ''
   limit 1;

  if v_clash is not null then
    -- Left retired: the caller is told why, and the bundle stays off the public
    -- site rather than appearing as a live duplicate of another offer.
    return jsonb_build_object('ok', false,
      'error', format('Bundle "%s" already offers exactly this. Two live bundles cannot be the same.', v_clash));
  end if;

  -- The key is real and unique, so the bundle can go live. Written last, and
  -- only now, which is what makes the whole upsert all-or-nothing from the
  -- public site's point of view.
  update public.bundle_catalogue bc
     set is_active   = coalesce((p_bundle ->> 'is_active')::boolean, true),
         content_key = v_key,
         updated_at  = now()
   where bc.id = v_id;

  perform public.staff_audit(
    case when v_new then 'create_bundle' else 'update_bundle' end,
    'bundle', v_id,
    jsonb_build_object('name', v_name, 'group', v_group, 'lines', jsonb_array_length(v_lines)));

  return jsonb_build_object('ok', true, 'id', v_id, 'content_key', v_key);
end;
$$;

revoke execute on function public.staff_upsert_bundle(jsonb) from public;
grant  execute on function public.staff_upsert_bundle(jsonb) to anon, authenticated;
-- ---------------------------------------------------------------------------
-- 7. retiring, not deleting
-- ---------------------------------------------------------------------------
--
-- Neither catalogue row is ever DELETEd. A bundle is named by the purchase_label
-- of registrations sold against it, and an event by registration_events rows, so
-- deleting would leave the console showing a raw id with nothing to resolve it
-- against. Retiring removes the row from the public site, keeps history
-- readable, and is reversible.

create or replace function public.staff_retire_bundle (p_bundle_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.staff_at_least('master') then
    return jsonb_build_object('ok', false,
      'error', 'Only a master administrator can change the bundle catalogue.');
  end if;

  update public.bundle_catalogue bc
     set is_active = false, updated_at = now(), updated_by = (select s.username from public.staff_session() s)
   where bc.id = p_bundle_id;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'No such bundle.');
  end if;

  perform public.staff_audit('retire_bundle', 'bundle', p_bundle_id, null);
  return jsonb_build_object('ok', true, 'id', p_bundle_id);
end;
$$;

create or replace function public.staff_retire_event (p_event_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_used_by text;
begin
  if not public.staff_at_least('master') then
    return jsonb_build_object('ok', false,
      'error', 'Only a master administrator can change the event catalogue.');
  end if;

  -- An event inside a live bundle cannot be retired: the bundle would offer a
  -- seat that does not exist, and its pool counts would be unmeetable.
  select bi.bundle_id into v_used_by
    from public.bundle_includes bi
    join public.bundle_catalogue bc on bc.id = bi.bundle_id
   where bi.event_id = p_event_id and bc.is_active
   limit 1;

  if v_used_by is not null then
    return jsonb_build_object('ok', false,
      'error', format('This event is a fixed seat of bundle "%s". Retire that bundle first.', v_used_by));
  end if;

  update public.event_catalogue ec
     set is_active = false, updated_at = now(), updated_by = (select s.username from public.staff_session() s)
   where ec.id = p_event_id;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'No such event.');
  end if;

  perform public.staff_audit('retire_event', 'event', p_event_id, null);
  return jsonb_build_object('ok', true, 'id', p_event_id);
end;
$$;

revoke execute on function public.staff_retire_bundle(text) from public;
grant  execute on function public.staff_retire_bundle(text) to anon, authenticated;
revoke execute on function public.staff_retire_event(text) from public;
grant  execute on function public.staff_retire_event(text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 8. the public catalogue read
-- ---------------------------------------------------------------------------
--
-- One call, so a page cannot render a bundle whose include lines failed to load.
-- Three separate PostgREST reads would each be a round trip AND a chance to be
-- served a half-answer, and a bundle card with an empty inclusion list is worse
-- than one that failed honestly.

create or replace function public.public_catalogue ()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'events', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', ec.id, 'number', ec.number, 'title', ec.title,
               'category', ec.category, 'mode', ec.mode, 'realm', ec.realm,
               'tagline', ec.tagline, 'about', ec.about,
               'event_date', ec.event_date, 'venue', ec.venue,
               'team_size', ec.team_size, 'max_size', ec.max_size,
               'status', ec.status, 'accent', ec.accent, 'sigil', ec.sigil,
               'link_key', ec.link_key, 'sort_order', ec.sort_order
             ) order by ec.sort_order, ec.id)
        from public.event_catalogue ec where ec.is_active
    ), '[]'::jsonb),
    'bundles', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', bc.id, 'number', bc.number, 'name', bc.name,
               'group_id', bc.group_id, 'kicker', bc.kicker,
               'title_lines', bc.title_lines, 'sort_order', bc.sort_order,
               'includes', coalesce((
                 select jsonb_agg(jsonb_build_object(
                          'event', bi.event_id,
                          'pick', bi.pick_realm,
                          'count', bi.pick_count,
                          'excludeHackathon', bi.exclude_hackathon
                        ) order by bi.position)
                   from public.bundle_includes bi where bi.bundle_id = bc.id
               ), '[]'::jsonb)
             ) order by bc.sort_order, bc.id)
        from public.bundle_catalogue bc where bc.is_active
    ), '[]'::jsonb)
  );
$$;

comment on function public.public_catalogue is
  'Active events with their include lines, in one response, so a bundle card can never render against a half-loaded catalogue. Public by design: it returns nothing that is not already on the public site.';

revoke execute on function public.public_catalogue() from public;
grant execute on function public.public_catalogue() to anon, authenticated;
-- ---------------------------------------------------------------------------
-- 9. the seed
-- ---------------------------------------------------------------------------
-- The block between the SEED markers is GENERATED from src/data/{events,bundles}.js
-- by scripts/gen-catalogue-seed.mjs, which exists so the eleven events and eight
-- bundles are never retyped by hand. It is inlined rather than `\i`-included
-- because migrations here are executed through the Supabase Management API,
-- which is a plain SQL endpoint with no psql meta-commands.
--
-- Regenerate with: node scripts/gen-catalogue-seed.mjs --sql-file
--
-- == SEED BEGIN (generated - do not edit by hand) ==
-- GENERATED by scripts/gen-catalogue-seed.mjs from src/data/{events,bundles}.js.
-- Do not hand-edit: regenerate with `node scripts/gen-catalogue-seed.mjs --sql-file`,
-- so the database and the site cannot drift apart. Re-running is safe.

-- ---------------------------------------------------------------------------
-- events
-- ---------------------------------------------------------------------------
insert into public.event_catalogue
  (id, number, title, category, mode, realm, tagline, about, event_date, venue,
   team_size, max_size, status, accent, sigil, link_key, sort_order)
values
    ('nexus-breach', '01', $n$NEXUS BREACH$n$, 'HACKATHON', null, 'forge', $n$Break the boundaries.
Build beyond them.$n$,
     array[$n$Organised to encourage participants to develop efficient resource-management solutions addressing real-world problems — teams take on a live challenge and ship a working prototype before the final evaluation.$n$, $n$Sessions: Oct 5, 11:00 AM – 12:30 PM (first session) and 1:30 PM – 4:00 PM (second session); Oct 6, 9:30 AM – 11:00 AM (final session & evaluation, followed by the valedictory). Participants must bring their own laptops and chargers, and an RJ45 connector if required.$n$]::text[],
     $n$OCT 5 — 6, 2026$n$, $n$E-BLOCK · LABS A–E · SEMINAR HALL$n$, $n$2 — 5 MEMBERS$n$,
     '5', $n$REGISTRATION OPEN$n$, 'violet', 'fracture', 'nexusBreach', 0),
    ('vision-2065', '02', $n$VISION 2065$n$, 'IDEATHON', null, 'forge', $n$Imagine the future.
Engineer the impossible.$n$,
     array[$n$Participants develop presentations on efficient resource management addressing real-world problems — pitch the vision of 2065 to a live jury.$n$, $n$Oct 5, 1:30 PM – 4:00 PM. Advance registration required; participants must bring their own laptops and chargers. Auditorium facilities with high-speed Wi-Fi, power supply and projector/presentation setup.$n$]::text[],
     $n$OCT 5, 2026$n$, $n$CLASS ROOMS$n$, $n$1 — 5 MEMBERS$n$,
     '5', $n$REGISTRATION OPEN$n$, 'gold', 'temporal', 'vision2065', 1),
    ('circuits-of-nexus', '03', $n$CIRCUITS OF NEXUS$n$, 'CIRCUIT EXPO', null, 'forge', $n$Where ideas
become machines.$n$,
     array[$n$Participants develop systems on efficient resource management addressing real-world problems and exhibit them live — every stall powered on, running and open to interrogation.$n$, $n$Oct 7 — arrangements 11:00 AM – 12:30 PM, the Expo 1:30 PM – 4:00 PM. Advance registration required; bring your own materials and circuits. Dedicated display tables, power supply, electrical safety arrangements and exhibition space provided at the Main Block ground floor.$n$]::text[],
     $n$OCT 7, 2026$n$, $n$MAIN BLOCK — GROUND FLOOR$n$, $n$1 — 5 MEMBERS$n$,
     '5', $n$REGISTRATION OPEN$n$, 'violet', 'circuit', 'circuitsOfNexus', 2),
    ('ai-turing-gambit', '04', $n$AI TURING GAMBIT$n$, 'MANIPULATING THE AI', null, 'forge', $n$Don't ask what AI can do.
Ask what you can make it do.$n$,
     array[$n$Challenge the NEXUS AI itself: communicate strategically, explore its responses and extract resource-related information through problem-solving — a duel of instruction, patience and cunning with machine intelligence.$n$, $n$Oct 6, 10:00 AM – 12:30 PM at the Main Block. Advance registration required; participants must bring their own laptops and chargers.$n$]::text[],
     $n$OCT 6, 2026$n$, $n$MAIN BLOCK — 2 CLASSROOMS$n$, $n$1 — 5 MEMBERS$n$,
     '5', $n$REGISTRATION OPEN$n$, 'violet', 'neural', 'aiTuringGambit', 3),
    ('code-rebuilding', '05', $n$CODE REBUILDING$n$, 'CODE CRACK', null, 'forge', $n$The code is broken.
Can you reconstruct it?$n$,
     array[$n$Analyse and reconstruct corrupted code, identify logical errors and develop efficient solutions for managing resources within the NEXUS system.$n$, $n$Oct 6, 1:30 PM – 3:00 PM (event session) in Labs D & E. Bring laptops — speed and precision both count.$n$]::text[],
     $n$OCT 6, 2026$n$, $n$LABS D & E$n$, $n$1 — 5 MEMBERS$n$,
     '5', $n$REGISTRATION OPEN$n$, 'lavender', 'rebuild', 'codeRebuilding', 4),
    ('the-scientist-files', '01', $n$THE SCIENTIST FILES$n$, 'MURDER MYSTERY', null, 'paradox', $n$Every clue matters.
Every suspect has a secret.$n$,
     array[$n$A story-driven murder-mystery investigation built to sharpen critical thinking, analytical reasoning, observation, teamwork and problem-solving.$n$, $n$Oct 6, 10:00 AM – 12:30 PM across the college premises. Teams receive three fictional case files and must investigate all three, submitting a final report with evidence analysis, deductions, timeline and conclusion. Judging rewards evidence-based reasoning, scientific analysis, accuracy and clarity.$n$]::text[],
     $n$OCT 6, 2026$n$, $n$COLLEGE PREMISES$n$, $n$2 — 4 MEMBERS$n$,
     '4', $n$REGISTRATION OPEN$n$, 'gold', 'mystery', 'scientistFiles', 5),
    ('paradox-2065', '02', $n$PARADOX 2065$n$, 'FUTURE-BASED THINKING CHALLENGE', null, 'paradox', $n$What happens when
tomorrow becomes today?$n$,
     array[$n$Futuristic "What If?" scenarios set in 2065 around resource management, technology and society — respond with creative, logical and detailed answers that defend every conclusion.$n$, $n$Oct 6, 10:00 AM – 12:30 PM in the E-block classroom. Answers must be completed within the allotted time with clear reasoning; judging focuses on originality, logical thinking, depth, creativity and futuristic vision.$n$]::text[],
     $n$OCT 6, 2026$n$, $n$E-BLOCK CLASSROOM$n$, $n$SOLO$n$,
     'individual', $n$REGISTRATION OPEN$n$, 'violet', 'timeline', 'paradox2065', 6),
    ('shutter-quest', '03', $n$SHUTTER QUEST$n$, 'SPOT PHOTOGRAPHY', null, 'paradox', $n$One moment.
One frame. One story.$n$,
     array[$n$Capture the energy, creativity and unforgettable moments of NEXUS'65 while building visual-storytelling and observation skills — one frame at the event venue that interprets the theme 2065.$n$, $n$Oct 6, 11:00 AM – 3:30 PM. Bring your own smartphone or camera; photographs must be original and taken during the allotted window (no AI-generated or pre-shot entries), with consent before shooting identifiable people. Judging weighs composition, creativity, storytelling, technical quality and interpretation of the theme.$n$]::text[],
     $n$OCT 6, 2026$n$, $n$NEXUS OFF-GRID — CITY SECTORS$n$, $n$SOLO$n$,
     'individual', $n$REGISTRATION OPEN$n$, 'lavender', 'lens', 'shutterQuest', 7),
    ('matrix', '04', $n$MATRIX$n$, 'MEME MAKING', null, 'paradox', $n$Enter the matrix.
Break reality.$n$,
     array[$n$Express creativity, humour and awareness through original memes that explore the future of 2065, resource management and real-world challenges — relatable, engaging and on-theme.$n$, $n$Oct 6, 10:00 AM – 12:30 PM. Bring a laptop or smartphone; memes must be original, created within the allotted time and suitable for a college audience. Judging focuses on humour, creativity, originality and futuristic relevance.$n$]::text[],
     $n$OCT 6, 2026$n$, $n$NEXUS OFF-GRID — GLITCH DECK$n$, $n$SOLO$n$,
     'individual', $n$REGISTRATION OPEN$n$, 'violet', 'matrix', 'matrix', 8),
    ('pixel-resistance', '05', $n$PIXEL RESISTANCE$n$, 'POSTER DESIGN', null, 'paradox', $n$Create what cannot
be ignored.$n$,
     array[$n$Design original, visually impactful posters that promote awareness of resource management and inspire positive change — representing life, technology, society or challenges of the year 2065.$n$, $n$Oct 6, 10:00 AM – 12:30 PM in two Main Block classrooms. Bring laptops and chargers; posters must be created during the competition with no plagiarism or pre-made work. Judging rewards creativity, concept, visual appeal and relevance to 2065.$n$]::text[],
     $n$OCT 6, 2026$n$, $n$MAIN BLOCK — 2 CLASSROOMS$n$, $n$SOLO$n$,
     'individual', $n$REGISTRATION OPEN$n$, 'gold', 'pixel', 'pixelResistance', 9),
    ('free-fire', 'GAME 01', $n$FREE FIRE$n$, 'ESPORTS', 'SQUAD BATTLE ROYALE', 'arena', $n$Drop in.
Only one squad survives.$n$,
     array[$n$Esports promotes teamwork, strategic thinking, healthy competition, and a positive sense of community among engineering students.$n$, $n$Free Fire is the Arena's only title this season — squad up in fours, check in before the first drop and battle after college hours until one team owns the island.$n$]::text[],
     $n$OCT 5 — 6, 2026 · AFTER COLLEGE HOURS$n$, $n$THE ARENA — MAIN STAGE$n$, $n$SQUAD OF 4$n$,
     '4', $n$REGISTRATION OPEN$n$, 'violet', 'squad', 'freeFire', 10)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- bundles
-- ---------------------------------------------------------------------------
-- Bundles are inserted RETIRED and activated at the end, in one statement.
--
-- The order is forced by the schema: an ACTIVE bundle must have a non-empty
-- content_key (the CHECK from migration section 2), but content_key is computed
-- by the trigger that fires when the include lines land. So the parents go in
-- inactive, the lines go in, the trigger fills each key, and only then does the
-- final UPDATE publish them. Activating inline in the VALUES list is the obvious
-- thing to write and it fails the CHECK on the very first bundle.

-- Which bundles did THIS run actually insert? Captured in a temp table rather
-- than inferred, because the publish step below must not touch anything else.
--
-- The bug this replaces: the publish was
--     where bc.is_active = false and bc.content_key <> '' and exists (include)
-- which reads like a seed-scoped update but is not scoped to the seed AT ALL.
-- Re-running the migration after a master had deliberately retired a seeded
-- bundle would flip it back on: the row is inactive, has a content key and has
-- include lines, so it satisfies every clause — the retirement is silently
-- undone, and the bundle reappears on the public site. ON CONFLICT DO NOTHING
-- protects the INSERT; nothing protected the UPDATE.
create temporary table nexus_seed_publish (id text primary key) on commit drop;

with seeded as (
  insert into public.bundle_catalogue
    (id, number, name, group_id, kicker, title_lines, sort_order, is_active, content_key)
  values
    ('bundled-299', '01', $n$BUNDLED$n$, 'nexus-forge', $n$Payment bundles · 01 — 06$n$, array[$n$NEXUS$n$, $n$REBUILDERS BUNDLED$n$]::text[], 0, false, ''),
    ('bundled-349', '02', $n$BUNDLED$n$, 'nexus-forge', $n$Payment bundles · 01 — 06$n$, array[$n$NEXUS$n$, $n$REBUILDERS BUNDLED$n$]::text[], 1, false, ''),
    ('forge-bundled-349', '03', $n$NEXUS REBUILDERS BUNDLED$n$, 'nexus-forge', $n$Payment bundles · 01 — 06$n$, array[$n$NEXUS$n$, $n$REBUILDERS BUNDLED$n$]::text[], 2, false, ''),
    ('forge-bundled-399', '04', $n$NEXUS REBUILDERS BUNDLED$n$, 'nexus-forge', $n$Payment bundles · 01 — 06$n$, array[$n$NEXUS$n$, $n$REBUILDERS BUNDLED$n$]::text[], 3, false, ''),
    ('bundled-399', '05', $n$BUNDLED$n$, 'nexus-forge', $n$Payment bundles · 01 — 06$n$, array[$n$NEXUS$n$, $n$REBUILDERS BUNDLED$n$]::text[], 4, false, ''),
    ('forge-paradox-bundled-399', '06', $n$NEXUS REBUILDERS BUNDLED$n$, 'nexus-forge', $n$Payment bundles · 01 — 06$n$, array[$n$NEXUS$n$, $n$REBUILDERS BUNDLED$n$]::text[], 5, false, ''),
    ('paradox-bundled-249', '07', $n$NEXUS OFF-GRID BUNDLED$n$, 'paradox', $n$Payment bundles · 07 — 08$n$, array[$n$NEXUS$n$, $n$OFF-GRID BUNDLED$n$]::text[], 6, false, ''),
    ('paradox-bundled-349', '08', $n$NEXUS OFF-GRID BUNDLED$n$, 'paradox', $n$Payment bundles · 07 — 08$n$, array[$n$NEXUS$n$, $n$OFF-GRID BUNDLED$n$]::text[], 7, false, '')
  on conflict (id) do nothing
  returning id
)
insert into nexus_seed_publish (id) select id from seeded;

insert into public.bundle_includes
  (bundle_id, position, event_id, pick_realm, pick_count, exclude_hackathon)
values
    ('bundled-299', 0, 'nexus-breach', null, null, false),
    ('bundled-299', 1, null, 'paradox', 1, false),
    ('bundled-349', 0, 'nexus-breach', null, null, false),
    ('bundled-349', 1, null, 'paradox', 2, false),
    ('forge-bundled-349', 0, 'nexus-breach', null, null, false),
    ('forge-bundled-349', 1, null, 'forge', 1, true),
    ('forge-bundled-399', 0, 'nexus-breach', null, null, false),
    ('forge-bundled-399', 1, null, 'forge', 2, true),
    ('bundled-399', 0, null, 'forge', 2, true),
    ('bundled-399', 1, null, 'paradox', 3, false),
    ('forge-paradox-bundled-399', 0, 'nexus-breach', null, null, false),
    ('forge-paradox-bundled-399', 1, null, 'forge', 1, true),
    ('forge-paradox-bundled-399', 2, null, 'paradox', 2, false),
    ('paradox-bundled-249', 0, null, 'paradox', 2, false),
    ('paradox-bundled-349', 0, null, 'paradox', 3, false)
on conflict (bundle_id, position) do nothing;

-- Publish ONLY the rows this run inserted, and only once their lines have given
-- them a key. Both guards are load-bearing and neither replaces the other:
--   * the temp table is what stops a retired bundle being revived on a re-run;
--   * content_key/exists stop publishing a parent whose include lines did not
--     land, which would otherwise abort the whole migration on the CHECK.
update public.bundle_catalogue bc
   set is_active = true
 where bc.is_active = false
   and bc.content_key <> ''
   and exists (select 1 from public.bundle_includes bi where bi.bundle_id = bc.id)
   and bc.id in (select id from nexus_seed_publish);

-- public.pricing is the price authority and the console edits it, so this seed
-- only fills ABSENT rows. ON CONFLICT DO NOTHING is what stops a regenerated seed
-- from overwriting a price a master has since changed.
insert into public.pricing (kind, ref_id, price)
values
    ('bundle', 'bundled-299', 299),
    ('bundle', 'bundled-349', 349),
    ('bundle', 'forge-bundled-349', 349),
    ('bundle', 'forge-bundled-399', 399),
    ('bundle', 'bundled-399', 399),
    ('bundle', 'forge-paradox-bundled-399', 399),
    ('bundle', 'paradox-bundled-249', 249),
    ('bundle', 'paradox-bundled-349', 349)
on conflict (kind, ref_id) do nothing;

insert into public.pricing (kind, ref_id, price)
values
    ('event', 'nexus-breach', 349),
    ('event', 'vision-2065', 249),
    ('event', 'circuits-of-nexus', 249),
    ('event', 'ai-turing-gambit', 249),
    ('event', 'code-rebuilding', 249),
    ('event', 'the-scientist-files', 249),
    ('event', 'paradox-2065', 149),
    ('event', 'shutter-quest', 149),
    ('event', 'matrix', 149),
    ('event', 'pixel-resistance', 149),
    ('event', 'free-fire', 149)
on conflict (kind, ref_id) do nothing;
-- == SEED END ==


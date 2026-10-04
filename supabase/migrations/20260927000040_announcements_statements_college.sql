-- =============================================================================
-- NEXUS — announcements, problem statements, and one more college
-- Migration : 20260927000040_announcements_statements_college.sql
-- Purpose   : Two pieces of public content the operations team owns rather than
--             a developer:
--               * announcements — dated notices, pinned or not, with an optional
--                 link (results are published, deadlines move, a hall changes);
--               * problem statements — the per-event brief a hackathon team
--                 actually reads, editable in the console and rendered on its own
--                 public page.
--
-- Access shape, copied from the contacts migration on purpose:
--   - the tables carry NO client policy at all, read or write. The public pages
--     read through public_*() and the console reads through staff_list_*(), so a
--     participant with a Supabase session gets no more than an anonymous visitor.
--   - every write is a SECURITY DEFINER RPC that re-checks the staff role itself.
--     Hiding the console tab is a courtesy; the database is the control.
--
-- WHY THESE ARE ROWS AND NOT REACT STATE
-- Editable public content has been wrong in this project before — a phone number
-- in a component, an address typed into a table by hand (see ...00013_contacts).
-- Content an operator is expected to keep current belongs in the database, behind
-- the same role gate as everything else.
--
-- RETIRE, NEVER DELETE
-- Same reasoning as contacts. A participant may have read an announcement or
-- screenshotted a brief. Deleting the row does not un-read it, and the audit
-- trail is the record of what was published. is_active = false is how a row comes
-- off the public page.
--
-- Idempotent: if-not-exists / create or replace / drop-if-exists + create.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. announcements
-- ---------------------------------------------------------------------------
-- published_at is separate from created_at because an announcement is often
-- written before it is real: the date goes in, is_active stays false, and it
-- appears when the day arrives. created_at would say "queued", which is not a
-- thing anybody can read.

create table if not exists public.announcements (
  id           uuid primary key default gen_random_uuid(),
  title        text        not null,
  body         text        not null,
  -- A short category the page renders as a label ("Results", "Schedule"). Free
  -- text, not an enum: the team invents these faster than a migration can be
  -- applied, and a wrong one is a label, not a failure.
  tag          text,
  -- Optional call to action. Both halves are nullable and shown only when the pair
  -- is complete, so a half-typed row renders as plain text rather than as a link
  -- that goes nowhere.
  link_label   text,
  link_href    text,
  is_pinned    boolean     not null default false,
  is_active    boolean     not null default false,
  published_at timestamptz,
  sort_order   integer     not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  updated_by   text
);

comment on table public.announcements is
  'Public notices, newest first. Written and retired from the console''s Announcements tab; /announcements renders only the active ones, through public_announcements(). Retired, never deleted: a notice somebody has already read does not stop existing because it was hidden.';

-- A row with no title is not an announcement; a row whose link is half-typed is
-- still renderable, because the page falls back to plain text for it.
alter table public.announcements
  drop constraint if exists announcements_title_not_blank;
alter table public.announcements
  add constraint announcements_title_not_blank
  check (btrim(title) <> '');

-- A link is either a whole call to action or none. One half alone is the exact
-- shape that produces a button labelled "Read more" that does nothing.
alter table public.announcements
  drop constraint if exists announcements_link_is_whole;
alter table public.announcements
  add constraint announcements_link_is_whole
  check (
    (link_label is null and link_href is null)
    or (nullif(btrim(link_label), '') is not null and nullif(btrim(link_href), '') is not null)
  );

-- Covers the ONLY query the public page makes.
create index if not exists ix_announcements_public
  on public.announcements (published_at desc, sort_order, created_at desc)
  where is_active;

-- ---------------------------------------------------------------------------
-- 2. problem_statements
-- ---------------------------------------------------------------------------
-- event_id is a soft reference to public.event_catalogue.id (the slug, e.g.
-- 'nexus-breach'), deliberately NOT a foreign key: the catalogue is edited by
-- masters and retired rows are kept, so a hard constraint would either block a
-- legitimate catalogue rename or cascade-delete a brief somebody spent an hour
-- writing. The page looks the event name up and omits the label when the slug no
-- longer resolves.

create table if not exists public.problem_statements (
  id          uuid primary key default gen_random_uuid(),
  event_id    text,
  title       text        not null,
  -- The one-line version: the card title and the line under the heading.
  summary     text        not null,
  -- The long version. Optional on purpose: many events have a genuinely short
  -- brief, and forcing a paragraph nobody wrote is how empty boxes ship.
  detail      text,
  -- Theme / track, when an event runs one ("Sustainability", "Fintech"). Free
  -- text for the same reason the announcement tag is.
  track       text,
  is_active   boolean     not null default false,
  sort_order  integer     not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  updated_by  text
);

comment on table public.problem_statements is
  'The brief each hackathon team reads: title, summary and optional long detail, optionally tied to an event slug. Edited in the console''s Problem statements tab; /problem-statements renders only the active ones, through public_problem_statements().';

alter table public.problem_statements
  drop constraint if exists problem_statements_title_not_blank;
alter table public.problem_statements
  add constraint problem_statements_title_not_blank
  check (btrim(title) <> '');

alter table public.problem_statements
  drop constraint if exists problem_statements_summary_not_blank;
alter table public.problem_statements
  add constraint problem_statements_summary_not_blank
  check (btrim(summary) <> '');

create index if not exists ix_problem_statements_public
  on public.problem_statements (sort_order, created_at)
  where is_active;

-- NOT unique on event_id: an event running two tracks genuinely has two
-- problems. Ordering is the operator's own number.
create index if not exists ix_problem_statements_event
  on public.problem_statements (event_id, sort_order)
  where is_active;

alter table public.problem_statements enable row level security;

-- ---------------------------------------------------------------------------
-- 3. public_announcements() — what /announcements renders
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER with `stable`, not `volatile`: this reads, and marking it
-- volatile would tell the planner it can change the answer between rows in one
-- statement. Two announcements pinned together must not disagree about their own
-- list.
--
-- Pinned first, then newest. A pin is a statement about importance, so it
-- outranks recency — otherwise pinning something and then posting an unrelated
-- notice tomorrow buries it, which is the opposite of what the button was for.
create or replace function public.public_announcements (p_limit integer default 50)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'ok', true,
    'announcements', coalesce((
      select jsonb_agg(to_jsonb(a) - 'created_at' - 'updated_at' - 'updated_by'
                       order by a.is_pinned desc,
                                coalesce(a.published_at, a.created_at) desc,
                                a.sort_order, a.created_at desc)
        from (
          select a.* from public.announcements a
           where a.is_active
             and (a.published_at is null or a.published_at <= now())
           order by a.is_pinned desc,
                    coalesce(a.published_at, a.created_at) desc,
                    a.sort_order, a.created_at desc
           limit greatest(coalesce(p_limit, 50), 1)
        ) a
    ), '[]'::jsonb)
  );
$$;

comment on function public.public_announcements(integer) is
  'The notices /announcements renders: active, and not dated in the future. Pinned first, then newest. Public because a notice with no reader is not a notice; it carries no participant data.';

revoke execute on function public.public_announcements(integer) from public;
grant  execute on function public.public_announcements(integer) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. public_problem_statements() — what /problem-statements renders
-- ---------------------------------------------------------------------------
-- Carries the event's display name and date alongside each brief, resolved here
-- rather than in the browser. A slug that no longer matches a catalogue row comes
-- back with a null name and the page simply omits the label, instead of every
-- statement in that event rendering as the word "undefined".
create or replace function public.public_problem_statements (p_event_id text default null)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'ok', true,
    'statements', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id',          s.id,
               'title',       s.title,
               'summary',     s.summary,
               'detail',      s.detail,
               'track',       s.track,
               'event_id',    s.event_id,
               'event_title', e.title,
               'event_date',  e.event_date,
               'event_slug',  e.id
             ) order by s.sort_order, s.created_at)
        from public.problem_statements s
        -- LEFT JOIN, deliberately: a brief whose event was retired is still a
        -- brief. An inner join would silently delete it from the page.
        left join public.event_catalogue e on e.id = s.event_id
       where s.is_active
         and (p_event_id is null or s.event_id = p_event_id)
    ), '[]'::jsonb),
    'events', coalesce((
      -- The filter the page offers: only events that actually have a brief, so
      -- choosing one cannot produce an empty page.
      select jsonb_agg(jsonb_build_object('id', e.id, 'title', e.title) order by e.title)
        from (select distinct c.id, c.title
                from public.problem_statements s
                join public.event_catalogue c on c.id = s.event_id
               where s.is_active) e
    ), '[]'::jsonb)
  );
$$;

comment on function public.public_problem_statements(text) is
  'The briefs /problem-statements renders, with each event''s display name and date resolved server-side. Pass an event slug to narrow to one event, or null for everything. A slug that no longer resolves still returns its brief, with a null event_title.';

revoke execute on function public.public_problem_statements(text) from public;
grant  execute on function public.public_problem_statements(text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. staff_list_announcements() — the console's list, retired rows included
-- ---------------------------------------------------------------------------
-- A retired announcement is not a deleted one: participants may have read it. The
-- console needs to see is_active = false rows to re-publish one or to understand
-- what used to be there. Future-dated rows are shown too — the whole point of
-- scheduling is that the operator can see what is coming.
create or replace function public.staff_list_announcements ()
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

  return jsonb_build_object(
    'ok', true,
    'announcements', coalesce((
      select jsonb_agg(to_jsonb(a) - 'updated_by'
                       order by a.is_pinned desc, a.is_active desc,
                                coalesce(a.published_at, a.created_at) desc,
                                a.sort_order, a.created_at desc)
        from public.announcements a
    ), '[]'::jsonb)
  );
end;
$$;

revoke execute on function public.staff_list_announcements() from public;
grant  execute on function public.staff_list_announcements() to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. staff_upsert_announcement() — create or edit
-- ---------------------------------------------------------------------------
-- ADMIN+, matching staff_upsert_contact. An announcement is what a participant
-- reads when something has changed, and the team that runs the event is the team
-- that knows what changed. The console tab is gated on the same capability; widen
-- this list and the tab together, never one alone.
create or replace function public.staff_upsert_announcement (p_announcement jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id      uuid := coalesce(nullif(btrim(coalesce(p_announcement ->> 'id', '')), '')::uuid,
                             gen_random_uuid());
  v_new     boolean;
  v_title   text;
  v_body    text;
  v_label   text;
  v_href    text;
begin
  if not public.staff_at_least('admin') then
    return jsonb_build_object('ok', false,
      'error', 'Only an administrator can publish an announcement.');
  end if;

  v_title := btrim(coalesce(p_announcement ->> 'title', ''));
  v_body  := coalesce(p_announcement ->> 'body', '');

  if v_title = '' then
    return jsonb_build_object('ok', false, 'error', 'An announcement needs a title.');
  end if;

  -- The link constraint, as a message rather than a constraint violation. Half a
  -- link is the state that produces a dead "Read more" button, so it is refused
  -- here where the operator can read it, not at the table where they cannot.
  v_label := nullif(btrim(coalesce(p_announcement ->> 'link_label', '')), '');
  v_href  := nullif(btrim(coalesce(p_announcement ->> 'link_href', '')), '');
  if (v_label is null) <> (v_href is null) then
    return jsonb_build_object('ok', false,
      'error', 'A link needs both a label and a destination, or neither.');
  end if;

  -- Asked AFTER v_id is resolved. This ordering is not cosmetic: with v_id still
  -- NULL the predicate `a.id = NULL` is never true, `not exists` is always true,
  -- and every edit would be audited as a create.
  select not exists (select 1 from public.announcements a where a.id = v_id)
    into v_new;

  insert into public.announcements as a
    (id, title, body, tag, link_label, link_href, is_pinned, is_active,
     published_at, sort_order, updated_by)
  values
    (v_id,
     v_title,
     v_body,
     nullif(btrim(coalesce(p_announcement ->> 'tag', '')), ''),
     v_label,
     v_href,
     coalesce((p_announcement ->> 'is_pinned')::boolean, false),
     coalesce((p_announcement ->> 'is_active')::boolean, false),
     nullif(btrim(coalesce(p_announcement ->> 'published_at', '')), '')::timestamptz,
     coalesce(nullif(btrim(p_announcement ->> 'sort_order'), '')::int, 0),
     (select s.username from public.staff_session() s))
  on conflict (id) do update
     set title        = excluded.title,
         body         = excluded.body,
         tag          = excluded.tag,
         link_label   = excluded.link_label,
         link_href    = excluded.link_href,
         is_pinned    = excluded.is_pinned,
         is_active    = excluded.is_active,
         published_at = excluded.published_at,
         sort_order   = excluded.sort_order,
         updated_at   = now(),
         updated_by   = excluded.updated_by
  returning a.id into v_id;

  perform public.staff_audit(
    case when v_new then 'create_announcement' else 'update_announcement' end,
    'announcement', v_id::text,
    jsonb_build_object('title', v_title, 'pinned', coalesce((p_announcement ->> 'is_pinned')::boolean, false))
  );

  return jsonb_build_object('ok', true, 'id', v_id, 'created', v_new);
end;
$$;

revoke execute on function public.staff_upsert_announcement(jsonb) from public;
grant  execute on function public.staff_upsert_announcement(jsonb) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 7. staff_retire_announcement() — take one off the public page
-- ---------------------------------------------------------------------------
-- Retire, never delete, for the same reason contacts are retired: the notice was
-- published, and the audit trail is the record of what was said. Re-publishing is
-- an upsert with is_active = true.
create or replace function public.staff_retire_announcement (p_announcement_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_title text;
begin
  if not public.staff_at_least('admin') then
    return jsonb_build_object('ok', false,
      'error', 'Only an administrator can retire an announcement.');
  end if;

  update public.announcements a
     set is_active = false, updated_at = now(),
         updated_by = (select s.username from public.staff_session() s)
   where a.id = p_announcement_id
  returning a.title into v_title;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'No such announcement.');
  end if;

  perform public.staff_audit('retire_announcement', 'announcement',
                            p_announcement_id::text,
                            jsonb_build_object('title', v_title));
  return jsonb_build_object('ok', true, 'id', p_announcement_id);
end;
$$;

revoke execute on function public.staff_retire_announcement(uuid) from public;
grant  execute on function public.staff_retire_announcement(uuid) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 8. the problem statements' console functions
-- ---------------------------------------------------------------------------
-- Same shape as the announcements above, admin+ to write. Listed together because
-- they are the same screen with different fields, and reading them side by side is
-- the only way to notice they have drifted apart.

create or replace function public.staff_list_problem_statements ()
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

  return jsonb_build_object(
    'ok', true,
    'statements', coalesce((
      -- Every catalogue row, retired ones included, so the console can offer the
      -- event dropdown without a second round trip — and so a brief can be
      -- attached to an event that is not yet active.
      select jsonb_agg(jsonb_build_object('id', e.id, 'title', e.title, 'is_active', e.is_active)
                       order by e.title)
        from public.event_catalogue e
    ), '[]'::jsonb),
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id',       s.id,
               'event_id', s.event_id,
               'title',    s.title,
               'summary',  s.summary,
               'detail',   s.detail,
               'track',    s.track,
               'is_active', s.is_active,
               'sort_order', s.sort_order,
               'updated_at',  s.updated_at
             ) order by s.is_active desc, s.sort_order, s.created_at desc)
        from public.problem_statements s
    ), '[]'::jsonb)
  );
end;
$$;

revoke execute on function public.staff_list_problem_statements() from public;
grant  execute on function public.staff_list_problem_statements() to anon, authenticated;

create or replace function public.staff_upsert_problem_statement (p_statement jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id    uuid := coalesce(nullif(btrim(coalesce(p_statement ->> 'id', '')), '')::uuid,
                           gen_random_uuid());
  v_new   boolean;
  v_title text;
begin
  if not public.staff_at_least('admin') then
    return jsonb_build_object('ok', false,
      'error', 'Only an administrator can edit a problem statement.');
  end if;

  v_title := btrim(coalesce(p_statement ->> 'title', ''));
  if v_title = '' then
    return jsonb_build_object('ok', false, 'error', 'A problem statement needs a title.');
  end if;
  if btrim(coalesce(p_statement ->> 'summary', '')) = '' then
    return jsonb_build_object('ok', false,
      'error', 'A problem statement needs a one-line summary, even if the detail is empty.');
  end if;

  -- Same ordering trap as the announcements: v_id is resolved in the DECLARE, so
  -- this asks a question that has an answer. Ask it before assigning and every
  -- edit is audited as a create.
  select not exists (select 1 from public.problem_statements s where s.id = v_id)
    into v_new;

  insert into public.problem_statements as s
    (id, event_id, title, summary, detail, track, is_active, sort_order, updated_by)
  values
    (v_id,
     nullif(btrim(coalesce(p_statement ->> 'event_id', '')), ''),
     v_title,
     btrim(coalesce(p_statement ->> 'summary', '')),
     nullif(btrim(coalesce(p_statement ->> 'detail', '')), ''),
     nullif(btrim(coalesce(p_statement ->> 'track', '')), ''),
     coalesce((p_statement ->> 'is_active')::boolean, false),
     coalesce(nullif(btrim(p_statement ->> 'sort_order'), '')::int, 0),
     (select st.username from public.staff_session() st))
  on conflict (id) do update
     set event_id   = excluded.event_id,
         title      = excluded.title,
         summary    = excluded.summary,
         detail     = excluded.detail,
         track      = excluded.track,
         is_active  = excluded.is_active,
         sort_order = excluded.sort_order,
         updated_at = now(),
         updated_by = excluded.updated_by
  returning s.id into v_id;

  perform public.staff_audit(
    case when v_new then 'create_problem_statement' else 'update_problem_statement' end,
    'problem_statement', v_id::text,
    jsonb_build_object('title', v_title,
                       'event', nullif(btrim(coalesce(p_statement ->> 'event_id', '')), ''))
  );

  return jsonb_build_object('ok', true, 'id', v_id, 'created', v_new);
end;
$$;

revoke execute on function public.staff_upsert_problem_statement(jsonb) from public;
grant  execute on function public.staff_upsert_problem_statement(jsonb) to anon, authenticated;

create or replace function public.staff_retire_problem_statement (p_statement_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_title text;
begin
  if not public.staff_at_least('admin') then
    return jsonb_build_object('ok', false,
      'error', 'Only an administrator can retire a problem statement.');
  end if;

  update public.problem_statements s
     set is_active = false, updated_at = now(),
         updated_by = (select st.username from public.staff_session() st)
   where s.id = p_statement_id
  returning s.title into v_title;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'No such problem statement.');
  end if;

  perform public.staff_audit('retire_problem_statement', 'problem_statement',
                            p_statement_id::text,
                            jsonb_build_object('title', v_title));
  return jsonb_build_object('ok', true, 'id', p_statement_id);
end;
$$;

revoke execute on function public.staff_retire_problem_statement(uuid) from public;
grant  execute on function public.staff_retire_problem_statement(uuid) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 9. one more college for the roster filter
-- ---------------------------------------------------------------------------
-- staff_filter_options() is the union of two sets: the college_name values that
-- actually appear on registrations, and every ACTIVE row in public.colleges. That
-- second half exists precisely so a college somebody just added is offered before
-- anybody has registered from it — and it reports its count as 0, so the operator
-- sees "nobody from there yet" rather than an empty roster that looks like a
-- broken filter.
--
-- The name is the institute's full name, which is what a participant types and
-- what a judge reads on a certificate. The roster currently also holds the
-- "ANNAMACHARYA ... :: TIRUPATI" spelling that predates this table; both stay,
-- because a filter value that vanishes under somebody's feet mid-event is worse
-- than two similar-looking options in a dropdown.
--
-- Idempotent: the normalised unique index (uq_colleges_name, on lower(btrim(name)))
-- means this cannot create a second copy in a different case, and ON CONFLICT DO
-- NOTHING makes re-running the migration free.
insert into public.colleges (name, is_active)
values ('Annamacharya Institute of Technology and Sciences', true)
on conflict do nothing;
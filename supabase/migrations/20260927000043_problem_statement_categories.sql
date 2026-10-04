-- ---------------------------------------------------------------------------
-- 20260927000043 — problem statements, filtered by event AND category
--
-- WHY THIS REPLACES migration ...0040's FUNCTION rather than adding one: it has
-- the SAME NAME with a different argument list, and PostgREST resolves an RPC by
-- name. Leaving the old one-argument version in place would leave two functions
-- called public_problem_statements, and which one a call reaches would depend on
-- argument count — the kind of ambiguity that passes every test and then serves
-- the wrong rows in production. So it is dropped first, then recreated.
--
-- WHAT CHANGED, and why the page asked for it:
--   - p_track, so a reader can narrow by CATEGORY as well as event. The `track`
--     column already existed and was already rendered as a badge on each card,
--     so the data was there and only reachable one row at a time. An operator
--     could file a brief under a category that no reader could ever browse.
--   - The two filter lists now carry COUNTS, and the page disables a zero-count
--     option. That is what stops the blank page: an event can exist with a
--     brief in no category at all, and offering it beside a category filter
--     invites a combination that returns nothing.
--
-- THE COUNTS ARE FACETED, not global: an event's count is how many briefs it has
-- WITHIN the chosen category, and a category's count is how many briefs it has
-- WITHIN the chosen event. Counting globally instead would advertise a
-- combination as available when the two filters together yield nothing.
--
-- Both lists are built from every active brief regardless of the OTHER filter,
-- so a selected option can never vanish from the dropdown it lives in — which is
-- what would otherwise leave the control showing a value that is not in its own
-- option list.
--
-- Track matching is case- and whitespace-insensitive. It is free text typed by
-- an operator, and "Sustainability" and "sustainability" are the same category to
-- a reader; without this they would appear as two categories and one of them
-- would silently come back empty.
-- ---------------------------------------------------------------------------

drop function if exists public.public_problem_statements (text);

create or replace function public.public_problem_statements (
  p_event_id text default null,
  p_track    text default null
)
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
         and (p_track is null or lower(btrim(s.track)) = lower(btrim(p_track)))
    ), '[]'::jsonb),

    -- BOTH FILTER LISTS ARE BUILT WITHOUT THE OTHER FILTER.
    --
    -- This is the opposite of what the counts do, and the reason matters. The
    -- COUNT is faceted — an event's count is what it holds within the chosen
    -- category — but the LIST is not narrowed. Narrowing the list too collapses
    -- the dropdown the moment a filter leaves one option: pick a category that
    -- only one event has a brief in, and the event control DISAPPEARS, taking the
    -- reader's only way to widen the search with it. The count carries the
    -- narrowing; the list carries the choice.
    --
    -- That is also why the page disables a zero-count option rather than hiding
    -- it. The option stays visible — "this event exists, it has nothing in that
    -- category" — and cannot be chosen.

    /* Every event that has any brief at all, with the count it has under the
       chosen category — which is zero for most of them the moment a category is
       picked. The page greys those out rather than dropping them. */
    'events', coalesce((
      select jsonb_agg(jsonb_build_object('id', g.id, 'title', g.title, 'count', g.n)
                       order by g.title)
        from (
          select c.id,
                 c.title,
                 count(*) filter (
                   where p_track is null
                      or lower(btrim(s.track)) = lower(btrim(p_track))
                 )::int as n
            from public.problem_statements s
            join public.event_catalogue c on c.id = s.event_id
           where s.is_active
           group by c.id, c.title
        ) g
    ), '[]'::jsonb),

    /* The category filter's options, on the same terms: every category that
       exists, with how many briefs it holds within the chosen event. Blank
       tracks are excluded — a brief with no category stays reachable under "All
       categories", and an empty row in the dropdown would select on nothing. */
    'tracks', coalesce((
      select jsonb_agg(jsonb_build_object(
               'name',  lower(g.label),
               'label', g.label,
               'count', g.n
             ) order by lower(g.label))
        from (
          select min(btrim(s.track)) as label,
                 count(*) filter (
                   where p_event_id is null or s.event_id = p_event_id
                 )::int as n
            from public.problem_statements s
           where s.is_active
             and nullif(btrim(s.track), '') is not null
           group by lower(btrim(s.track))
        ) g
    ), '[]'::jsonb)
  );
$$;

comment on function public.public_problem_statements(text, text) is
  'The briefs /problem-statements renders, with each event''s display name and date resolved server-side. Pass an event slug and/or a category (p_track, matched case- and whitespace-insensitively) to narrow, or null for everything. A slug that no longer resolves still returns its brief, with a null event_title. `events` and `tracks` are the two filter lists, each carrying a count FACETED by the other filter: an option whose count is 0 cannot be combined with the current selection.';

revoke execute on function public.public_problem_statements(text, text) from public;
grant  execute on function public.public_problem_statements(text, text) to anon, authenticated;

-- The category browse is a second access path onto the same rows, so it needs an
-- index of its own. The event index cannot serve it: filtering by category alone
-- has no event to lead with.
create index if not exists ix_problem_statements_track
  on public.problem_statements (lower(btrim(track)), sort_order)
  where is_active;
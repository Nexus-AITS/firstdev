-- =============================================================================
-- NEXUS - the team a leader brings
-- Migration : 20260927000029_team_roster.sql
-- Purpose   : Store the TEAM NAME and the MEMBERS a leader enters, under a cap
--             the database owns, for every event whose team is formed here.
--
-- WHAT WAS MISSING
--
-- ...028 made a team event mean "one leader pays for the squad". Nothing said
-- WHO is in the squad. The wizard asked the leader for their own details and
-- their own in-game id and then took their money, so the roster held a payment
-- for a team whose membership did not exist anywhere - and the operations team
-- had no list to call at the venue.
--
-- WHY A CHILD TABLE AND NOT MORE COLUMNS ON registrations
--
-- Because it is one-to-many and everything else on this schema says so already:
-- registration_events is a child of registrations for exactly the same reason,
-- with the same FK cascade and the same "the browser may insert, so a trigger
-- must enforce" argument (...016). A jsonb column on the parent would have been
-- one fewer table and no way to search a member's name, filter a roster by it,
-- or ask the database "is this roll number already on a team somewhere".
--
-- WHY THE LEADER IS NOT A ROW HERE
--
-- The leader IS the registration. Their name, roll number, college and phone
-- are already stored, verified by a Google sign-in, and paid for. Copying them
-- into registration_members would create two records of one person that can
-- disagree - and the copy would be the less trustworthy one. So team size is
-- ALWAYS 1 + count(members), and the cap is read against that sum.
--
-- WHY THE CAP IS A TRIGGER
--
-- registration_events is directly INSERT-able by a signed-in participant
-- under RLS, and registration_members is granted the same way, so a check
-- inside a function would be bypassable by anyone posting to the REST API. The
-- trigger is the single point every write must pass through - the same argument
-- ...016 makes for the registration limit.
--
-- WHY A MINIMUM IS NOT ENFORCED
--
-- The cap is an upper bound and nothing more, for the reason ...017 gives: "1 -
-- 3 MEMBERS" is a real shape on this site, and a team of one - the leader alone
-- - is a legitimate entry. A minimum would be a rule this migration invents.
--
-- Idempotent: add-column-if-not-exists, create-table-if-not-exists,
-- create-index-if-not-exists, create-or-replace, drop-*-if-exists.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. the team name
-- ---------------------------------------------------------------------------
-- On the registration, not on a teams table, for the same reason the leader is
-- not a member row: one registration is one purchase and therefore one team.
-- Nullable, because an individual event has no team, and a blank must not be
-- stored as the empty string.

alter table public.registrations
  add column if not exists team_name text;

alter table public.registrations
  drop constraint if exists chk_registrations_team_name;

alter table public.registrations
  add constraint chk_registrations_team_name
    check (team_name is null
           or char_length(btrim(team_name)) between 2 and 60);

comment on column public.registrations.team_name is
  'The name this team enters under, e.g. "NULL POINTERS". Carried by the LEADER''s registration - one purchase is one team. NULL for an individual event. Between 2 and 60 characters once trimmed.';

comment on table public.registrations is
  'NEXUS participant registrations. One row is one PURCHASE (migration ...023), which for a team event is one team: the leader is this row and their teammates are in public.registration_members.';

-- ---------------------------------------------------------------------------
-- 2. the members
-- ---------------------------------------------------------------------------

create table if not exists public.registration_members (
  id              uuid        primary key default gen_random_uuid(),
  registration_id uuid        not null references public.registrations (id) on delete cascade,
  position        integer     not null,
  name            text        not null,
  email           text        not null,
  roll_number     text        not null,
  college_name    text        not null,
  year            text        not null,
  department      text        not null,
  phone_number    text,
  created_at      timestamptz not null default now(),

  -- The same profile rules the leader's own row is held to, so a member is
  -- never a worse record than a leader. Copied rather than referenced because
  -- they are facts about a person on THIS team, not a profile to be shared.
  constraint chk_registration_members_position
    check (position between 1 and 50),
  constraint chk_registration_members_name
    check (char_length(btrim(name)) between 2 and 120),
  constraint chk_registration_members_roll
    check (char_length(btrim(roll_number)) between 3 and 40),
  constraint chk_registration_members_college
    check (char_length(btrim(college_name)) between 2 and 160),
  constraint chk_registration_members_year
    check (year in ('1st', '2nd', '3rd', '4th')),
  constraint chk_registration_members_department
    check (char_length(btrim(department)) between 2 and 80),
  constraint chk_registration_members_email
    check (email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  constraint chk_registration_members_phone
    check (phone_number is null
           or (char_length(btrim(phone_number)) between 8 and 15
               and phone_number ~ '^[+0-9][0-9 -]*[0-9]$'))
);

comment on table public.registration_members is
  'The teammates a leader entered, for an event whose team is formed on THIS site. The leader is not a row here - they are the registration, so a team is always 1 + count(these). A member is a guest on this team, not a NEXUS account: their email is recorded for the operations team and is deliberately NOT unique, because the same person may lead a different team for a different event.';

-- position is the order the leader typed them in, which is the only order that
-- means anything to them. Reading a team in a random order at the venue is the
-- kind of small wrongness that makes an operations team stop trusting a list.
create unique index if not exists uq_registration_members_position
  on public.registration_members (registration_id, position);

-- The roster lists, filters and exports by member, so the leader's own row is
-- the one that is always read first.
create index if not exists idx_registration_members_registration
  on public.registration_members (registration_id, position);

-- Free-text member search, trigram-indexed for the same reason ...012 indexes
-- the roster: a leading wildcard cannot use a btree, and "find me Aarav" has to
-- find an Aarav who is not on the page being looked at.
create index if not exists ix_registration_members_name_trgm
  on public.registration_members using gin (name gin_trgm_ops);
create index if not exists ix_registration_members_roll_trgm
  on public.registration_members using gin (roll_number gin_trgm_ops);
create index if not exists ix_registration_members_email_trgm
  on public.registration_members using gin (email gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- 3. the cap, resolved from the catalogue
-- ---------------------------------------------------------------------------
-- ONE function answers "how many may this registration's team contain?", and
-- both the trigger and the wizard-facing RPC call it. Two definitions of the
-- cap is how a limit and a counter end up disagreeing on the same screen, which
-- is worse than either being absent - the argument ...016 makes for
-- event_registered_count.
--
-- "The registration's team" is not always one event:
--
--   * a single-event purchase names it in purchase_ref;
--   * a bundle names several, and only the ones whose team is formed HERE
--     impose a cap. An offsite one (the hackathon) has no roster at all.
--
-- So this is the MINIMUM cap across the team-formed-here events the
-- registration covers, which is the tightest promise the leader is making. Null
-- means "this purchase has no team formed here" - the caller then refuses a
-- roster rather than inventing a cap of 50.

create or replace function public.registration_team_cap (p_registration_id uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select min(ec.max_team_members)
    from (
      select ec.id, ec.max_team_members, ec.entry_type, ec.payment_mode
        from public.event_catalogue ec
       where ec.id = (
               select r.purchase_ref
                 from public.registrations r
                where r.id = p_registration_id
                  and r.purchase_type = 'event')
       union all
       select ec.id, ec.max_team_members, ec.entry_type, ec.payment_mode
         from public.registration_events re
         join public.event_catalogue ec on ec.id = re.event_id
        where re.registration_id = p_registration_id
    ) ec
   where ec.entry_type = 'team'
     and ec.payment_mode = 'per_team'
     and ec.max_team_members is not null;
$$;

comment on function public.registration_team_cap(uuid) is
  'How many people this registration''s team may contain, INCLUDING the leader - so a cap of 3 allows the leader and two teammates. The minimum cap across the team-formed-here events the purchase covers. NULL when the purchase has no team formed here, which is the hackathon''s case and every individual event: there is no roster to collect and the caller refuses one.';

revoke execute on function public.registration_team_cap(uuid) from public;
grant  execute on function public.registration_team_cap(uuid) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. the cap, enforced
-- ---------------------------------------------------------------------------
-- BEFORE INSERT OR UPDATE, so a refused member never lands. On DELETE there is
-- nothing to enforce - removing a member can only make the team smaller - and
-- the trigger is deliberately not attached to it, so a team edit does not pay
-- for a check that cannot fail.
--
-- The count excludes the row being inserted (it does not exist yet) and
-- registration_set_team_members deletes the previous roster before re-inserting,
-- so re-saving a team cannot count anybody twice either.

create or replace function public.enforce_team_size_cap ()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_cap   integer;
  v_after integer;
begin
  v_cap := public.registration_team_cap(new.registration_id);

  if v_cap is null then
    raise exception
      'This registration is not a team entered on NEXUS, so it has no teammates to list. Each member registers and pays separately.'
      using errcode = '23514';
  end if;

  /* The size this row WOULD make the team, not the size it is now. This is the
     off-by-one that matters: the count below sees only the members already
     stored, so the team is `existing` members plus the leader, and the row being
     inserted is a further one on top. Both have to be added - `existing + 2` -
     before comparing against a cap that counts PEOPLE.
     Getting it wrong by one here is silent and forgiving in the wrong
     direction: every team ends up allowed one person over its stated cap, and
     the operations team discovers it at the venue. */
  v_after := (select count(*)::integer
                from public.registration_members rm
               where rm.registration_id = new.registration_id)
           + 2;  -- the row being inserted, plus the leader who is the registration

  if v_after > v_cap then
    raise exception
      'This team already has % of a maximum % people (the leader counts). Remove someone before adding another.', v_after, v_cap
      using errcode = '23514';
  end if;

  return new;
end;
$$;

comment on function public.enforce_team_size_cap() is
  'BEFORE INSERT OR UPDATE on registration_members. Refuses a member that would take the team past the event''s max_team_members, counting the leader as one of them. Lives on the table rather than inside the RPC because registration_members is directly insertable by a participant under RLS, so a check in a function would be bypassable.';

drop trigger if exists trg_registration_members_cap on public.registration_members;

create trigger trg_registration_members_cap
  before insert or update on public.registration_members
  for each row
  execute function public.enforce_team_size_cap();


-- ---------------------------------------------------------------------------
-- 5. the write
-- ---------------------------------------------------------------------------
-- One call replaces the whole roster, rather than an add and a remove per
-- member. A leader who mistypes somebody's roll number fixes it in one save and
-- the list on screen is the list in the database; with per-member writes the
-- page and the row can disagree after a failed second insert.
--
-- THE BROWSER SUPPLIES FACTS, NEVER RULES
--
-- It sends names, emails and roll numbers. It does not send the count, the cap,
-- the positions, or the team size - those are read from the catalogue, and the
-- cap is enforced by the trigger whatever this function does. A client that
-- tried to pass a fourth member into a team of three is refused by
-- trg_registration_members_cap, not by anything here.

create or replace function public.registration_set_team_members (
  p_registration_id uuid,
  p_team_name       text,
  p_members         jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reg     public.registrations%rowtype;
  v_cap     integer;
  v_name    text;
  v_m       jsonb;
  v_fields  text[];
  v_missing text;
  v_i       integer;
  v_count   integer;
  v_seen    text[] := '{}';
  v_email   text;
begin
  select * into v_reg from public.registrations r where r.id = p_registration_id;
  if not found then
    raise exception 'That registration could not be found.' using errcode = 'P0002';
  end if;

  -- Own row only. RLS would refuse the table writes too, but saying so here
  -- turns a silent empty update into a sentence.
  if v_reg.user_id is distinct from auth.uid() then
    raise exception 'That registration is not yours.' using errcode = '42501';
  end if;

  if v_reg.selection_frozen or v_reg.payment_status = 'verified' then
    raise exception
      'This team is final - contact the operations team to change it.'
      using errcode = '42501';
  end if;

  v_cap := public.registration_team_cap(p_registration_id);
  if v_cap is null then
    raise exception
      'This event is not entered as a team on NEXUS, so there is no teammate list. Each participant registers and pays separately.'
      using errcode = '22023';
  end if;

  -- The name, held to the same rule as the column CHECK and reported as a
  -- sentence rather than a raw 23514.
  v_name := nullif(btrim(coalesce(p_team_name, '')), '');
  if v_name is null or char_length(v_name) not between 2 and 60 then
    raise exception
      'Give the team a name of 2 to 60 characters.' using errcode = '22023';
  end if;

  if p_members is null or jsonb_typeof(p_members) <> 'array' then
    raise exception 'The teammate list is not a list.' using errcode = '22023';
  end if;

  v_count := jsonb_array_length(p_members);
  -- Checked here AND by the trigger. The check here gives the leader one clear
  -- sentence before anything is written; the trigger is what actually stops a
  -- bypass.
  if v_count + 1 > v_cap then
    raise exception
      'A team may have at most % people and the leader counts as one, so you can add %.', v_cap, v_cap - 1
      using errcode = '22023';
  end if;


  update public.registrations r
     set team_name = v_name, updated_at = now()
   where r.id = p_registration_id;

  delete from public.registration_members rm where rm.registration_id = p_registration_id;

  for v_i in 0 .. v_count - 1 loop
    v_m := p_members -> v_i;

    v_fields := array['name', 'roll_number', 'email', 'college_name',
                      'year', 'department'];
    select string_agg(f, ', ')
      into v_missing
      from unnest(v_fields) f
     where nullif(btrim(coalesce(v_m ->> f, '')), '') is null;

    if v_missing is not null then
      raise exception
        'Teammate % is missing: %', v_i + 1, v_missing
        using errcode = '22023';
    end if;

    v_email := lower(btrim(v_m ->> 'email'));

    -- The same person typed twice is a mistake worth naming. There is no unique
    -- index that would catch it, because a member email is deliberately NOT
    -- unique ACROSS teams - the same student may sit on two different teams.
    if v_email = any (v_seen) then
      raise exception
        '% appears twice in the teammate list.', v_email
        using errcode = '22023';
    end if;
    v_seen := array_append(v_seen, v_email);

    -- The leader is not a teammate of themselves.
    if v_email = lower(btrim(v_reg.email)) then
      raise exception
        'That is your own email - you are the leader, so list only the others.'
        using errcode = '22023';
    end if;

    insert into public.registration_members
      (registration_id, position, name, email, roll_number,
       college_name, year, department, phone_number)
    values
      (p_registration_id, v_i + 1,
       btrim(v_m ->> 'name'), v_email, btrim(v_m ->> 'roll_number'),
       btrim(v_m ->> 'college_name'), v_m ->> 'year', btrim(v_m ->> 'department'),
       nullif(btrim(coalesce(v_m ->> 'phone_number', '')), ''));
  end loop;

  return jsonb_build_object(
    'ok', true,
    'team_name', v_name,
    'members', v_count,
    -- What the LEADER sees: the team is everyone, and the leader is one of them.
    'team_size', v_count + 1,
    'max_team_members', v_cap);
end;
$$;

comment on function public.registration_set_team_members(uuid, text, jsonb) is
  'Replaces a registration''s whole teammate list and its team name in one atomic save. The browser supplies member FACTS only: the count, the positions, the cap and the team size are all read from the catalogue, and trg_registration_members_cap refuses an over-cap roster whatever this function is asked to do. Refused once the selection is frozen or the payment is verified.';

grant  execute on function public.registration_set_team_members(uuid, text, jsonb) to authenticated;
revoke execute on function public.registration_set_team_members(uuid, text, jsonb) from anon, public;


-- ---------------------------------------------------------------------------
-- 6. who may read a teammate
-- ---------------------------------------------------------------------------
-- The same three-way split as registrations and registration_events: a
-- participant owns their own team, staff read every team, anon gets nothing.
--
-- DELIBERATELY NOT GRANTED: a participant may not INSERT here directly, even
-- though the cap trigger would stop an over-cap roster. They reach the table
-- through registration_set_team_members, which is the only path that validates
-- the fields, rejects a duplicate teammate, and refuses a roster on a purchase
-- that has no team. Granting the table would make all three of those a
-- suggestion - the exact mistake ...011's comment and ...016's cap call out.
--
-- The policy is therefore READ-ONLY for a participant. That is also why the
-- function is SECURITY DEFINER: the writes it performs are not ones the
-- authenticated role holds a grant for.

alter table public.registration_members enable row level security;

drop policy if exists staff_read_registration_members on public.registration_members;
create policy staff_read_registration_members
  on public.registration_members
  for select
  to anon
  using ((select public.staff_at_least('coordinator')));

drop policy if exists participant_read_own_members on public.registration_members;
create policy participant_read_own_members
  on public.registration_members
  for select
  to authenticated
  using (
    exists (
      select 1 from public.registrations r
       where r.id = registration_id
         and r.user_id = auth.uid()
    )
  );

-- RLS narrows, it does not grant: without the table privilege these policies are
-- never reached. Staff get SELECT only, the same shape as
-- registration_events - they call staff_delete_registration or the event
-- roster RPC, they do not hand-write members.
revoke all on public.registration_members from anon, authenticated;
grant select on public.registration_members to anon, authenticated;


-- ---------------------------------------------------------------------------
-- 7. the operator's read
-- ---------------------------------------------------------------------------
-- A team is only useful at the venue if the whole thing is on one screen. This
-- is the single definition of "a team", used by the console's roster drilldown
-- and by the participant API in ...030 - so an operator and a partner site
-- cannot be looking at two different lists of the same squad.
--
-- SECURITY DEFINER for the same reason event_registered_count is: a participant
-- can read their own rows under RLS but not the whole table, and a count that
-- silently returned only "mine" would look correct while being wrong.

create or replace function public.registration_team (p_registration_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'team_name', r.team_name,
    'max_team_members', public.registration_team_cap(r.id),
    -- The leader is the registration row. Stated as data rather than implied,
    -- because every consumer needs to know that "2 people" is one member row
    -- plus this one.
    'leader', jsonb_build_object(
      'name', r.name, 'roll_number', r.roll_number,
      'email', r.email, 'phone_number', r.phone_number,
      'college', r.college_name, 'department', r.department, 'year', r.year),
    'members', coalesce((
      select jsonb_agg(jsonb_build_object(
               'name', m.name, 'roll_number', m.roll_number,
               'email', m.email, 'phone_number', m.phone_number,
               'college', m.college_name, 'department', m.department,
               'year', m.year)
             order by m.position)
        from public.registration_members m
       where m.registration_id = r.id), '[]'::jsonb),
    'size', 1 + (select count(*) from public.registration_members m
                   where m.registration_id = r.id))
    from public.registrations r
   where r.id = p_registration_id;
$$;

comment on function public.registration_team(uuid) is
  'One team as one object: its name, its cap, its leader (the registration itself) and its members in the order they were entered. The single definition the operations console and the participant API both read, so the two cannot disagree about who is on a squad.';

revoke execute on function public.registration_team(uuid) from public;
grant  execute on function public.registration_team(uuid) to anon, authenticated;


-- ---------------------------------------------------------------------------
-- 8. the per-event roster, now with the team on it
-- ---------------------------------------------------------------------------
-- staff_list_event_registrations (...024) is the drilldown behind "who is in
-- this room", and it is where a team is first actually needed. It gains the
-- team name and its size, so an operator reads "FREE FIRE - 3 of 4" without
-- opening anything. The members themselves are behind registration_team(id) on
-- the row, because listing five people inside every row of a roster page turns
-- a scannable list into an unreadable one.

create or replace function public.staff_list_event_registrations (p_event_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_title   text;
  v_count   int;
  v_cap     int;
  v_people  int;
begin
  if not public.staff_at_least('coordinator') then
    return jsonb_build_object('ok', false, 'error', 'Not authorised.');
  end if;

  select ec.title, ec.max_registrations into v_title, v_cap
    from public.event_catalogue ec where ec.id = p_event_id;

  if v_title is null then
    return jsonb_build_object('ok', false, 'error', 'No such event.');
  end if;

  v_count  := public.event_registered_count(p_event_id);
  v_people := (select count(distinct r.id)
                 from public.registration_events re
                 join public.registrations r on r.id = re.registration_id
                where re.event_id = p_event_id);

  return jsonb_build_object(
    'ok', true,
    'event_id', p_event_id,
    'title', v_title,
    'registered', v_count,
    'people', v_people,
    'cap', v_cap,
    'full', (v_cap is not null and v_count >= v_cap),
    -- Null when no cap is set, which reads as "no limit" rather than as zero
    -- seats left. Showing 0 for an uncapped event says the opposite of the truth.
    'seats_left', (case when v_cap is null then null else greatest(v_cap - v_count, 0) end),
    'rows', coalesce((
      select jsonb_agg(to_jsonb(s) order by s.created_at)
        from (
          select r.id, r.name, r.email, r.phone_number, r.college_name,
                 r.roll_number, r.purchase_label, r.purchase_type,
                 r.purchase_ref, r.purchase_amount, r.payment_status,
                 r.payment_method, r.team_name,
                 -- "3 people" INCLUDING the leader, which is what a cap counts.
                 -- Reported as people rather than rows so an operator is not
                 -- told a squad of four is a squad of three.
                 1 + (select count(*)::int
                        from public.registration_members m
                       where m.registration_id = r.id) as team_size,
                 public.registration_team_cap(r.id) as max_team_members,
                 r.utr_number, r.created_at
            from public.registration_events re
            join public.registrations r on r.id = re.registration_id
           where re.event_id = p_event_id
             and (r.payment_status is null or r.payment_status <> 'rejected')
        ) s), '[]'::jsonb)
  );
end;
$$;

comment on function public.staff_list_event_registrations(text) is
  'Coordinator+. The people behind an event''s registration count, with what each paid, how it is being paid, and their team size against the team cap. Same count as event_registered_count(), broken down - a person holding both a bundle seat and a direct entry appears once per purchase, which is why rows can exceed the distinct people count. The members themselves are read per registration through registration_team(id), so this list stays scannable.';


-- =============================================================================
-- NEXUS - mail: templates, a queue, and the trigger that fires on verify
-- Migration : 20260927000039_mail_queue.sql
-- Purpose   : Let the operations team write a template with merge fields, send it
--             to a filtered slice of the roster, and have a verify send one
--             automatically - all asynchronously, with backoff, a TTL, and a
--             record of what was actually delivered.
--
-- WHY A QUEUE IN THE DATABASE AND NOT AN HTTP CALL IN A TRIGGER
--
-- pg_net is not available on this project (the same constraint that
-- api/push-registrations.js documents). And even where it is, calling an email
-- provider from a trigger means the transaction that verifies a payment blocks
-- on a third party's response: a slow provider stalls the operator's Confirm
-- button, and a provider outage rolls back a payment verification that actually
-- succeeded. So the trigger ENQUEUES and returns, and a separate worker drains
-- the queue. The two concerns are independent and the second one may fail
-- without touching the first.
--
-- WHY THE QUEUE IS CLAIMED WITH SKIP LOCKED
--
-- Two senders running at once must not send the same message twice. SKIP LOCKED
-- takes rows nobody else holds and leaves the rest, so several workers scale
-- without coordination and no lock is held across the HTTP call - the claim is a
-- short transaction, the send is not, and the lease is a TIMESTAMP rather than a
-- lock, so a worker that dies mid-send does not hold a row hostage.
--
-- WHY BACKOFF IS RANDOM
--
-- A provider rate limit fails a whole batch at once, so retrying it in lockstep
-- fails again at the same moment. Jitter spreads the retries, and because
-- next_attempt_at is computed in SQL each attempt, two jobs that failed together
-- come back at genuinely different times.
--
-- WHY TTL AND A LEASE ARE SEPARATE
--
-- They answer different questions. The LEASE (locked_at) is "how long may I
-- believe this worker is still trying" - a crashed worker's job comes back. The
-- TTL (expires_at) is "how long is this message still worth sending at all" - an
-- update sent eleven days late is worse than not sent, because the person has
-- moved on. One is an operational timeout, one is editorial.
--
-- WHY THE API KEY IS NOT IN THIS SCHEMA
--
-- Because a key in a table is a key in a backup, a dump and a replica. The
-- sending function reads RESEND_API_KEY from the server environment, exactly as
-- api/config.js reads the Supabase keys, and nothing here can return it.
--
-- Idempotent: drop-if-exists, create-or-replace, if-not-exists.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. templates
-- ---------------------------------------------------------------------------
-- The body is TEXT with {{placeholders}}, not HTML: what an operator writes is
-- what a participant is shown, and the renderer escapes the values it substitutes.
-- That is the opposite of a newsletter editor, and deliberately so - an operator
-- with a typo cannot turn one participant's name into a link for everybody.

create table if not exists public.email_templates (
  id            uuid        primary key default gen_random_uuid(),
  name          text        not null,
  subject       text        not null default '',
  body          text        not null default '',
  -- The one the "verified" trigger uses. Partial unique index below means there
  -- is never more than one, which is what lets the trigger look it up without
  -- choosing between two.
  is_default    boolean     not null default false,
  is_active     boolean     not null default true,
  created_by    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint chk_email_templates_name check (char_length(btrim(name)) between 2 and 80)
);

create unique index if not exists uq_email_templates_default
  on public.email_templates ((true))
  where is_default;

create index if not exists ix_email_templates_active
  on public.email_templates (name)
  where is_active;

comment on table public.email_templates is
  'Reusable message bodies written by the operations team. Placeholders are {{name}}, {{email}}, {{event_title}} and friends - see public.email_merge_fields(). Text, not HTML: the renderer escapes every substituted value, so what an operator types is what a participant reads.';
-- ---------------------------------------------------------------------------
-- 2. campaigns: a bulk send, recorded before any of it is queued
-- ---------------------------------------------------------------------------
-- The filters are stored as jsonb rather than as columns so a filter nobody
-- thinks of yet does not need a migration - and so the log can say afterwards
-- WHO a message went to, which is the question an ops lead asks when somebody
-- says they never got it.

create table if not exists public.email_campaigns (
  id            uuid        primary key default gen_random_uuid(),
  name          text        not null,
  template_id   uuid        references public.email_templates (id) on delete set null,
  subject       text        not null default '',
  body          text        not null default '',
  filters       jsonb       not null default '{}'::jsonb,
  recipients    integer     not null default 0,
  status        text        not null default 'queued',
  created_by    text,
  created_at    timestamptz not null default now(),
  constraint chk_email_campaigns_status check (status in ('queued','sent','failed'))
);

comment on table public.email_campaigns is
  'One bulk send. The filter that selected the recipients is KEPT, so the log can answer "who did this actually go to" months later - the roster changes, and a filter re-run tomorrow is a different population.';

create index if not exists ix_email_campaigns_created
  on public.email_campaigns (created_at desc);
-- ---------------------------------------------------------------------------
-- 3. the queue
-- ---------------------------------------------------------------------------
-- One row is one message to one address. That grain is what makes the log
-- trustworthy: a per-campaign row cannot say which of five hundred recipients
-- bounced.

create table if not exists public.email_jobs (
  id                  uuid        primary key default gen_random_uuid(),
  campaign_id         uuid        references public.email_campaigns (id) on delete set null,
  registration_id     uuid        references public.registrations (id) on delete cascade,
  to_email            text        not null,
  to_name             text        not null default '',
  subject             text        not null default '',
  body                text        not null default '',
  -- Snapshot, because a template edited tomorrow must not rewrite the message a
  -- participant was sent last week.
  template_id         uuid,
  status              text        not null default 'queued',
  attempts            integer     not null default 0,
  max_attempts        integer     not null default 5,
  next_attempt_at     timestamptz not null default now(),
  locked_at           timestamptz,
  locked_by           text,
  provider_message_id text,
  last_error          text,
  sent_at             timestamptz,
  -- TTL: when this message stops being worth sending at all. Distinct from the
  -- lease above, which is about a dead worker, not a stale message.
  expires_at          timestamptz,
  created_at          timestamptz not null default now(),
  -- The provider accepts the same request twice if we retry after a timeout it
  -- already answered. This is the guard: the same intent enqueued twice is one
  -- message. Built from the registration and the campaign rather than a random
  -- id, so it is stable across retries AND across a re-run of the same send.
  idempotency_key     text        not null,
  constraint chk_email_jobs_status
    check (status in ('queued','sending','sent','failed','expired','suppressed')),
  constraint chk_email_jobs_attempts check (attempts >= 0 and max_attempts >= 1)
);

create unique index if not exists uq_email_jobs_idempotency
  on public.email_jobs (idempotency_key);

-- The claim query's index. SKIP LOCKED walks this, and an index without the
-- status leading would have it scan every message ever sent.
create index if not exists ix_email_jobs_claim
  on public.email_jobs (next_attempt_at)
  where status in ('queued', 'sending');

create index if not exists ix_email_jobs_registration
  on public.email_jobs (registration_id)
  where registration_id is not null;

create index if not exists ix_email_jobs_campaign
  on public.email_jobs (campaign_id)
  where campaign_id is not null;

comment on table public.email_jobs is
  'The send queue. One row per message per recipient. Claimed with FOR UPDATE SKIP LOCKED by whichever sender is free, held by a LEASE (locked_at) rather than a lock, retried on next_attempt_at with jittered backoff, given up at max_attempts, and dropped at expires_at because a message that arrives eleven days late is worse than one that never arrives.';
-- ---------------------------------------------------------------------------
-- 4. merge fields, rendered from the registration
-- ---------------------------------------------------------------------------
-- The list the console offers an operator, derived rather than written down, so
-- the picker and the renderer cannot offer different fields. It reads the same
-- registration row the message will be built from.

create or replace function public.email_merge_fields ()
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_array(
    jsonb_build_object('key', 'name',          'label', 'Full name'),
    jsonb_build_object('key', 'email',         'label', 'Email'),
    jsonb_build_object('key', 'roll_number',   'label', 'Roll number'),
    jsonb_build_object('key', 'college_name',  'label', 'College'),
    jsonb_build_object('key', 'department',    'label', 'Department'),
    jsonb_build_object('key', 'year',          'label', 'Year'),
    jsonb_build_object('key', 'phone_number',  'label', 'Phone'),
    jsonb_build_object('key', 'team_name',     'label', 'Team name'),
    jsonb_build_object('key', 'event_id',      'label', 'Event ID'),
    jsonb_build_object('key', 'purchase_label','label', 'What they bought'),
    jsonb_build_object('key', 'payment_status','label', 'Payment status'),
    jsonb_build_object('key', 'utr_number',    'label', 'UTR reference'),
    jsonb_build_object('key', 'registration_id', 'label', 'Registration ID')
  );
$$;

comment on function public.email_merge_fields() is
  'The {{placeholders}} an operator may use in a template. Derived from the registration row the message is built from, so the picker in the console and the renderer can never offer different fields.';

-- Renders a template against ONE registration.
--
-- SECURITY DEFINER with a fixed search_path because it reads registrations, and
-- the caller may not: this is called by a trigger and by staff RPCs, neither of
-- which has a participant session.
--
-- An unknown {{placeholder}} is left ALONE rather than blanked. Silently
-- emptying it would let an operator send 400 messages saying "Dear ," and only
-- notice afterwards; the placeholder is visible, wrong, and greppable.
create or replace function public.render_email (
  p_template  text,
  p_registration_id uuid,
  p_fallback_name text default '',
  p_fallback_email text default '',
  p_subject   text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_reg  public.registrations%rowtype;
  v_body text;
  v_subj text;
  v_vals jsonb;
  -- Declared: an undeclared name in a FOR target is not a compile error in
  -- plpgsql, it is a runtime one, and the loop never runs - which is how a
  -- template can render with every {{placeholder}} still in it.
  v_key  text;
begin
  select * into v_reg from public.registrations r where r.id = p_registration_id;

  v_vals := jsonb_build_object(
    'name',           coalesce(v_reg.name, p_fallback_name, ''),
    'email',          coalesce(v_reg.email, p_fallback_email, ''),
    'roll_number',    coalesce(v_reg.roll_number, ''),
    'college_name',   coalesce(v_reg.college_name, ''),
    'department',     coalesce(v_reg.department, ''),
    'year',           coalesce(v_reg.year, ''),
    'phone_number',   coalesce(v_reg.phone_number, ''),
    'team_name',      coalesce(v_reg.team_name, ''),
    'event_id',       coalesce(v_reg.event_id_value, v_reg.free_fire_id, ''),
    'purchase_label', coalesce(v_reg.purchase_label, ''),
    'payment_status', coalesce(v_reg.payment_status::text, ''),
    'utr_number',     coalesce(v_reg.utr_number, ''),
    'registration_id', coalesce(v_reg.id::text, '')
  );

  -- The SUBJECT is rendered too. It used to be assigned p_template and never
  -- returned, so a subject containing {{name}} would have gone out with the
  -- braces literally in it - visible to every recipient in their inbox subject
  -- line, which is the least recoverable place a template mistake can land.
  v_body := coalesce(p_template, '');
  v_subj := coalesce(p_subject, '');
  for v_key in select jsonb_object_keys(v_vals) loop
    v_body := replace(v_body, '{{' || v_key || '}}', coalesce(v_vals ->> v_key, ''));
    v_subj := replace(v_subj, '{{' || v_key || '}}', coalesce(v_vals ->> v_key, ''));
  end loop;

  return jsonb_build_object('body', v_body, 'subject', v_subj, 'values', v_vals);
end;
$$;

comment on function public.render_email(text, uuid, text, text, text) is
  'Substitutes {{placeholders}} in a template body AND subject from one registration. An unknown placeholder is LEFT AS-IS on purpose: blanking it would let an operator send four hundred messages beginning "Dear ," and only notice afterwards. The fallback name and email are for desk registrations, which have no row to read.';

revoke execute on function public.render_email(text, uuid, text, text, text) from public;
-- ---------------------------------------------------------------------------
-- 5. enqueue
-- ---------------------------------------------------------------------------
-- One function for both the trigger and a bulk send, so the automatic message
-- and the operator's message cannot be built differently. The idempotency key
-- makes a re-run safe: sending the same campaign twice, or a trigger that fires
-- twice, produces one row.
--
-- 'verify:' + <template> + <registration> is stable by construction. A campaign
-- key includes the campaign id, so two different campaigns may each send one
-- message to the same person - which is the operator's decision to make, not
-- something a unique index should quietly prevent.

create or replace function public.email_enqueue (
  p_registration_id uuid,
  p_to_email       text,
  p_to_name        text,
  p_subject        text,
  p_body           text,
  p_template_id    uuid default null,
  p_campaign_id    uuid default null,
  p_key            text default null,
  p_ttl_hours      integer default 72
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key  text := coalesce(
                 p_key,
                 'auto:' || coalesce(p_template_id::text, 'x') || ':' || p_registration_id::text
               );
begin
  insert into public.email_jobs
    (campaign_id, registration_id, to_email, to_name, subject, body,
     template_id, idempotency_key, expires_at, status)
  values
    (p_campaign_id, p_registration_id, lower(btrim(p_to_email)),
     coalesce(btrim(p_to_name), ''),
     coalesce(p_subject, ''), coalesce(p_body, ''),
     p_template_id, v_key,
     now() + make_interval(hours => greatest(coalesce(p_ttl_hours, 72), 1)),
     'queued')
  on conflict (idempotency_key) do nothing
  returning id into v_key;

  -- ON CONFLICT DO NOTHING leaves returning empty, so v_key is null: the message
  -- was already queued. That is SUCCESS, not an error - it is what makes a
  -- double trigger firing harmless.
  return nullif(v_key, '')::uuid;
end;
$$;

comment on function public.email_enqueue(uuid, text, text, text, text, uuid, uuid, text, integer) is
  'Queues one message. Returns the job id, or NULL when an identical message is already queued - which is the SUCCESS path for a re-run, and the reason a trigger that fires twice sends one email rather than two.';

revoke execute on function public.email_enqueue(uuid, text, text, text, text, uuid, uuid, text, integer) from public;

-- ---------------------------------------------------------------------------
-- 6. the trigger: a verify queues a message
-- ---------------------------------------------------------------------------
-- AFTER UPDATE OF payment_status, and only when the row CROSSES INTO verified
-- (old is not verified and new is). A trigger on every update would re-queue on
-- any later touch of the row - and `is distinct from` on the pair is what makes
-- "crossed into" expressible at all.

create or replace function public.email_on_verified ()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tpl public.email_templates%rowtype;
  v_rnd jsonb;
  v_job uuid;
begin
  if new.payment_status is not distinct from 'verified'
     and old.payment_status is distinct from 'verified' then

    select * into v_tpl from public.email_templates t
     where t.is_default and t.is_active;
    if not found then
      return null;   -- nothing configured; a verify must never fail because of mail
    end if;

    -- Rendered in the trigger so the QUEUE holds the finished text. A template
    -- edited tomorrow must not rewrite the message this participant receives, and
    -- the SUBJECT is rendered for the same reason - an unrendered {{name}} in a
    -- subject line is the one template mistake every recipient sees.
    v_rnd := public.render_email(v_tpl.body, new.id, '', '', v_tpl.subject);
    v_job := public.email_enqueue(
      new.id,
      new.email,
      coalesce(new.name, ''),
      v_rnd ->> 'subject',
      v_rnd ->> 'body',
      v_tpl.id,
      null,
      'verify:' || v_tpl.id::text || ':' || new.id::text,
      72
    );

    raise notice 'verified: queued email for % (job %)',
      coalesce(new.email, '?'), coalesce(v_job::text, 'already queued');
  end if;

  return null;
end;
$$;

comment on function public.email_on_verified() is
  'AFTER UPDATE OF payment_status on registrations, when a row CROSSES INTO verified. Enqueues the default template, rendered at that moment, and RETURNS SILENTLY if no template is configured - a verify must never fail because mail is not set up. It queues rather than sends: pg_net is unavailable on this project and a provider stall must not roll back a payment that genuinely succeeded.';

drop trigger if exists trg_registrations_email_verified on public.registrations;

create trigger trg_registrations_email_verified
  after update of payment_status on public.registrations
  for each row
  execute function public.email_on_verified ();
-- ---------------------------------------------------------------------------
-- 7. claiming work
-- ---------------------------------------------------------------------------
-- FOR UPDATE SKIP LOCKED, inside a short transaction that ends before any HTTP
-- call. A lease rather than a lock: a worker that dies holding a row must not
-- hold it forever, so the row comes back when locked_at falls outside the lease.
--
-- EXPIRED is applied in the WHERE clause, not afterwards, so a due message that
-- is past its TTL is never handed out at all - the sender does not have to know
-- the rule exists.
--
-- 'suppressed' is for an address that must never be mailed: an operator opting
-- somebody out. It is a status rather than a delete so the log still shows the
-- decision, and the trigger above checks it before enqueueing.

create or replace function public.claim_email_jobs (
  p_worker  text,
  p_limit   integer default 10,
  p_lease_seconds integer default 120
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ids uuid[] := '{}';
  v_out jsonb := '[]'::jsonb;
begin
  if not public.staff_at_least('coordinator') then
    return jsonb_build_object('ok', false, 'error', 'Not authorised.');
  end if;

  -- TWO statements, not one CTE-in-a-parenthesis. The single-statement form
  -- (`coalesce((with due as (...) update ... returning ...), '[]')`) does not
  -- parse, and the two-step form is readable besides: pick the ids, then update
  -- exactly those. The SELECT holds FOR UPDATE SKIP LOCKED, so the ids are still
  -- locked when the UPDATE runs in the same transaction.
  select coalesce(array_agg(d.id), '{}'::uuid[])
    into v_ids
    from (
      select j.id
        from public.email_jobs j
       where j.status in ('queued', 'sending')
         and j.next_attempt_at <= now()
         and (j.locked_at is null
              or j.locked_at < now() - make_interval(secs => greatest(coalesce(p_lease_seconds, 120), 10)))
         and (j.expires_at is null or j.expires_at > now())
       order by j.next_attempt_at, j.created_at
       limit greatest(coalesce(p_limit, 10), 1)
       -- SKIP LOCKED is what lets several senders run at once. Plain FOR UPDATE
       -- would make them queue behind each other on the same first row, which is
       -- a mutex with extra steps.
       for update skip locked
    ) d;

  -- A data-modifying CTE, which IS valid as a statement in its own right. The two
  -- shapes this replaced both fail to parse: a CTE inside parentheses inside
  -- coalesce(...), and an UPDATE in a FROM subquery. The SELECT above already
  -- took FOR UPDATE SKIP LOCKED, so these ids are locked and this UPDATE hits
  -- exactly them.
  with claimed as (
    update public.email_jobs e
       set status    = 'sending',
           locked_at = now(),
           locked_by = p_worker,
           attempts  = e.attempts + 1
     where e.id = any (v_ids)
     returning e.*
  )
  select coalesce(
           jsonb_agg(to_jsonb(c) - 'locked_at' - 'locked_by' - 'expires_at'
                               - 'created_at' - 'idempotency_key' - 'status'),
           '[]'::jsonb
         )
    into v_out
    from claimed c;

  -- `status` is stripped above and restated here: the worker needs to know it is
  -- SENDING, and having it say so twice in different words invites a bug.
  return jsonb_build_object(
    'ok', true,
    'claimed', coalesce((
      select jsonb_agg(c || jsonb_build_object('status', 'sending'))
        from jsonb_array_elements(v_out) c
    ), '[]'::jsonb)
  );
end;
$$;

comment on function public.claim_email_jobs(text, integer, integer) is
  'Hands a worker up to p_limit due messages and marks them sending. SKIP LOCKED so concurrent workers never take the same row, a LEASE rather than a lock so a crashed worker cannot hold one, and the TTL filter inside the WHERE so an overdue message is never handed out at all.';

revoke execute on function public.claim_email_jobs(text, integer, integer) from public;
grant  execute on function public.claim_email_jobs(text, integer, integer) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 8. reporting back: sent, failed, retried
-- ---------------------------------------------------------------------------
-- THE BACKOFF, and the reason it is computed here rather than in the sender:
-- the sender has a clock, the database has the history. Two workers retrying the
-- same provider error at the same moment is exactly what a rate limit punishes,
-- so the delay is jittered per attempt, here, where the attempt count lives.
--
--   attempt 1 -> ~1 min      attempt 4 -> ~9 min
--   attempt 2 -> ~2 min      attempt 5 -> ~18 min (capped)
--
-- random() is used rather than a fixed ladder for the same reason. A fixed
-- ladder keeps every message that failed together in lockstep and they all fail
-- together again.

create or replace function public.complete_email_job (
  p_job_id   uuid,
  p_ok       boolean,
  p_error    text default null,
  p_provider_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.email_jobs%rowtype;
  v_dead boolean;
begin
  if not public.staff_at_least('coordinator') then
    return jsonb_build_object('ok', false, 'error', 'Not authorised.');
  end if;

  select * into v_job from public.email_jobs j where j.id = p_job_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'No such job.');
  end if;

  if p_ok then
    update public.email_jobs
       set status = 'sent', sent_at = now(), locked_at = null, locked_by = null,
           provider_message_id = coalesce(p_provider_id, provider_message_id),
           last_error = null
     where id = p_job_id;
    return jsonb_build_object('ok', true, 'status', 'sent');
  end if;

  -- Out of attempts, or past its TTL: give up rather than retry a message that
  -- would arrive too late to matter.
  v_dead := v_job.attempts >= v_job.max_attempts
            or (v_job.expires_at is not null and v_job.expires_at <= now());

  if v_dead then
    update public.email_jobs
       set status = case when v_job.expires_at is not null and v_job.expires_at <= now()
                         then 'expired' else 'failed' end,
           locked_at = null, locked_by = null,
           last_error = left(coalesce(p_error, 'unknown error'), 500)
     where id = p_job_id;
    return jsonb_build_object('ok', true, 'status', 'failed');
  end if;

  update public.email_jobs
     set status = 'queued',
         locked_at = null,
         locked_by = null,
         last_error = left(coalesce(p_error, 'unknown error'), 500),
         -- Exponential, capped at ~30 minutes, then jittered by up to half again.
         next_attempt_at = now()
           + make_interval(secs => least(300, 30 * power(2, v_job.attempts - 1)))
             * (0.5 + random() / 2.0)
   where id = p_job_id;

  return jsonb_build_object('ok', true, 'status', 'queued', 'attempt', v_job.attempts);
end;
$$;

comment on function public.complete_email_job(uuid, boolean, text, text) is
  'Records the outcome of one send. On failure the job returns to the queue with EXPONENTIAL, JITTERED backoff (30s doubling to a 5-minute ceiling, plus up to half again of randomness) - jitter because a provider rate limit fails a whole batch at once and a fixed ladder retries them all at the same instant and fails again. Gives up at max_attempts, or at the TTL, where the status becomes expired rather than retried: a message eleven days late is worse than none.';

revoke execute on function public.complete_email_job(uuid, boolean, text, text) from public;
grant  execute on function public.complete_email_job(uuid, boolean, text, text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 9. bulk send, with the filters an operator thinks in
-- ---------------------------------------------------------------------------
-- Event, status and payment method are the three questions an ops lead actually
-- asks: "tell the people who came to the hackathon", "tell the ones we have not
-- verified yet", "tell everybody who paid cash". Each is nullable and they
-- combine with AND, because "unverified cash for FREE FIRE" is a real question.
--
-- Staff MASTER+, and stated as such: this is the function that can put a message
-- in front of every person who ever registered. A coordinator can compose and
-- save a template; sending it to the whole roster is a decision with a blast
-- radius that has no undo once Resend has accepted it.

create or replace function public.staff_send_campaign (
  p_name        text,
  p_template_id uuid,
  p_subject     text,
  p_body        text,
  p_event_id    text default null,
  p_status      text default null,
  p_method      text default null,
  p_college     text default null,
  p_ttl_hours   integer default 72,
  p_confirm     boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_camp uuid;
  v_n    integer := 0;
  v_job  uuid;
  v_rnd  jsonb;
begin
  if not public.staff_at_least('master') then
    return jsonb_build_object('ok', false,
      'error', 'Only a master can send a message to the whole roster.');
  end if;

  if coalesce(p_confirm, false) is not true then
    -- A preview pass: it counts the audience and stops. The console calls this
    -- first so an operator SEES how many people they are about to write to.
    select count(*)::int into v_n
      from public.registrations r
     where nullif(btrim(coalesce(r.email, '')), '') is not null
       and (p_event_id is null or r.purchase_ref = p_event_id)
       and (p_status  is null or r.payment_status::text = p_status)
       and (p_method  is null or r.payment_method = p_method)
       and (p_college is null or lower(btrim(r.college_name)) = lower(btrim(p_college)));

    return jsonb_build_object('ok', true, 'preview', true, 'recipients', v_n);
  end if;

  insert into public.email_campaigns (name, template_id, subject, body, filters, created_by)
  values (coalesce(nullif(btrim(p_name), ''), 'Bulk send'), p_template_id,
          coalesce(p_subject, ''), coalesce(p_body, ''),
          jsonb_build_object('event_id', p_event_id, 'status', p_status,
                             'method', p_method, 'college', p_college),
          (select s.username from public.staff_session() s))
  returning id into v_camp;

  for v_rnd in
    select r.id, r.email, coalesce(r.name, ''), r.event_id_value, r.free_fire_id
      from public.registrations r
     where nullif(btrim(coalesce(r.email, '')), '') is not null
       and (p_event_id is null or r.purchase_ref = p_event_id)
       and (p_status  is null or r.payment_status::text = p_status)
       and (p_method  is null or r.payment_method = p_method)
       and (p_college is null or lower(btrim(r.college_name)) = lower(btrim(p_college)))
  loop
    -- Rendered here, not in the trigger: this is a desk entry too and may have no
    -- row to read, so the merge values are supplied directly.
    v_job := public.email_enqueue(
      v_rnd.id, v_rnd.email, v_rnd.name,
      p_subject,
      replace(replace(coalesce(p_body, ''), '{{name}}', v_rnd.name),
              '{{event_id}}', coalesce(v_rnd.event_id_value, v_rnd.free_fire_id, '')),
      p_template_id, v_camp,
      'campaign:' || v_camp::text || ':' || v_rnd.id::text,
      p_ttl_hours
    );
    if v_job is not null then v_n := v_n + 1; end if;
  end loop;

  update public.email_campaigns
     set recipients = v_n, status = 'sent'
   where id = v_camp;

  perform public.staff_audit(
    'send_campaign', 'email_campaign', v_camp::text,
    jsonb_build_object('recipients', v_n, 'event_id', p_event_id,
                       'status', p_status, 'method', p_method)
  );

  return jsonb_build_object('ok', true, 'campaign_id', v_camp, 'recipients', v_n);
end;
$$;
-- ---------------------------------------------------------------------------
-- 10. template CRUD, and the default seed
-- ---------------------------------------------------------------------------

create or replace function public.staff_upsert_template (p_template jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id   uuid;
  v_name text := coalesce(nullif(btrim(p_template ->> 'name'), ''), '');
begin
  if not public.staff_at_least('coordinator') then
    return jsonb_build_object('ok', false, 'error', 'Not authorised.');
  end if;
  if char_length(v_name) not between 2 and 80 then
    return jsonb_build_object('ok', false, 'error', 'Give the template a name of 2 to 80 characters.');
  end if;

  insert into public.email_templates (id, name, subject, body, is_default, is_active, created_by)
  values (nullif(p_template ->> 'id', '')::uuid, v_name,
          coalesce(p_template ->> 'subject', ''), coalesce(p_template ->> 'body', ''),
          coalesce((p_template ->> 'is_default')::boolean, false),
          coalesce((p_template ->> 'is_active')::boolean, true),
          (select s.username from public.staff_session() s))
  on conflict (id) do update
     set name = excluded.name,
         subject = excluded.subject,
         body = excluded.body,
         is_active = excluded.is_active,
         updated_at = now()
   -- is_default is NOT updated here. The partial unique index allows exactly one
   -- default, and setting a second would raise 23505 mid-save - so promoting a
   -- default is its own deliberate statement below rather than a side effect of
   -- editing a template's text.
  returning id into v_id;

  -- Promoting a default clears the previous one in the SAME statement, or the
  -- unique index would reject the pair.
  if p_template ? 'is_default' and (p_template ->> 'is_default')::boolean then
    update public.email_templates set is_default = false where id <> v_id and is_default;
    update public.email_templates set is_default = true where id = v_id;
  end if;

  return jsonb_build_object('ok', true, 'id', v_id);
end;
$$;

comment on function public.staff_upsert_template(jsonb) is
  'Coordinator+. Creates or edits a template. Promoting one to the DEFAULT is a separate explicit flag and clears the previous default in the same transaction - the partial unique index permits only one, and doing it as a side effect of saving text would fail the save.';

revoke execute on function public.staff_upsert_template(jsonb) from public;
grant  execute on function public.staff_upsert_template(jsonb) to anon, authenticated;

create or replace function public.staff_delete_template (p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.staff_at_least('master') then
    return jsonb_build_object('ok', false, 'error', 'Only a master can delete a template.');
  end if;
  -- The jobs keep their own rendered copy, so deleting a template never changes
  -- what a message already queued will say.
  delete from public.email_templates where id = p_id;
  return jsonb_build_object('ok', true);
end;
$$;

comment on function public.staff_delete_template(uuid) is
  'Master only. Removes a template. Messages already QUEUED keep their own rendered text, so deleting a template never rewrites what somebody is about to receive - which is why email_jobs stores the body rather than a template id alone.';

revoke execute on function public.staff_delete_template(uuid) from public;
grant  execute on function public.staff_delete_template(uuid) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 11. RLS
-- ---------------------------------------------------------------------------
-- Nobody reads the queue from the browser. It holds every address on the roster
-- and every failure message, and the staff console goes through the RPCs above -
-- which are gated on a staff session and can be narrowed to the fields a
-- particular screen needs.

alter table public.email_templates  enable row level security;
alter table public.email_campaigns enable row level security;
alter table public.email_jobs      enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where policyname = 'staff_read_email_templates'
                   and tablename = 'email_templates') then
    create policy staff_read_email_templates on public.email_templates
      for select to anon using ((select public.staff_at_least('coordinator')));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'staff_read_email_campaigns'
                   and tablename = 'email_campaigns') then
    create policy staff_read_email_campaigns on public.email_campaigns
      for select to anon using ((select public.staff_at_least('coordinator')));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'staff_read_email_jobs'
                   and tablename = 'email_jobs') then
    create policy staff_read_email_jobs on public.email_jobs
      for select to anon using ((select public.staff_at_least('coordinator')));
  end if;
end;
$$;

-- No INSERT/UPDATE/DELETE policy: the queue is written only by the trigger and
-- the RPCs above. A browser cannot queue itself a message to anybody.

-- ---------------------------------------------------------------------------
-- 12. what the console reads
-- ---------------------------------------------------------------------------
-- One call, because the mail tab needs the templates, the campaigns, the recent
-- jobs AND the merge-field list, and four round trips on a tab an operator opens
-- during a shift is four chances to render half-populated.

create or replace function public.staff_mail_state (p_limit integer default 50)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'ok', true,
    'fields', public.email_merge_fields(),
    'templates', coalesce((
      select jsonb_agg(to_jsonb(t) order by t.is_default desc, t.name)
        from public.email_templates t where t.is_active
    ), '[]'::jsonb),
    -- A subquery around each aggregate, because jsonb_agg() takes an ORDER BY but
    -- NOT a LIMIT: `jsonb_agg(x order by y limit n)` is a syntax error. Selecting
    -- the newest rows first and aggregating that is the same thing and parses.
    'campaigns', coalesce((
      select jsonb_agg(to_jsonb(c))
        from (select * from public.email_campaigns c order by c.created_at desc limit 20) c
    ), '[]'::jsonb),
    'jobs', coalesce((
      select jsonb_agg(to_jsonb(j))
        from (
          select * from public.email_jobs j
           order by j.created_at desc limit greatest(coalesce(p_limit, 50), 1)
        ) j
    ), '[]'::jsonb),
    'counts', jsonb_build_object(
      'queued',   (select count(*) from public.email_jobs where status = 'queued'),
      'sending',  (select count(*) from public.email_jobs where status = 'sending'),
      'sent',     (select count(*) from public.email_jobs where status = 'sent'),
      'failed',   (select count(*) from public.email_jobs where status in ('failed','expired'))
    )
  );
$$;

revoke execute on function public.staff_mail_state(integer) from public;
grant  execute on function public.staff_mail_state(integer) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 13. the coordinator gate, enforced inside the function
-- ---------------------------------------------------------------------------
-- staff_mail_state is SECURITY DEFINER and was granted to `anon` + `authenticated`
-- because that is how every staff RPC is reached over PostgREST (the caller
-- proves itself with the X-Nexus-Staff-Token header, not with a JWT role). But a
-- role check that lives ONLY in the browser is a courtesy: removing the Mail tab
-- from the UI changes nothing an attacker could do, because anyone holding the
-- anon key can call this function directly and read every template, every
-- rendered subject and body, and every recipient email address on the queue.
--
-- The gate therefore goes INSIDE, first statement, using the same
-- staff_at_least('coordinator') predicate every policy already calls. It resolves
-- the header to a live session row on each request, so expiry, revocation and
-- deactivation take effect immediately rather than at deploy time.

create or replace function public.staff_mail_state (p_limit integer default 50)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  -- THE gate. Not optional, and first, so an anonymous caller is refused before
  -- a single template body is assembled.
  if not (select public.staff_at_least('coordinator')) then
    return jsonb_build_object('ok', false, 'error', 'Not authorised.');
  end if;

  return (
    select jsonb_build_object(
      'ok', true,
      'fields', public.email_merge_fields(),
      'templates', coalesce((
        select jsonb_agg(to_jsonb(t) order by t.is_default desc, t.name)
          from public.email_templates t where t.is_active
      ), '[]'::jsonb),
      -- A subquery around each aggregate, because jsonb_agg() takes an ORDER BY
      -- but NOT a LIMIT: `jsonb_agg(x order by y limit n)` is a syntax error.
      -- Selecting the newest rows first and aggregating that is the same thing.
      'campaigns', coalesce((
        select jsonb_agg(to_jsonb(c))
          from (select * from public.email_campaigns c order by c.created_at desc limit 20) c
      ), '[]'::jsonb),
      'jobs', coalesce((
        select jsonb_agg(to_jsonb(j))
          from (
            select * from public.email_jobs j
             order by j.created_at desc limit greatest(coalesce(p_limit, 50), 1)
          ) j
      ), '[]'::jsonb),
      'counts', jsonb_build_object(
        'queued',   (select count(*) from public.email_jobs where status = 'queued'),
        'sending',  (select count(*) from public.email_jobs where status = 'sending'),
        'sent',     (select count(*) from public.email_jobs where status = 'sent'),
        'failed',   (select count(*) from public.email_jobs where status in ('failed','expired'))
      )
    )
  );
end;
$$;

comment on function public.staff_mail_state(integer) is
  'Coordinator+, enforced inside the function. One call for the whole mail tab: the merge fields an operator may use, the active templates, recent campaigns, recent jobs, and the queue counts. Four round trips on a tab opened mid-shift is four chances to render half-populated. SECURITY DEFINER + a grant to anon is only safe because of the staff_at_least check on the first line.';

-- ---------------------------------------------------------------------------
-- 14. peek_email_jobs - what a dry run needs
-- ---------------------------------------------------------------------------
-- Same predicate as claim_email_jobs, but it UPDATES NOTHING. The sender's
-- dry_run=1 path used to call claim_email_jobs and simply skip complete_email_job,
-- which marked real jobs 'sending' under a 120s lease and never released them:
-- looking at the queue stranded live mail and burned an attempt, so a message
-- could reach max_attempts purely from being inspected. A read-only peek is the
-- only honest answer to "what would go out right now".

create or replace function public.peek_email_jobs (
  p_limit integer default 10
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not (select public.staff_at_least('coordinator')) then
    return jsonb_build_object('ok', false, 'error', 'Not authorised.');
  end if;

  -- `stable`, and no FOR UPDATE, no UPDATE, no lease: this function cannot move a
  -- job even if a caller wants it to. It is what a dry run is allowed to do.
  return jsonb_build_object(
    'ok', true,
    'claimed', coalesce((
      select jsonb_agg(to_jsonb(j))
        from (
          select j.id, j.to_email, j.subject, j.attempts, j.created_at
            from public.email_jobs j
           where j.status in ('queued', 'sending')
             and j.next_attempt_at <= now()
             and (j.locked_at is null
                  or j.locked_at < now() - interval '120 seconds')
             and (j.expires_at is null or j.expires_at > now())
           order by j.next_attempt_at, j.created_at
           limit greatest(coalesce(p_limit, 10), 1)
        ) j
    ), '[]'::jsonb)
  );
end;
$$;

comment on function public.peek_email_jobs(integer) is
  'Read-only preview of the jobs a sender would claim RIGHT NOW. Deliberately stable and mutation-free so /api/send-mail?dry_run=1 cannot strand a job in sending or consume one of its five attempts just by being looked at.';

revoke execute on function public.peek_email_jobs(integer) from public;
grant  execute on function public.peek_email_jobs(integer) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 15. the default template
-- ---------------------------------------------------------------------------
-- Present from day one, so the verify trigger has something to send the moment
-- an operator ticks a row verified rather than silently queueing nothing and
-- looking like the trigger is broken.

insert into public.email_templates (name, subject, body, is_default, is_active, created_by)
values
  ('Payment verified',
   '{{name}} — your NEXUS registration is confirmed',
   E'Hello {{name}},\n\n' ||
   E'Your registration for {{purchase_label}} has been confirmed by the NEXUS team.\n\n' ||
   E'Reference: {{utr_number}}\n' ||
   E'Registration ID: {{registration_id}}\n\n' ||
   E'Keep this email. If anything looks wrong, reply to it quoting the registration ' ||
   E'ID above and the operations team will correct it.\n\n' ||
   E'— The NEXUS team',
   true, true, 'system')
on conflict do nothing;

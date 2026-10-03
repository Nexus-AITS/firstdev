/**
 * Drain the mail queue through Resend.
 *
 *   POST /api/send-mail   X-Nexus-Staff-Token: <the console's staff token>
 *   GET  /api/send-mail?dry_run=1   — claims nothing, sends nothing
 *
 * ── Why this function exists rather than a trigger ───────────────────────────
 * The database cannot make an HTTP request on this project: pg_net is not among
 * its extensions, the same constraint api/push-registrations.js documents. And
 * even where it is, calling a provider from a trigger makes the transaction that
 * verified somebody's payment block on a third party's response — a slow
 * provider would stall the operator's Confirm button, and an outage would roll
 * back a verification that actually succeeded. The trigger ENQUEUES and returns;
 * this drains.
 *
 * ── What the API key is trusted with, and what it is not ─────────────────────
 * It is trusted to DELIVER a message and nothing else. It is not trusted to
 * decide what is in it: the recipient, subject and body all come from
 * public.email_jobs, which the trigger and staff_send_campaign wrote. It is read
 * from the server environment only — never a table, never the browser — because
 * a key in a table is a key in every backup and replica.
 *
 * ── Why it is idempotent ─────────────────────────────────────────────────────
 * Resend accepts an Idempotency-Key, and so does this queue: every job carries
 * one, built from the registration and the campaign. A timeout AFTER Resend has
 * already accepted a message is the case this exists for — retrying blindly would
 * double-send, so the key is passed through and the duplicate is absorbed.
 *
 * ── Why a failure is reported rather than thrown ────────────────────────────
 * The queue is the source of truth. Throwing here would lose the provider's
 * actual error, which is the only thing an operator can act on — "domain not
 * verified" is fixable; "some error" is not.
 */

function readSupabaseUrl() {
  return (process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
}
function readAnonKey() {
  return process.env.SUPABASE_ANON_KEY || "";
}

/** The Resend key and sender. Absent means "cannot send", not "send blank". */
function readResend() {
  return {
    apiKey: (process.env.RESEND_API_KEY || "").trim(),
    from: (process.env.SENDER_EMAIL || "").trim(),
  };
}

/** One call with the console's staff token, so the database does the gating. */
async function callRpc(name, params, staffToken) {
  const supabaseUrl = readSupabaseUrl();
  const anonKey = readAnonKey();
  if (!supabaseUrl || !anonKey) throw new Error("no database connection configured");

  const res = await fetch(`${supabaseUrl}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${anonKey}`,
      // OMITTED, not sent empty, when there is no token. PostgREST would receive
      // the literal string "null" and the staff check would fail on a malformed
      // credential rather than on a missing one, which is a far worse error to
      // read from a log at 3am.
      ...(staffToken ? { "X-Nexus-Staff-Token": staffToken } : {}),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`the database sent an unreadable answer (HTTP ${res.status})`);
  }
  return Array.isArray(parsed) ? parsed[0] : parsed;
}

/**
 * One message, with a HARD timeout.
 *
 * AbortSignal.timeout is the request/response TTL the queue assumes: a provider
 * that never answers must not hold a worker slot forever. 15s sits comfortably
 * inside Resend's own timeout and outside a human's patience for a request.
 */
async function sendOne(job, { apiKey, from }) {
  const started = Date.now();
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      // Absorbs the double-send when this times out AFTER Resend accepted it.
      "Idempotency-Key": job.idempotency_key,
    },
    body: JSON.stringify({
      from,
      to: [job.to_email],
      subject: job.subject,
      text: job.body,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const ms = Date.now() - started;

  if (res.ok) {
    const body = await res.json().catch(() => ({}));
    return { ok: true, providerId: body.id ?? null, ms };
  }

  // The provider's own message. "Domain not verified" and "rate limit" are the
  // two an operator can act on, so they are passed up rather than replaced.
  const text = await res.text().catch(() => "");
  return {
    ok: false,
    ms,
    error: `Resend HTTP ${res.status}: ${text.slice(0, 300)}`,
  };
}

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");

  /* Two callers, two credentials:
     - the console, which proves itself with a staff session token and is gated by
       the database (master-only for anything that queues);
     - the Vercel CRON, which has no user and therefore no staff token. Vercel
       sends `Authorization: Bearer $CRON_SECRET` and nothing else, so without this
       branch the cron would 401 forever and the queue would only ever drain when
       an operator happened to click "Run sender now".
     Both end up calling the SAME RPCs, so the database still does every permission
     check that matters; CRON_SECRET only decides who may wake the sender. It is
     read from the environment here and is never returned or logged. */
  const staffToken = req.headers["x-nexus-staff-token"];
  const cronSecret = process.env.CRON_SECRET || "";
  const auth = req.headers.authorization || "";

  /* Constant-time compare. `===` on two strings stops at the first differing
     character, which leaks the secret one byte at a time to anyone willing to
     measure. The lengths are compared first and the loop still runs over the full
     length, so neither the length nor the position of a wrong character changes
     the time taken. Over a network this is defence in depth rather than a fix for
     an exploitable oracle - but the cost is four lines. */
  const isCron = (() => {
    if (!cronSecret) return false;
    const a = Buffer.from(cronSecret);
    const b = Buffer.from(auth.replace(/^Bearer\s+/i, "").trim());
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
  })();

  if (!staffToken && !isCron) {
    return res.status(401).json({ ok: false, error: "Sign in to the console first." });
  }

  /* claim_email_jobs and complete_email_job require a VALID STAFF SESSION - the
     database refuses them otherwise, deliberately, because they are the two
     functions that move money-equivalent rows. A cron has no session, so it needs
     a durable credential of its own: MAIL_STAFF_TOKEN, the same long-lived master
     token workers/mail-worker.js already uses.
     Known limitation, stated rather than hidden: that token does not expire, so a
     leaked MAIL_STAFF_TOKEN is a standing capability to drain mail. The right fix
     is a second credential checked inside the database (a per-worker secret in a
     table the RPC compares against), which needs migration 040; it is NOT built
     yet. Until then this is the same trust model as the rest of the staff system. */
  const workerToken = staffToken ?? (isCron ? (process.env.MAIL_STAFF_TOKEN || "").trim() : "");
  if (!workerToken) {
    return res.status(503).json({
      ok: false,
      error:
        "MAIL_STAFF_TOKEN is not set on this deployment, so the scheduled sender cannot reach the queue.",
    });
  }

  const dryRun = req.query?.dry_run === "1";
  const limit = Math.min(Number(req.query?.limit) || 10, 50);

  const { apiKey, from } = readResend();
  if (!dryRun && !apiKey) {
    // Refused rather than half-configured: without a key every job would fail,
    // retry five times with backoff, and fill the log with one repeated error.
    return res.status(503).json({
      ok: false,
      error: "RESEND_API_KEY is not set on this deployment, so nothing can be sent.",
    });
  }
  if (!dryRun && !from) {
    return res.status(503).json({
      ok: false,
      error: "SENDER_EMAIL is not set, so there is no verified address to send from.",
    });
  }

  /* ── dry run is READ-ONLY ───────────────────────────────────────────────────
     It must not claim. An earlier version skipped complete_email_job when
     dryRun was set but still called claim_email_jobs, which marked real jobs
     'sending' with a 120s lease and then never released them: a DIAGNOSTIC
     stranded live mail for two minutes and incremented its attempt count, so a
     message could hit max_attempts from being looked at. This path selects the
     jobs it would have claimed and returns them WITHOUT touching a row. */
  if (dryRun) {
    const peek = await callRpc(
      "peek_email_jobs",
      { p_limit: limit },
      workerToken
    ).catch((err) => ({ ok: false, error: String(err?.message ?? err) }));

    if (peek?.ok === false) return res.status(403).json(peek);
    if (!peek?.ok) return res.status(200).json({ ok: true, dryRun: true, claimed: 0, sent: 0, failed: 0, results: [] });

    const jobs = peek.claimed ?? [];
    return res.status(200).json({
      ok: true,
      dryRun: true,
      would_claim: jobs.length,
      claimed: 0,
      sent: 0,
      failed: 0,
      results: jobs.map((j) => ({ id: j.id, to: j.to_email, ok: true, skipped: true, ms: null, error: null })),
    });
  }

  let claim;
  try {
    claim = await callRpc(
      "claim_email_jobs",
      { p_worker: isCron ? "vercel-cron" : "api/send-mail", p_limit: limit, p_lease_seconds: 120 },
      workerToken
    );
  } catch (err) {
    return res.status(502).json({ ok: false, error: String(err?.message ?? err) });
  }

  if (claim?.ok === false) return res.status(403).json(claim);

  const jobs = claim?.claimed ?? [];
  const results = [];

  // Sequential, not parallel: a batch that fires twenty simultaneous requests is
  // how a provider rate limit gets provoked in the first place, and the queue's
  // backoff then has to clean up after it. The parallelism belongs to running
  // several WORKERS, which is what SKIP LOCKED is for.
  for (const job of jobs) {
    let outcome;
    try {
      outcome = await sendOne(job, { apiKey, from });
    } catch (err) {
      // A timeout lands here. The job keeps its lease, so it comes back to
      // whoever claims next, with the attempt already counted.
      outcome = {
        ok: false,
        error: `no response within the timeout: ${String(err?.message ?? err)}`,
      };
    }

    await callRpc(
      "complete_email_job",
      {
        p_job_id: job.id,
        p_ok: outcome.ok,
        p_error: outcome.error ?? null,
        p_provider_id: outcome.providerId ?? null,
      },
      workerToken
    ).catch(() => null);

    results.push({
      id: job.id,
      to: job.to_email,
      ok: outcome.ok,
      ms: outcome.ms ?? null,
      error: outcome.error ?? null,
      skipped: outcome.skipped ?? false,
    });
  }

  return res.status(200).json({
    ok: true,
    dryRun,
    claimed: jobs.length,
    sent: results.filter((r) => r.ok && !r.skipped).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  });
}
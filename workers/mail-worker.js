/**
 * Cloudflare Queues consumer for NEXUS mail.
 *
 *   wrangler deploy
 *   wrangler queues create nexus-mail
 *
 * ── What this is, and what it is NOT ────────────────────────────────────────
 * The QUEUE OF RECORD is Postgres (public.email_jobs), not Cloudflare. That is
 * deliberate and it is the reason this worker is safe:
 *
 *   * The jobs, their templates, their rendered text, their retry count and their
 *     TTL all live in the database, beside the registrations they describe. A
 *     message queue that owns its own copy of the roster is a second source of
 *     truth for "who owes a reply", and this project has been bitten by exactly
 *     that before.
 *   * Backoff is computed in SQL (exponential, jittered) because that is where
 *     the attempt count lives. A queue's own retry policy cannot jitter, so a
 *     provider rate limit retries the whole batch at the same instant.
 *   * Losing this worker loses nothing. The jobs stay queued, their leases expire,
 *     and whichever sender is next picks them up.
 *
 * So the queue here is a TRIGGER, not a store: it means "there is probably work
 * now", so the worker wakes without polling. The correctness lives in
 * claim_email_jobs' SKIP LOCKED, which makes a duplicate delivery harmless —
 * two workers woken by two messages claim two DIFFERENT jobs.
 *
 * ── NOT DEPLOYABLE FROM THIS REPOSITORY ─────────────────────────────────────
 * This file is written and reviewed but NOT deployed: deploying needs a
 * Cloudflare account, a Workers subscription and a Queue binding created in the
 * dashboard. Until then the queue is drained by the Vercel function
 * api/send-mail.js, which speaks the exact same claim/complete protocol and
 * requires nothing but this project's existing deploy. Nothing is lost by not
 * deploying this; it is a latency optimisation, not a capability.
 */

const CLAIM_BATCH = 5;

/** Same RPC helper as api/send-mail.js — the protocol is identical by design. */
async function rpc(env, name, params, staffToken) {
  const res = await fetch(`${env.SUPABASE_URL.replace(/\/+$/, "")}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${env.SUPABASE_ANON_KEY}`,
      "X-Nexus-Staff-Token": staffToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(params),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`unreadable answer from ${name} (HTTP ${res.status})`);
  }
  return Array.isArray(parsed) ? parsed[0] : parsed;
}

async function sendOne(env, job) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
      // The same idempotency key the Vercel sender uses, so whichever worker gets
      // there first, the other is absorbed rather than double-sending.
      "Idempotency-Key": job.idempotency_key,
    },
    body: JSON.stringify({
      from: env.SENDER_EMAIL,
      to: [job.to_email],
      subject: job.subject,
      text: job.body,
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.ok) {
    const body = await res.json().catch(() => ({}));
    return { ok: true, providerId: body.id ?? null };
  }
  return { ok: false, error: `Resend HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}` };
}

export default {
  /**
   * @param {MessageBatch<unknown>} batch
   * @param {Record<string, string>} env
   */
  async queue(batch, env) {
    // The message body is only a nudge. A wrong, empty or duplicated one is fine:
    // the claim decides what is real.
    try {
      const claim = await rpc(
        env,
        "claim_email_jobs",
        {
          p_worker: `cf/${batch.queue}`,
          // Capped per batch rather than per message, so one delivery with fifty
          // notifications cannot open fifty claim rounds.
          p_limit: Math.min(CLAIM_BATCH, batch.messages.length || CLAIM_BATCH),
          p_lease_seconds: 120,
        },
        env.MAIL_STAFF_TOKEN
      );

      if (claim?.ok === false) {
        console.error("claim refused:", claim?.error);
        // requeue:true so the message is retried with the queue's own delay
        // rather than dropped — a transient database error must not lose mail.
        for (const m of batch.messages) m.requeue();
        return;
      }

      const jobs = claim?.claimed ?? [];
      for (const job of jobs) {
        let outcome;
        try {
          outcome = await sendOne(env, job);
        } catch (err) {
          outcome = { ok: false, error: `timeout or transport failure: ${String(err?.message ?? err)}` };
        }

        await rpc(
          env,
          "complete_email_job",
          {
            p_job_id: job.id,
            p_ok: outcome.ok,
            p_error: outcome.error ?? null,
            p_provider_id: outcome.providerId ?? null,
          },
          env.MAIL_STAFF_TOKEN
        ).catch((err) => console.error("complete failed for", job.id, String(err?.message ?? err)));
      }

      console.log(`drained ${jobs.length} of ${batch.messages.length} nudge(s)`);
      for (const m of batch.messages) m.ack();
    } catch (err) {
      // Anything unexpected: requeue rather than ack. The job's lease expires on
      // its own, so even a total worker failure loses nothing — it only delays.
      console.error("queue handler failed:", String(err?.message ?? err));
      for (const m of batch.messages) m.requeue();
    }
  },
};
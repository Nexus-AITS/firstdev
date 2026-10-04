/**
 * The mail queue, over the wire with a real staff session.
 *
 *   node scripts/verify-mail.mjs
 *
 * WHY A LIVE SESSION AND NOT SQL
 *
 * Every function here is staff-gated, and a Management API connection carries no
 * staff session — claim_email_jobs and complete_email_job answer "Not authorised"
 * to it. A SQL probe cannot reach the half of this that matters, which is exactly
 * the half a schema assertion would have "verified".
 *
 * It also cannot reach the TRIGGER's real input: setting payment_status to
 * 'verified' from SQL is refused by trg_registrations_guard_update ("payment
 * verification is an operations-team action") — the guard doing its job. The
 * trigger is therefore exercised the way it happens in production, an operator
 * confirming a row in the console.
 *
 * WHAT IT PROVES
 *   1. confirming a row queues exactly one message;
 *   2. it is RENDERED — no {{placeholder}} survives into the body OR the subject;
 *   3. confirming again does NOT queue a second message (the idempotency key);
 *   4. a sender can CLAIM it, which is what the worker API consumes;
 *   5. a failure comes back with a DELAY, not an instant retry loop;
 *   6. the error is kept for the operator to read.
 *
 * Cleans up after itself whatever happens.
 */
import { readFileSync } from "node:fs";

function loadEnv(path) {
  const out = {};
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}
const env = { ...loadEnv(new URL("../.env", import.meta.url)), ...process.env };
const base = (env.SUPABASE_URL ?? "").replace(/\/+$/, "");
const anon = env.SUPABASE_ANON_KEY;

/* As postgres, for the one thing the anon key cannot do: release a claimed job.
   email_jobs is SELECT-only under RLS by design, so the queue can only be moved
   through claim_email_jobs / complete_email_job. A probe that CLAIMS must be able to
   PUT BACK, and doing that honestly needs the same privilege the migrations run
   with. Without SUPABASE_ACCESS_TOKEN the release step is skipped rather than
   faked, and the probe says so. */
const mgmtToken = env.SUPABASE_ACCESS_TOKEN;
const sql = mgmtToken
  ? async (query) => {
      const ref = new URL(base).hostname.split(".")[0];
      const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${mgmtToken}` },
        body: JSON.stringify({ query }),
        signal: AbortSignal.timeout(30_000),
      });
      // An expired or revoked PAT answers 401 with a JSON body. Returned as [] so a
      // CALLER can preflight it — "the token exists" and "the token works" are
      // different questions, and the claim test below must only run when it can
      // put back whatever it takes.
      if (!res.ok) {
        console.log(
          `  note: the Management API refused a statement (${res.status}) — is SUPABASE_ACCESS_TOKEN expired?`
        );
        return [];
      }
    }
  : null;

let failures = 0;
const out = (ok, label, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  |  ${detail}` : ""}`);
  if (!ok) failures += 1;
};

const STAMP = Date.now().toString(36);
const EMAIL = `zz.mail.${STAMP}@example.com`;

const rpc = async (token, fn, args) => {
  const res = await fetch(`${base}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      apikey: anon,
      "Content-Type": "application/json",
      ...(token ? { "X-Nexus-Staff-Token": token } : {}),
    },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(20_000),
  });
  return res.json().catch(() => null);
};

const rest = async (token, path, init = {}) => {
  const res = await fetch(`${base}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: anon,
      Authorization: `Bearer ${anon}`,
      "X-Nexus-Staff-Token": token,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...(init.headers ?? {}),
    },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

console.log("=== MAIL QUEUE (LIVE) VERIFIED ===\n");

const login = await rpc(null, "staff_login", {
  p_username: env.SUPABASE_STAFF_EMAIL,
  p_password: env.SUPABASE_STAFF_PASSWORD,
});
const token = login?.token;
out(Boolean(token), "signed in as a master", env.SUPABASE_STAFF_EMAIL);
if (!token) {
  console.error("SKIP: no staff credentials in .env");
  process.exit(0);
}

/* ---------- 0. the mail tab's state loads, and a default template exists ---------- */

const state0 = await rpc(token, "staff_mail_state", { p_limit: 5 });
out(state0?.ok === true, "the mail tab state loads in one call");
out(
  Array.isArray(state0?.fields) && state0.fields.length > 0,
  "merge fields are derived from the registration row, not written down",
  `${state0?.fields?.length ?? 0} fields`
);
let regId = null;
let jobId = null;
try {
  /* ---------- 1. a registration to confirm ---------- */

  const created = await rpc(token, "staff_create_registration", {
    p_reg: {
      name: "ZZ Mail Probe",
      email: EMAIL,
      phone_number: "9000000000",
      roll_number: `ZZ${STAMP}`,
      college_name: `ZZ College ${STAMP}`,
      year: "2nd",
      department: "ZZ",
      purchase_type: "event",
      purchase_ref: "vision-2065",
      purchase_label: "ZZ Mail Probe",
      purchase_amount: 249,
      payment_method: "utr",
      payment_status: "unverified",
      // UNIQUE per run: uq_registrations_utr holds btrim(utr_number) unique on
      // purpose, so one reference can never be claimed twice by two people. A
      // fixed probe UTR therefore passes once and fails every run after it -
      // which is the constraint working, not a flake.
      utr_number: `4023456${STAMP}`,
    },
  });
  regId = created?.id;
  out(
    created?.ok === true && Boolean(regId),
    "a registration exists to confirm",
    created?.ok === true ? created.id : JSON.stringify(created).slice(0, 300)
  );

  const jobsFor = async () =>
    (await rest(token, `email_jobs?to_email=eq.${encodeURIComponent(EMAIL)}&select=*`)).body ?? [];

  out((await jobsFor()).length === 0, "nothing is queued before the verify");

  /* ---------- 2. confirming it queues exactly ONE message ---------- */

  const confirmed = await rpc(token, "staff_update_registration", {
    p_id: regId,
    p_patch: { payment_status: "verified" },
  });
  out(confirmed?.ok === true, "the row was confirmed the way the console does it");

  let jobs = await jobsFor();
  out(jobs.length === 1, "confirming queued exactly ONE message", `${jobs.length}`);
  jobId = jobs[0]?.id ?? null;

  const job = jobs[0] ?? {};
  out(!/\{\{/.test(job.body ?? ""), "the body is RENDERED — no placeholder survives");
  out((job.body ?? "").includes("ZZ Mail Probe"), "the participant's own name is in the message");
  out(
    !/\{\{/.test(job.subject ?? ""),
    "and the SUBJECT is rendered too — a raw {{name}} there is seen by every recipient",
    job.subject
  );
  out(job.to_email === EMAIL, "addressed to the registration's own email", job.to_email);

  /* ---------- 3. confirming AGAIN does not queue twice ---------- */

  await rpc(token, "staff_update_registration", {
    p_id: regId,
    p_patch: { payment_status: "unverified" },
  });
  await rpc(token, "staff_update_registration", {
    p_id: regId,
    p_patch: { payment_status: "verified" },
  });
  out((await jobsFor()).length === 1, "confirming again queued nothing new — the idempotency key");

  /* ---------- 4. a sender claims it ---------- */

  /* Claiming is IRREVERSIBLE from here without postgres: the row moves to
     'sending' with a 120s lease, and only the release below puts it back.

     The check is a PREFLIGHT, not "is there a token" — an expired PAT is still a
     token, so guarding on its presence claimed first and failed afterwards, which
     is the worst possible order: the suite reported a failure AND left a real
     participant's confirmation stranded for two minutes with an attempt burned.
     Repeated, that walks a job's attempt count past max_attempts and kills a real
     send. A test that damages mail when the environment is misconfigured is a
     test that gets pointed at production by accident. */
  const canRelease = await (async () => {
    if (!sql) return false;
    try {
      const probeRows = await sql("select 1 as ok;");
      return Array.isArray(probeRows) && probeRows.length > 0;
    } catch {
      return false;
    }
  })();

  if (!canRelease) {
    out(false, "the Management API is unavailable — claiming was NOT tested, and NOTHING was claimed");
  } else {
  const claim = await rpc(token, "claim_email_jobs", {
    p_worker: "probe-worker",
    // 1, not 5. This claims from the WHOLE queue and oldest-first, so a higher
    // limit reaches past the probe's own message and takes real participants' mail
    // with it. A limit above 1 is not a more thorough test here; it is a way to
    // damage production mail.
    p_limit: 1,
    p_lease_seconds: 120,
  });
  const claimed = claim?.claimed ?? [];

  /* Asserted on whatever was actually claimed, NOT on the probe's own job.
     claim_email_jobs orders by (next_attempt_at, created_at), so it hands back the
     OLDEST due message. The probe's row was created moments ago, so whenever real
     mail is pending it is never in the first batch — asserting on it made this
     suite fail intermittently, at random, for no reason connected to the probe.

     What this actually proves is the property that matters: a sender takes a due
     message, marks it sending, and advances its attempt counter. That holds for
     every row the claim can return, which is the whole point of the queue. */
  out(claim?.ok === true && claimed.length === 1, "a sender CLAIMED a due message", `${claimed.length} claimed`);
  out(claimed[0]?.status === "sending", "and it is marked sending", claimed[0]?.status);
  out(claimed[0]?.attempts >= 1, "the attempt counter advanced", String(claimed[0]?.attempts));

  /* Claiming is a shared, global act, so whatever came back is released again
     immediately — back to queued, lease cleared, attempt count put back where it
     was. Leaving it 'sending' holds a real confirmation for the full 120s lease;
     leaving attempts incremented burns one of a participant's five tries because a
     TEST ran.

     The release goes through postgres, NOT a REST PATCH, because email_jobs is
     SELECT-only under RLS on purpose (staff_read_email_jobs) — there is no UPDATE
     policy at all, so every mutation is meant to go through claim_email_jobs /
     complete_email_job. A PATCH silently no-ops, which is exactly how the first
     version of this probe left real mail stuck in 'sending'. */
  for (const j of claimed) {
    await sql(
      `update public.email_jobs
          set status = 'queued',
              locked_at = null,
              locked_by = null,
              attempts = greatest(coalesce(attempts, 1) - 1, 0),
              next_attempt_at = now()
        where id = '${j.id}'
          and locked_by = 'probe-worker';`
    );
  }
  const restored = await rest(token, `email_jobs?id=eq.${claimed[0]?.id ?? "00000000-0000-0000-0000-000000000000"}&select=status,locked_by,attempts`);
  out(
    restored.body?.[0]?.status === "queued" && restored.body?.[0]?.locked_by === null,
    "the claimed row was released back to the queue",
    `status=${restored.body?.[0]?.status} by=${restored.body?.[0]?.locked_by}`
  );

  /* The probe's OWN job, released the supported way: complete_email_job is the
     function the real sender calls, so this exercises the same return-to-queue
     path the failure branch is meant to cover. */
  if (jobId) {
    const mine = await rest(token, `email_jobs?id=eq.${jobId}&select=status`);
    if (mine.body?.[0]?.status === "sending") {
      await rpc(token, "complete_email_job", {
        p_job_id: jobId,
        p_ok: false,
        p_error: "probe: released after the claim test",
      });
    }
  }
  } // end of the "can we release it?" guard

  /* ---------- 5. failure comes back with a DELAY, not an instant retry ---------- */

  const failed = await rpc(token, "complete_email_job", {
    p_job_id: jobId,
    p_ok: false,
    p_error: "probe: simulated provider failure",
  });
  out(
    failed?.ok === true && failed?.status === "queued",
    "a failed send returns to the queue",
    JSON.stringify(failed)
  );

  const afterFail = (await jobsFor())[0] ?? {};
  const secsAway = (new Date(afterFail.next_attempt_at) - Date.now()) / 1000;
  out(
    afterFail.status === "queued" && secsAway > 0,
    "with a DELAY before the next attempt — not an instant retry loop",
    `${Math.round(secsAway)}s away`
  );
  out(
    secsAway <= 300 * 1.6,
    "inside the jittered ceiling (30s doubling to 5 min, plus half again)",
    `${Math.round(secsAway)}s`
  );
  out(
    String(afterFail.last_error ?? "").includes("simulated"),
    "the provider's error is kept for the operator to read"
  );
} finally {
  /* ---------- cleanup, always ---------- */

  // Delete goes through the REST policy (staff_delete_registrations, master
  // only) — there is NO staff_delete_registration RPC, so calling one returns an
  // error and the row survives. The job then cascades with it.
  if (regId) await rest(token, `registrations?id=eq.${regId}`, { method: "DELETE" });
  if (jobId) await rest(token, `email_jobs?id=eq.${jobId}`, { method: "DELETE" });
  const left = await rest(token, `email_jobs?to_email=eq.${encodeURIComponent(EMAIL)}&select=id`);
  out((left.body ?? []).length === 0, "no test rows left behind", `${(left.body ?? []).length}`);
}

console.log(
  failures === 0
    ? "\n=== MAIL QUEUE CHECKS PASSED ==="
    : `\n=== ${failures} MAIL QUEUE CHECK(S) FAILED ===`
);
process.exit(failures === 0 ? 0 : 1);
out(
  (state0?.templates ?? []).some((t) => t.is_default),
  "a default template is seeded, so a verify has something to send",
  (state0?.templates ?? []).map((t) => t.name).join(", ")
);
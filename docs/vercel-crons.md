# Why vercel.json has no `crons`

There was exactly one:

```json
"crons": [{ "path": "/api/send-mail", "schedule": "* * * * *" }]
```

It is gone. `vercel.json` itself carries no explanation, because **JSON has no
comments** — an earlier attempt to document it inline made the file fail
`JSON.parse` and would have failed the deployment, so this note lives here
instead.

## Why it was removed

It was not delivering. The queue still held **9 `queued` jobs and 1 stuck in
`sending`, the oldest from 2026-10-03** — nothing had drained for days despite the
schedule firing every minute. `vercel.json` is a build input, not a runtime
guard: changing it cannot rescue a schedule that was already failing in
production, so it also needs whatever is actually deployed to be updated.

## Nothing is lost

`api/send-mail.js` is **unchanged**, and the queue can still be emptied two ways,
both authenticating the same way and using the same idempotency keys:

1. **Console → Mail → "Run the sender now"** (`data-action="mail-run-sender"`),
   which posts with the operator's staff token.
2. `npm run mail:send` (`scripts/send-mail-local.mjs`), which runs the same
   handler locally. `npm run mail:send:dry` claims nothing and sends nothing.

So removing the cron changes **how** the queue is emptied, not **whether** it can
be.

## What does not happen by itself

The ten jobs already in the queue **will not go out on their own**. Press the
button, or run the script.

If unattended delivery is wanted later, the correct shape is to fix why the cron
was not authenticating rather than to re-add the same entry:

- `CRON_SECRET` — Vercel sends `Authorization: Bearer $CRON_SECRET`; `isCron` in
  `api/send-mail.js` compares it in constant time. If it is unset, every cron
  request is a `401`.
- `MAIL_STAFF_TOKEN` — the cron path has no staff token, so it borrows this one to
  act as the worker. Without it the claim is refused with `403`.
- Vercel's Hobby plan caps cron frequency at once per day; `* * * * *` needs Pro.
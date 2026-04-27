# Evaluator cron not firing

## Severity
warning

> Note: there is currently no dedicated `gw_eval_cron_last_run_at` gauge — the
> evaluator cron only emits indirectly via the LLM call counters. A direct
> "cron last ran at" metric is on the Phase 2 wiring backlog. Until then,
> operators should rely on the proxy signals below.

## Symptoms
- `gw_eval_llm_called_total` is flat at 00:05 UTC even though active orgs exist.
- Org admins report no new `evaluation_reports` rows for the previous day.
- `evaluator cron registered (daily 00:05 UTC)` log line is missing after a deploy.

## Likely causes
1. `ENABLE_EVALUATOR=false` in the gateway env after a deploy.
2. Gateway container was restarting at exactly 00:05 UTC and missed the tick.
3. BullMQ scheduler crashed and the cron job is "registered" but not actually scheduling.
4. All eligible orgs are paused or have the feature disabled.

## Diagnosis commands

```bash
# Verify env + registration log line
docker compose exec gateway env | grep ENABLE_EVALUATOR
docker compose logs gateway 2>&1 | grep "evaluator cron registered"

# When did the evaluator queue last process anything?
docker compose exec gateway node -e "
  const { Queue } = require('bullmq');
  const q = new Queue('evaluator', { connection: { url: process.env.REDIS_URL } });
  Promise.all([q.getJobCounts(), q.getRepeatableJobs()]).then(([counts, repeat]) => {
    console.log('counts', counts);
    console.log('repeatables', repeat);
    process.exit();
  });
"

# Most recent evaluation_reports row
psql "$DATABASE_URL" -c "
  SELECT MAX(created_at) AS last_report FROM evaluation_reports;
"
```

## Resolution steps
1. Confirm `ENABLE_EVALUATOR=true` is set on the gateway container; redeploy if not.
2. If the registration log is missing, restart the gateway — registration is at boot.
3. If the repeatable job is missing from BullMQ, manually re-register by restarting the gateway (the boot sequence calls `startEvaluatorCron`).
4. To trigger an immediate run for testing, an admin can enqueue a single evaluator job via the admin UI.
5. Verify a new row appears in `evaluation_reports` within 1h.

## Escalation
- If 2 consecutive nightly runs are skipped, page on-call.
- File a Phase 2 ticket to add a proper `gw_eval_cron_last_run_at` gauge so this runbook can stop relying on proxies.

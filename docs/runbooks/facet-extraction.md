# FacetExtractionFailureRate

## Severity
warning

> Note: facet metrics (`gw_facet_extract_total`, `gw_facet_extract_duration_ms`,
> `gw_facet_cache_hit_total`) are registered in Phase 1 but not emitted until
> Phase 2 wiring lands. This runbook will become actionable when emission goes
> live; until then, treat any reported firing as a metric-pipeline bug.

## Symptoms
- `gw_facet_extract_total{result!="success"}` rate exceeds 30% for 30 minutes.
- Facet panels on the Evaluator dashboard show `parse_error`, `validation_error`, `timeout`, or `api_error` dominating.
- Downstream search/filter UIs show empty or wrong facets.

## Likely causes
1. Anthropic provider is returning malformed JSON (model regression, prompt drift).
2. The facet schema changed and the validator now rejects historically-valid output.
3. Network partition between gateway and Anthropic causes timeouts.
4. The facet feature flag is on, but the prompt template was deployed in a broken state.

## Diagnosis commands

```bash
# Break down the failure mix
curl -s http://gateway:3002/metrics | grep gw_facet_extract_total

# Latest worker logs for facet
docker compose logs --tail=500 gateway | grep -i facet

# Sample failing jobs from BullMQ
docker compose exec gateway node -e "
  const { Queue } = require('bullmq');
  const q = new Queue('facet', { connection: { url: process.env.REDIS_URL } });
  q.getJobs(['failed'], 0, 9).then(js => {
    for (const j of js) console.log(j.id, j.failedReason);
    process.exit();
  });
"
```

## Resolution steps
1. Identify the dominant `result` label.
2. `parse_error` / `validation_error`: pull the raw LLM response from logs, file a prompt-engineering issue, consider rolling back the most recent prompt change.
3. `timeout`: check Anthropic status; if outage is provider-wide, no action needed.
4. `api_error`: inspect status codes (4xx vs 5xx). 4xx usually means auth/account issue; 5xx is provider-side.
5. If failures persist >1h, disable the facet feature flag for the affected org via the admin UI.

## Escalation
- If failure rate >50% across all orgs, page on-call and disable the facet feature globally.
- File a follow-up ticket with the prompt-engineering team within 24h regardless of root cause.

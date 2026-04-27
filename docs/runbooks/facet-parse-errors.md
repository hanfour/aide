# Facet parse_error / validation_error deep-dive

## Severity
warning

> Companion to `facet-extraction.md`. Use this runbook when the dominant
> failure mode is specifically parse/validation rather than timeout/api_error.
> Like the parent runbook, this is dormant until Phase 2 emission lands.

## Symptoms
- `gw_facet_extract_total{result="parse_error"}` or `{result="validation_error"}` is the top contributor to the failure mix.
- Logs contain repeated "facet response failed JSON.parse" or "facet response failed schema validation" entries.
- A particular model + prompt-version combination is overrepresented in the failures.

## Likely causes
1. Anthropic model returned prose/markdown wrapping the JSON (most common: triple-backtick fenced blocks).
2. The prompt was tweaked and now elicits an unsupported field shape (`category` instead of `categories`, etc.).
3. Schema was made stricter (e.g. added `min(1)` to a string) and existing legitimate output is now rejected.
4. A truncated response (token-limit hit) leaves the JSON partial and unparseable.

## Diagnosis commands

```bash
# Sample raw responses from worker logs
docker compose logs --tail=2000 gateway | grep -A 20 "facet response failed"

# Group failures by model + reason
psql "$DATABASE_URL" -c "
  SELECT model, error_kind, COUNT(*)
  FROM facet_extraction_failures   -- exists once Phase 2 lands
  WHERE created_at > NOW() - INTERVAL '24 hours'
  GROUP BY model, error_kind
  ORDER BY 3 DESC LIMIT 20;
"

# What's the prompt version in flight?
psql "$DATABASE_URL" -c "
  SELECT id, version, created_at FROM facet_prompts ORDER BY created_at DESC LIMIT 5;
"
```

## Resolution steps
1. For markdown-wrapped JSON: tighten the system prompt to "Return ONLY valid JSON, no prose, no markdown".
2. For schema mismatches: diff the latest prompt change against the schema; align field names and add tolerant aliases (e.g. accept both `category` and `categories`) where reasonable.
3. For truncation: increase `max_tokens` for the facet call (typically +25%) and add a length-check before parse.
4. After deploying the fix, monitor `gw_facet_extract_total{result="success"}` recovery for at least 1 hour.

## Escalation
- If a fix requires a prompt change for a paying customer's org, file a change in the prompt registry and request peer review before deploying.
- If schema needs to relax to accommodate, loop in the data team — facets feed downstream filters.

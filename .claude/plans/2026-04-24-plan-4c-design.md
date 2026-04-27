# Plan 4C — Operations Hardening + LLM Facet Enrichment (v0.5.0)

**Date:** 2026-04-24
**Status:** Design approved, ready for implementation plan
**Scope:** Theme A (Operations Hardening) + Theme B (LLM Facet Enrichment)
**Target release:** v0.5.0
**Precursors:** Plan 4A (`2026-04-01-plan-4a-*.md`), Plan 4B (`2026-04-22-plan-4b-*.md`)
**Handoff source:** `.claude/plans/2026-04-24-plan-4c-handoff.md`

---

## 1. Context

Plan 4B (v0.4.0) shipped the evaluator subsystem: body capture, rule-based + LLM Deep Analysis, GDPR, 3-language platform rubrics. It was released 2026-04-24 under 4-layer feature-flag gating (`ENABLE_EVALUATOR=false` default).

Plan 4C makes that subsystem **production-safe** (Theme A) and **more informative** (Theme B) for v0.5.0.

### Non-goals (explicitly out of v0.5.0)

- Email integration (reserved for future plan)
- Member-facing digests / per-section LLM commentary (Theme C)
- Rubric marketplace / sharing (Theme D)
- ClickHouse / aggregate analytics (Theme E)
- LLM facet backfill for historical bodies
- Prompt versioning automation (manual bump only)

### Goals

1. **Operability**: any self-hoster can run v0.5.0 in prod without dashboards/alerts being an afterthought
2. **Cost safety**: LLM spend cannot silently spike; admin sees current spend and has enforcement knobs
3. **CLI-parity signals restored**: `bugsCaught` / `frictionSessions` / `codexErrorSessions` come back via LLM facet extraction
4. **Zero breaking change**: orgs not opting into new features behave identically to v0.4.0

---

## 2. Decision log

### Pre-brainstorm (6 questions from handoff)

| # | Question | Answer |
|---|----------|--------|
| 1 | Theme choice | A + B combined into Plan 4C, target v0.5.0 |
| 2 | Plan 4D email timing | N/A — Theme C not in scope |
| 3 | Deployment cadence | No staging; merge → prod; feature flag is canary |
| 4 | LLM facet cost | Per-org monthly budget (NULL default), UI warning, degrade default |
| 5 | Rubric marketplace trust | N/A — Theme D not in scope |
| 6 | Hard deadline | None; ship when correct |

### In-flight decisions (during brainstorming)

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | `llm_facet_model` independent column from `llm_eval_model` | Facet = structured extraction (haiku OK), Deep Analysis = narrative (sonnet better). 10x cost delta justifies split |
| D2 | Migration fills `llm_monthly_budget_usd = NULL` | Non-breaking; UI warning when `llm_eval_enabled=true` + NULL budget |
| D3 | `ref_type` VARCHAR + CHECK, not PostgreSQL ENUM | Matches 4B style (`evaluation_reports.status`); easier to extend |
| D4 | Anthropic API 5xx/timeout → don't write ledger row | Ledger is internal budget tool, not billing reconciliation |
| D5 | Failed facet extraction → signal value `null`, criterion weight redistributes | Middle-of-the-road: doesn't systematically under/over-score |
| D6 | Rubric v2 keeps Section 1/2 structure, adds facet-only criteria inside each | Facet off = v1 behaviour via weight redistribution; zero breaking change |
| D7 | Post-release smoke includes real tRPC + Playwright E2E + auto-create issue on failure | Low-cost high-signal safety net given no staging |
| D8 | Web Docker image drops arm64; api/gateway keep arm64 | Zero cost, zero flakiness from QEMU web build |
| D9 | Alertmanager config NOT in version control (example template only) | Alertmanager lacks env-var expansion; provider-agnostic for self-hosters |
| D10 | Cost dashboard as widget on Admin home + dedicated page | Key signal visible on landing; deep analysis on dedicated page |
| D11 | Architecture Option 1 (Layered + Lazy + Separate Table + No Backfill) | Clean dependency direction; per-org cost aligned with actual evaluation demand |
| D12 | E2E degraded-banner spec seeds ledger via SQL, no test-only endpoints | Matches 4B E2E pattern; no prod-mode test backdoor risk |
| D13 | Release notes don't publish self-org cost data | Scale differences mean any number misleads deployers |

---

## 3. Architecture overview

**Chosen: Option 1 — Layered + Lazy + Separate Table + No Backfill**

```
Phase 1 (Theme A)         Phase 2 (Theme B)
───────────────────       ──────────────────────────
Cost budget infra         Facet extraction
  ├ pricing.ts              ├ request_body_facets
  ├ callWithCostTracking    ├ promptBuilder / parser
  ├ enforceBudget           ├ ensureFacets worker
  └ llm_usage_events ledger └ facet_* signal types

Observability             Rubric v2
  ├ Grafana dashboards      ├ Null-aware weights
  ├ Alert rules             └ Platform default UPDATE
  ├ Runbooks
  └ Post-release smoke

(foundation)                (built on Phase 1)
```

**Phase ordering rationale:** Phase 2's facet extraction calls LLM → requires Phase 1's cost enforcement in place first. Shipping Phase 1 alone to prod for 7 days proves observability before adding LLM load.

**Flag hierarchy** (5-layer gate for facet execution):

```
ENV   ENABLE_EVALUATOR=true
ENV   ENABLE_FACET_EXTRACTION=true           ← new
ORG   evaluator_enabled=true
ORG   llm_eval_enabled=true
ORG   llm_facet_enabled=true                 ← new
ORG   llm_facet_model IS NOT NULL            ← new
```

Default `ENABLE_FACET_EXTRACTION=false` in shipped Docker images — Phase 2 code is present but inert until operator opts in.

---

## 4. Scope breakdown

### Phase 1 — Operations Hardening (Theme A)

| ID | Item | Delivery |
|----|------|----------|
| A1 | Grafana dashboards | `ops/grafana/{evaluator,body-capture,gdpr}.json` |
| A2 | Alert rules + runbooks | `ops/prometheus/alerts.yml` + `docs/runbooks/*.md` (8 files) |
| A3 | Cost budget infra | Schema + pricing + wrapper + enforcement + ledger |
| A4 | Cost dashboard + Settings UI | Admin home widget + dedicated page + Settings fieldset |
| A5 | Post-release smoke workflow | `.github/workflows/post-release-smoke.yml` + E2E spec + auto-issue |
| A6 | SSE → transcript integration test | `apps/gateway/tests/integration/streamTranscriptSse.integration.test.ts` |
| A7 | Web image arm64 removed | `.github/workflows/release.yml` matrix change |

### Phase 2 — LLM Facet Enrichment (Theme B)

| ID | Item | Delivery |
|----|------|----------|
| B1 | Facet schema | `request_body_facets` table + `evaluation_reports.llm_cost_usd` column |
| B2 | Facet extraction worker | `ensureFacets` lazy call before `scoreWithRules` |
| B3 | Prompt + parser + validator | `packages/evaluator/src/facet/{promptBuilder,parser}.ts` |
| B4 | New signal types | 6 facet_* signals in signal registry |
| B5 | Platform rubric v2 | Migration 0006 `UPDATE` 3 platform rubrics |
| B6 | Null-aware signal engine | `packages/evaluator/src/rubric/evaluator.ts` redistribution logic |

---

## 5. Schema changes

Three sequential migrations. Each PR that introduces a migration also includes its `.down.sql` for emergency rollback.

### 5.1 Migration 0004 — Cost budget infrastructure (Phase 1)

**`organizations` new columns:**

```sql
ALTER TABLE organizations
  ADD COLUMN llm_facet_enabled         BOOLEAN       NOT NULL DEFAULT false,
  ADD COLUMN llm_facet_model           VARCHAR(64)   NULL,
  ADD COLUMN llm_monthly_budget_usd    NUMERIC(10,2) NULL,
  ADD COLUMN llm_budget_overage_behavior VARCHAR(16) NOT NULL DEFAULT 'degrade'
    CHECK (llm_budget_overage_behavior IN ('degrade','halt')),
  ADD COLUMN llm_halted_until_month_end BOOLEAN      NOT NULL DEFAULT false;
```

Existing `llm_eval_enabled` / `llm_eval_model` unchanged.

**`llm_usage_events` new table (ledger):**

```sql
CREATE TABLE llm_usage_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  event_type    VARCHAR(32) NOT NULL
    CHECK (event_type IN ('facet_extraction','deep_analysis')),
  model         VARCHAR(64) NOT NULL,
  tokens_input  INTEGER NOT NULL,
  tokens_output INTEGER NOT NULL,
  cost_usd      NUMERIC(10,6) NOT NULL,
  ref_type      VARCHAR(32) NULL
    CHECK (ref_type IS NULL OR ref_type IN ('request_body_facet','evaluation_report')),
  ref_id        UUID NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_llm_usage_org_month ON llm_usage_events (org_id, created_at);
```

**`rbac_actions` seed:**

```sql
INSERT INTO rbac_actions (action, description) VALUES
  ('evaluator:cost:view', 'View evaluator LLM cost dashboard');
-- Auto-grant to super-admin + org-admin roles
```

### 5.2 Migration 0005 — Facet table (Phase 2)

**`request_body_facets` new table:**

```sql
CREATE TABLE request_body_facets (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_body_id       UUID NOT NULL UNIQUE
                          REFERENCES request_bodies(id) ON DELETE CASCADE,
  org_id                UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  session_type          VARCHAR(32) NULL
    CHECK (session_type IS NULL OR session_type IN
      ('feature_dev','bug_fix','refactor','exploration','other')),
  outcome               VARCHAR(16) NULL
    CHECK (outcome IS NULL OR outcome IN
      ('success','partial','failure','abandoned')),
  claude_helpfulness    SMALLINT NULL
    CHECK (claude_helpfulness IS NULL OR claude_helpfulness BETWEEN 1 AND 5),
  friction_count        INTEGER NULL CHECK (friction_count IS NULL OR friction_count >= 0),
  bugs_caught_count     INTEGER NULL CHECK (bugs_caught_count IS NULL OR bugs_caught_count >= 0),
  codex_errors_count    INTEGER NULL CHECK (codex_errors_count IS NULL OR codex_errors_count >= 0),
  extracted_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  extracted_with_model  VARCHAR(64) NOT NULL,
  prompt_version        INTEGER NOT NULL,
  extraction_error      TEXT NULL
);

CREATE INDEX idx_facets_org_extracted ON request_body_facets (org_id, extracted_at);
CREATE INDEX idx_facets_prompt_version ON request_body_facets (prompt_version);
```

**`evaluation_reports` new column:**

```sql
ALTER TABLE evaluation_reports
  ADD COLUMN llm_cost_usd NUMERIC(10,6) NULL;
```

### 5.3 Migration 0006 — Platform rubric v2 (Phase 2)

`UPDATE` three existing platform rubrics (en / zh-Hant / ja) with the v2 `rubric_json`. Does not insert new rows, does not touch org-owned custom rubrics.

```sql
UPDATE rubrics
  SET rubric_json = '...v2 JSON...',
      revision = revision + 1,
      updated_at = now()
  WHERE scope = 'platform' AND locale IN ('en','zh-Hant','ja');
```

### 5.4 Design rationale

- **Independent `llm_facet_enabled` flag** (not derived from `llm_eval_enabled`): lets facet be independently toggled without disturbing deep analysis — cleaner rollback story
- **Ledger as source of truth**: catches facets that extracted then had report-write fail; supports future LLM use cases (PDF export, per-section narrative) without schema changes
- **`prompt_version` column despite no immediate use**: marginal cost now, avoids migration later when we do bump prompt
- **`CASCADE DELETE` on facets**: body retention cron (Plan 4B) sweeps facets automatically; no parallel purge logic
- **Rubric `UPDATE` vs new row**: simplest; the handoff's technical-debt §7 flagged that rubric versioning isn't formalized yet — deferring that work to a future plan

---

## 6. Cost budget infrastructure (Phase 1 core)

Six layers.

### 6.1 Pricing table (code constant)

`packages/evaluator/src/llm/pricing.ts`:

```ts
export const PRICING: Record<string, {
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
}> = {
  'claude-opus-4-7':   { inputUsdPerMTok: 15,   outputUsdPerMTok: 75 },
  'claude-sonnet-4-6': { inputUsdPerMTok: 3,    outputUsdPerMTok: 15 },
  'claude-haiku-4-5':  { inputUsdPerMTok: 0.80, outputUsdPerMTok: 4 },
};

export function calculateCost(
  model: string,
  tokensIn: number,
  tokensOut: number,
): number {
  const p = PRICING[model];
  if (!p) throw new Error(`Unknown model for pricing: ${model}`);
  return (tokensIn * p.inputUsdPerMTok / 1_000_000)
       + (tokensOut * p.outputUsdPerMTok / 1_000_000);
}
```

Unknown-model throw is intentional: we must fail loudly if someone misconfigures `llm_eval_model` or `llm_facet_model` to a string not in the table.

### 6.2 Cost-aware LLM client wrapper

`packages/evaluator/src/llm/callWithCostTracking.ts`:

```
callWithCostTracking({ orgId, eventType, model, refType, refId, prompt }):
  estimatedCost = calculateCost(model, estimatedInputTokens, maxOutputTokens)

  enforceBudget(orgId, estimatedCost)   // throws on fail

  response = await llmClient.call({ model, prompt, max_tokens })

  if (response.usage is absent):
    // API error, timeout, or no usage in response
    sentry.captureException(...)
    throw ApiError(...)  // don't write ledger (D4)

  actualCost = calculateCost(model, response.usage.input_tokens, response.usage.output_tokens)

  INSERT INTO llm_usage_events (
    orgId, eventType, model,
    tokens_input, tokens_output, cost_usd,
    ref_type, ref_id
  )

  return { response, cost: actualCost }
```

**Estimation upper bound**: we always estimate using `max_tokens` as output upper bound; actual usage is usually lower, so enforcement is conservative (never over-allows).

### 6.3 Budget enforcement gate

`packages/evaluator/src/budget/enforceBudget.ts`:

```
enforceBudget(orgId, estimatedCost):
  org = await loadOrg(orgId)

  if (org.llm_halted_until_month_end):
    if (now is still same UTC month as halt flag was set):
      throw BudgetExceededHalt
    else:
      // Month rolled over: auto-clear
      UPDATE organizations SET llm_halted_until_month_end=false WHERE id=orgId
      org.llm_halted_until_month_end = false

  if (org.llm_monthly_budget_usd IS NULL):
    return  // unlimited

  monthSpend = SELECT COALESCE(SUM(cost_usd), 0)
               FROM llm_usage_events
               WHERE org_id = orgId
                 AND created_at >= date_trunc('month', now() AT TIME ZONE 'UTC')

  if (monthSpend + estimatedCost <= org.llm_monthly_budget_usd):
    return  // within budget

  // Over budget
  if (org.llm_budget_overage_behavior === 'halt'):
    UPDATE organizations SET llm_halted_until_month_end=true WHERE id=orgId
    throw BudgetExceededHalt
  else:
    throw BudgetExceededDegrade
```

**Month definition**: UTC calendar month. No cron needed — `date_trunc` handles rollover. `llm_halted_until_month_end` flag auto-clears on first call of new month.

### 6.4 Overage behaviour matrix

| Scenario | `degrade` | `halt` |
|----------|-----------|--------|
| Facet extraction over budget | Skip this session's facet, continue others | Skip this + set halt flag, skip all LLM for rest of month |
| Deep analysis over budget | Report has no narrative, `llm_degraded=true` | Same (single call) |
| Next evaluation same month | Each call re-checks; partial LLM may succeed | Halt flag blocks immediately |
| Rule-based scoring | Always runs regardless | Always runs regardless |

**Invariant:** a report is always produced (with rule-based signals) even when LLM is fully blocked.

### 6.5 Cost summary tRPC endpoint

`admin.evaluator.getCostSummary`:

```ts
{
  currentMonthSpendUsd: number;           // SUM ledger for current UTC month
  budgetUsd: number | null;
  remainingUsd: number | null;
  projectedEndOfMonthUsd: number;         // spend * daysInMonth / elapsedDays
  breakdown: {
    facetExtraction: { calls: number; costUsd: number };
    deepAnalysis:    { calls: number; costUsd: number };
  };
  breakdownByModel: Array<{ model: string; calls: number; costUsd: number }>;
  historicalMonths: Array<{ month: string; costUsd: number }>;  // last 6
  warningThresholdReached: boolean;       // spend >= budget * 0.8
  halted: boolean;
}
```

RBAC: requires `evaluator:cost:view` action.

### 6.6 Metrics emission

Every `llm_usage_events` INSERT triggers:

```
gw_llm_cost_usd_total{org_id, event_type, model} += cost_usd
```

Every `enforceBudget` call past the 80% threshold:

```
gw_llm_budget_warn_total{org_id} += 1
```

Every `BudgetExceeded*` throw:

```
gw_llm_budget_exceeded_total{org_id, behavior} += 1
```

---

## 7. Facet extraction worker (Phase 2 core)

### 7.1 Integration point

Evaluator worker's flow extended:

```
loadWindow → ensureFacets → loadSignals (facets merged) → scoreWithRules → maybeDeepAnalysis → writeReport
                 ↑
         new step, Phase 2
```

### 7.2 `ensureFacets` flow

`apps/gateway/src/workers/evaluator/ensureFacets.ts`:

```
ensureFacets(orgId, sessions, promptVersion=CURRENT_PROMPT_VERSION):
  if (!ENABLE_FACET_EXTRACTION) return []  // env gate
  if (!org.llm_facet_enabled) return []
  if (!org.llm_facet_model) return []

  needExtract = []
  for (session of sessions):
    existing = getFacet(session.request_body_id)
    if (existing && existing.prompt_version === promptVersion):
      continue  // cache hit, reuse
    needExtract.push(session)

  // per-org concurrency 5
  results = await parallelMap(needExtract, 5, extractOne)
  return results
```

### 7.3 `extractOne` single extraction

`packages/evaluator/src/facet/extractor.ts`:

```
extractOne(session):
  prompt = buildFacetPrompt(session)
  preGeneratedId = randomUUID()  // used as ref_id before row insert

  try:
    response = await callWithCostTracking({
      orgId: session.org_id,
      eventType: 'facet_extraction',
      model: org.llm_facet_model,
      refType: 'request_body_facet',
      refId: preGeneratedId,
      prompt,
      timeout: 15_000,
    })

    facet = parseAndValidate(response.text)
    await insertFacetRow({
      id: preGeneratedId,
      request_body_id: session.request_body_id,
      org_id: session.org_id,
      ...facet,
      extracted_with_model: org.llm_facet_model,
      prompt_version: CURRENT_PROMPT_VERSION,
      extraction_error: null,
    })
    return facet

  } catch (e) {
    if (e instanceof BudgetExceededDegrade || e instanceof BudgetExceededHalt):
      return null   // don't write row, retry next eval

    // parse_error | validation_error | timeout | api_error
    const errorType = classifyError(e)
    if (errorType === 'api_error'):
      return null   // transient, retry next eval

    // deterministic failures: write row with error, no retry
    await insertFacetRow({
      id: preGeneratedId,
      request_body_id: session.request_body_id,
      org_id: session.org_id,
      session_type: null,
      outcome: null,
      claude_helpfulness: null,
      friction_count: null,
      bugs_caught_count: null,
      codex_errors_count: null,
      extracted_with_model: org.llm_facet_model,
      prompt_version: CURRENT_PROMPT_VERSION,
      extraction_error: `${errorType}: ${e.message}`,
    })
    return null
  }
```

### 7.4 Retry policy matrix

| Error | Write facet row? | Re-attempt at same `prompt_version`? |
|-------|------------------|-------------------------------------|
| Success | yes, fields filled | no |
| `parse_error` | yes, fields null, error recorded | no (deterministic) |
| `validation_error` | yes, fields null, error recorded | no (deterministic) |
| `timeout` | yes, fields null, error recorded | no (avoid repeat overload) |
| `api_error` (5xx) | no | yes (transient) |
| `budget_exceeded_*` | no | yes (may resolve with budget) |

### 7.5 Prompt structure

`packages/evaluator/src/facet/promptBuilder.ts`:

**System prompt (≈1.5k tokens):**

```
You are an evaluator analysing a single Claude Code session. Given the
transcript, classify it against the schema below. Output JSON only, no
prose, no markdown.

Schema:
{
  "sessionType": "feature_dev" | "bug_fix" | "refactor" | "exploration" | "other",
  "outcome":     "success" | "partial" | "failure" | "abandoned",
  "claudeHelpfulness": 1 | 2 | 3 | 4 | 5,
  "frictionCount":     non-negative integer,
  "bugsCaughtCount":   non-negative integer,
  "codexErrorsCount":  non-negative integer
}

Definitions:
- frictionCount: user-visible pain points (misunderstanding, rework, confusion)
- bugsCaughtCount: defects Claude identified in user's code
- codexErrorsCount: tool/parse errors from Claude's own output

Examples:
[3 few-shot: feature_dev success, bug_fix failure, exploration abandoned]
```

**User prompt:** serialized session turns from the captured body (content + tool_use + tool_result blocks). Truncation: head 3k + tail 3k tokens preserved; middle replaced with `[...N tokens truncated...]` placeholder when over 8k.

**Output budget:** `max_tokens: 256` (JSON is small).

### 7.6 Response parsing

`packages/evaluator/src/facet/parser.ts`:

Extends 4B's existing `responseParser` pattern:

1. Extract JSON from response (handle code-fence wrapping)
2. Zod schema validation
3. Enum value checks (typed against schema)
4. Range checks (`claudeHelpfulness` 1-5, counts ≥ 0)
5. Missing-field checks

All failures throw typed errors (`ParseError` / `ValidationError`) that `extractOne` catches.

### 7.7 Concurrency and timeouts

| Knob | Value | Rationale |
|------|-------|-----------|
| Per-org facet concurrency | 5 | Avoid single org starving worker; avoid Anthropic rate limits |
| Per-call timeout | 15s | Facet is small; 15s is generous |
| BullMQ evaluator job timeout | 300s (was 60s) | Worst case 50 sessions × 15s / concurrency 5 = 150s + scoring/narrative |

### 7.8 Prompt versioning

- Initial `CURRENT_PROMPT_VERSION = 1` (const in `promptBuilder.ts`)
- Bumping is a manual code change; PR reviewer must flag it
- Old `prompt_version` facets are treated as missing on subsequent evaluations (forces re-extract)
- No automatic backfill; no scheduled re-extraction job in v0.5.0

### 7.9 Observability

| Metric | Labels | Meaning |
|--------|--------|---------|
| `gw_facet_extract_total` | `org_id, result` | result ∈ {success, parse_error, validation_error, timeout, api_error, budget_skip} |
| `gw_facet_extract_duration_ms` | `org_id` | histogram of LLM call duration |
| `gw_facet_cache_hit_total` | `org_id` | sessions skipped because facet already existed |

---

## 8. Rubric and signal engine

### 8.1 Null-aware weight redistribution

`packages/evaluator/src/rubric/evaluator.ts` extended:

```
scoreSection(section, signalValues):
  activeCriteria = section.criteria.filter(c => signalValues[c.signalType] !== null)
  excludedCriteria = section.criteria.filter(c => signalValues[c.signalType] === null)

  if (activeCriteria.length === 0):
    return {
      score: null,
      excludedCriteria: excludedCriteria.map(c => ({
        name: c.name,
        reason: 'signal_null',
        originalWeight: c.weight,
      })),
      skippedReason: 'all_criteria_null',
    }

  totalActiveWeight = sum(c.weight for c in activeCriteria)
  weightedScore = sum(scoreCriterion(c, signalValues) * c.weight for c in activeCriteria)
  sectionScore = weightedScore / totalActiveWeight

  return {
    score: sectionScore,
    excludedCriteria: excludedCriteria.map(c => ({
      name: c.name,
      reason: 'signal_null',
      originalWeight: c.weight,
    })),
  }

scoreReport(sections, signalValues):
  sectionResults = sections.map(s => scoreSection(s, signalValues))
  nonNullSections = sectionResults.filter(s => s.score !== null)

  if (nonNullSections.length === 0):
    return { score: null, llm_degraded: true, ...}

  // Each section's declared weight (40 / 60) still used; null sections excluded
  totalWeight = sum(s.declaredWeight for s in nonNullSections)
  reportScore = sum(s.score * s.declaredWeight for s in nonNullSections) / totalWeight
  return { score: reportScore, sections: sectionResults, ... }
```

### 8.2 New signal types

Added to `packages/evaluator/src/signals/types.ts`:

| Signal type | Shape | Source | Aggregation |
|-------------|-------|--------|-------------|
| `facet_session_type_ratio` | `{[type]: ratio}` | `facet.sessionType` | count per type / total |
| `facet_outcome_success_rate` | `number [0,1]` | `facet.outcome` | count(success,partial) / total |
| `facet_claude_helpfulness` | `number [1,5]` | `facet.claudeHelpfulness` | mean across window |
| `facet_friction_per_session` | `number ≥0` | `facet.frictionCount` | mean across window |
| `facet_bugs_caught` | `number ≥0` | `facet.bugsCaughtCount` | sum across window |
| `facet_codex_errors` | `number ≥0` | `facet.codexErrorsCount` | sum across window |

**Null rule:** if every facet row in the window has `null` for the underlying field, the signal value is `null` (not 0). One non-null row is enough to compute.

**Source module:** `packages/evaluator/src/signals/facet.ts` joins `request_body_facets` against the window's session IDs and aggregates.

### 8.3 Platform rubric v2

**Structure unchanged** (two sections, 40/60). Each section adds facet-only criteria.

**Section 1 — Collaboration Quality (weight 40)**

| Criterion | Weight | Signal | New in v2? |
|-----------|--------|--------|------------|
| Iteration pattern | 15 | `iteration_count` | existing |
| Refusal control | 10 | `refusal_rate` | existing |
| Claude helpfulness | 15 | `facet_claude_helpfulness` | ★ new |

**Section 2 — Outcomes (weight 60)**

| Criterion | Weight | Signal | New in v2? |
|-----------|--------|--------|------------|
| Tool execution success | 15 | `tool_success_rate` | existing |
| Session completion | 15 | `completion_rate` | existing |
| Bugs caught | 10 | `facet_bugs_caught` | ★ new |
| Friction signals (inverted) | 10 | `facet_friction_per_session` | ★ new |
| Codex error rate (inverted) | 10 | `facet_codex_errors` | ★ new |

**Backward compatibility guarantee:** when `llm_facet_enabled=false` the five ★ criteria all have null signals and are excluded. Remaining criteria sum to 25 in Section 1, 30 in Section 2 → after normalization Section 1 = 40 points, Section 2 = 60 points — identical to v1 behaviour.

### 8.4 Custom rubrics

Untouched. Orgs can add facet_* signals to custom rubrics via the editor; a "Requires LLM Facet" badge is shown in the signal-type dropdown. Dry-run shows which criteria would be excluded under current facet state.

### 8.5 Report output changes

`evaluation_reports.report_json` gains:

```json
{
  "sections": [
    {
      "name": "Collaboration Quality",
      "score": 72,
      "excludedCriteria": [
        {
          "name": "Claude Helpfulness",
          "reason": "signal_null",
          "originalWeight": 15
        }
      ]
    }
  ],
  "llm_degraded": false,
  "llm_cost_usd": 0.0123
}
```

---

## 9. Observability deliverables

### 9.1 Grafana dashboards

Three JSON files in `ops/grafana/`:

**`evaluator.json`**

- Row 1 Jobs: `rate(gw_eval_job_completed)`, `rate(gw_eval_job_failed)`, duration p50/p99
- Row 2 DLQ: `gw_eval_dlq_depth` current + 24h trend
- Row 3 Facet: `rate(gw_facet_extract_total)` stacked by result; cache hit rate; duration heatmap
- Row 4 Cost: `increase(gw_llm_cost_usd_total[30d])` by org; budget utilization bar; top 5 spenders
- Variable: `org_id` (dropdown, includes `__all__`)

**`body-capture.json`** — capture rate, purge lag, encryption throughput, body size distribution (4B metrics, no new additions)

**`gdpr.json`** — pending request count, approvals pending > 25 days, executor cron success (4B metrics)

### 9.2 Alert rules

`ops/prometheus/alerts.yml`:

| Alert | Expression | Severity | Runbook |
|-------|------------|----------|---------|
| EvaluatorDLQBacklog | `gw_eval_dlq_depth > 10` for 15m | warning | `evaluator-dlq.md` |
| EvaluatorDLQCritical | `gw_eval_dlq_depth > 50` for 5m | critical | `evaluator-dlq.md` |
| BodyPurgeLagging | `gw_body_purge_lag_hours > 6` for 30m | warning | `body-purge-lag.md` |
| GDPRSLANearing | `gw_gdpr_request_age_days > 25` | warning | `gdpr-sla.md` |
| GDPRSLAViolated | `gw_gdpr_request_age_days > 30` | critical | `gdpr-sla.md` |
| LLMBudgetWarning | `rate(gw_llm_budget_warn_total[1h]) > 0` | info | `llm-budget.md` |
| LLMBudgetExceeded | `rate(gw_llm_budget_exceeded_total[1h]) > 0` | warning | `llm-budget.md` |
| FacetExtractionFailureRate | `rate(failures[15m]) / rate(total[15m]) > 0.3` for 30m | warning | `facet-extraction.md` |
| EvaluatorCronNotFiring | `absent(gw_eval_cron_fired_total) OR increase([25h]) < 1` | critical | `evaluator-cron.md` |

Each alert annotation carries: runbook URL, Grafana panel link, first-step diagnosis command.

### 9.3 Alertmanager config

`ops/alertmanager/alertmanager.yml.example` — template with placeholder Slack/Discord webhook and routing rules; not in version control as real config (D9).

### 9.4 Runbooks

Eight new files in `docs/runbooks/`, each following the Plan 4B runbook structure:

```
# <Alert Name>
## Severity
## Symptoms
## Likely causes
## Diagnosis commands
## Resolution steps
## Escalation
```

Files: `evaluator-dlq.md`, `body-purge-lag.md`, `gdpr-sla.md`, `llm-budget.md`, `facet-extraction.md`, `evaluator-cron.md`, plus `facet-parse-errors.md` and `cost-ledger-mismatch.md` for deeper facet/cost incidents.

### 9.5 Post-release smoke workflow

`.github/workflows/post-release-smoke.yml`:

```yaml
on:
  workflow_run:
    workflows: [Release]
    types: [completed]

jobs:
  smoke:
    if: github.event.workflow_run.conclusion == 'success'
    steps:
      - checkout
      - setup node + playwright
      - run scripts/smoke-evaluator.sh   # existing tRPC check
      - run npx playwright test apps/web/e2e/specs/99-post-release-smoke.spec.ts
      - on failure:
          gh issue create
            --title "Post-release smoke failed: ${{ github.event.release.tag_name }}"
            --body "<workflow logs excerpt>"
            --label "release-blocker"
            --assignee <admin>
```

`apps/web/e2e/specs/99-post-release-smoke.spec.ts`: Playwright spec that logs into the canary org via a service-account token (stored as GitHub Actions secret), opens a report, logs out.

**Canary config:** `ops/canary-org.env.example` describes the expected variables; real values live in Actions secrets.

### 9.6 SSE integration test

`apps/gateway/tests/integration/streamTranscriptSse.integration.test.ts`:

- MSW mock of Anthropic SSE endpoint with real event sequence (`message_start` → `content_block_start` → `content_block_delta` × N → `content_block_stop` → `message_delta` → `message_stop`)
- Gateway `streamUsageExtractor` consumes the stream
- Asserts final `StreamTranscript` contains full content + tool_use + usage
- Three scenarios: plain text; tool_use with input delta'd across 5 chunks; retry-mid-stream

### 9.7 Docker release matrix

`.github/workflows/release.yml` change:

| Image | amd64 | arm64 |
|-------|-------|-------|
| `aide-api` | ✅ | ✅ |
| `aide-gateway` | ✅ | ✅ |
| `aide-web` | ✅ | ❌ (removed in v0.5.0) |

---

## 10. Admin UI

### 10.1 Settings form additions

`apps/web/src/components/evaluator/SettingsForm.tsx`:

Two new fieldsets:

**LLM Cost Control**
- Monthly budget (USD) — numeric input, empty = unlimited
- Overage behavior — radio: Degrade / Halt
- Link: "View cost dashboard →"

**LLM Facet Extraction**
- Enable facet extraction — checkbox
- Facet model — dropdown (haiku / sonnet / opus)
- Helper text: "Recommend haiku for cost-efficient extraction"

**Dynamic warnings:**
- `llm_eval_enabled=true` + budget NULL → yellow inline banner "No budget set. LLM costs are unlimited."
- `llm_facet_enabled=true` + `llm_eval_enabled=false` → red error, blocks submit
- `llm_facet_enabled=true` + `llm_facet_model=NULL` → red error, blocks submit

**Re-add Zod resolver** (fixing handoff technical-debt #1) with correct handling of native-select empty-string round-trips.

### 10.2 Cost dashboard

New page `apps/web/src/app/admin/evaluator/costs/page.tsx`:

```
┌──────────────────────────────────────────────────────┐
│          This month — April 2026                      │
│  $12.34 / $50.00                                      │
│  ████████████░░░░░░░░░░  24.7%                        │
│  Remaining: $37.66    Projected EOM: $18.50           │
└──────────────────────────────────────────────────────┘

Breakdown by task       Breakdown by model
┌──────────┬──────┐     ┌──────────────┬──────┐
│ Facet    │ $8.20│     │ haiku-4-5    │ $8.20│
│ Deep     │ $4.14│     │ sonnet-4-6   │ $4.14│
└──────────┴──────┘     └──────────────┴──────┘

Historical (6 months)
[bar chart]
```

**Progress bar colour:**
- <50%: green
- 50-80%: yellow
- ≥80%: red + top banner "Approaching monthly budget"
- Halted: grey + banner "LLM halted until next month start (UTC)"

Data source: `admin.evaluator.getCostSummary`. RBAC: `evaluator:cost:view`.

**Admin home widget:** a compact version of the spend bar appears on the admin landing page; clicking navigates to the full dashboard (D10).

### 10.3 Report page extensions

`apps/web/src/components/evaluator/ProfileEvaluation.tsx`:

**Excluded criteria display:**

```
Section 1 — Collaboration Quality                    72/100
  ✓ Iteration pattern                    15/15
  ✓ Refusal control                      10/10
  ⊘ Claude helpfulness       (skipped, weight redistributed)
    Reason: facet extraction not enabled
```

**Degraded banner** (when `llm_degraded=true`):

```
⚠ This report ran without LLM analysis because the monthly
  budget was reached. Scores reflect rule-based signals only.
  [View cost dashboard →]
```

**Evidence drill-down:** when a session has a facet row, show:

```
Session #12 — 2026-04-15 14:30 UTC
├─ Gateway signals: iteration=5, refusal=no, tool_success=0.9
└─ Facets (LLM-extracted):
   ├─ Type: feature_dev
   ├─ Outcome: success
   ├─ Claude helpfulness: 4/5
   ├─ Friction count: 0
   └─ Bugs caught: 2
```

If facet extraction failed, display `Facet extraction failed: <error_type>` in evidence section.

### 10.4 Rubric editor extensions

`apps/web/src/components/evaluator/RubricEditor.tsx`:

Signal-type dropdown grouped:

```
Built-in signals
  iteration_count
  refusal_rate
  tool_success_rate
  completion_rate

LLM facet signals  [Requires facet extraction]
  facet_claude_helpfulness
  facet_friction_per_session
  facet_bugs_caught
  facet_codex_errors
  facet_outcome_success_rate
  facet_session_type_ratio
```

Dry-run preview surfaces weight-redistribution outcomes when facet is unavailable.

### 10.5 Banner component

New `apps/web/src/components/evaluator/Banner.tsx` (info / warn / error variants) reused by Settings warnings, cost dashboard banners, and degraded report banner. Avoids scattered inline styling.

### 10.6 i18n

All new strings enter `apps/web/src/i18n/` in en / zh-Hant / ja (same locales as 4B). Monetary values use `Intl.NumberFormat` with locale.

---

## 11. Migration and deployment sequence

### 11.1 Migration order

Three migrations merge with their respective PRs, each running against prod on merge:

1. `0004_cost_infra.sql` — merges with Phase 1 cost PR (non-breaking: new nullable columns + new table)
2. `0005_facet_table.sql` — merges with Phase 2 facet schema PR (non-breaking)
3. `0006_rubric_v2.sql` — merges with Phase 2 rubric upgrade PR (semantic change, but facet-off behaviour matches v1)

Each migration ships with `.down.sql` for emergency rollback. Normal rollback goes through feature flags, not down-migrations.

### 11.2 Feature-flag hierarchy

See §3 for the five-layer gate. `ENABLE_FACET_EXTRACTION` ships as `false` in v0.5.0 Docker images.

### 11.3 Canary flow on single main branch

```
Week 0   Phase 1 PRs merge → prod
         Migration 0004 runs
         Grafana dashboards start collecting data
         Cost dashboard shows real deep-analysis spend (if own org has llm_eval_enabled)

Week 0-1 Observe:
         - Set llm_monthly_budget_usd=10 on self-org
         - Validate Grafana panels show real traffic curves
         - Tune alert thresholds based on actual data

Week 1   Phase 2 PRs merge → prod
         Migrations 0005 + 0006 run
         Code shipped but ENABLE_FACET_EXTRACTION=false → behaviour identical to Phase 1

Week 1   Self-org opens Phase 2:
         ENV  ENABLE_FACET_EXTRACTION=true
         ORG  llm_facet_enabled=true, llm_facet_model='claude-haiku-4-5', budget=50
         Observe 7 days

Week 2   Metrics green → git tag v0.5.0
         release.yml runs → images pushed
         post-release-smoke.yml runs → canary smoke
         v0.5.0 public announcement
```

v0.5.0 tag is the marker for "self-validated", not for "code merged".

### 11.4 RBAC additions

Migration 0004 inserts one new action into `rbac_actions`:

- `evaluator:cost:view` — auto-granted to super-admin and org-admin roles

Existing actions (`evaluator:config:update`, `evaluator:rubric:edit`, `evaluator:report:view`) cover the new settings fields, rubric editor, and report drill-down respectively.

### 11.5 Docker release matrix

| Image | amd64 | arm64 | Tags |
|-------|-------|-------|------|
| `ghcr.io/hanfour/aide-api` | ✅ | ✅ | `v0.5.0`, `latest` |
| `ghcr.io/hanfour/aide-gateway` | ✅ | ✅ | `v0.5.0`, `latest` |
| `ghcr.io/hanfour/aide-web` | ✅ | ❌ | `v0.5.0`, `latest` |

### 11.6 Rollback playbook

| Scenario | Severity | Action |
|----------|----------|--------|
| Facet parse_error storm | medium | `ENABLE_FACET_EXTRACTION=false`; existing facet rows remain harmless |
| Cost enforcement false positive | high | Per-org `UPDATE … SET llm_monthly_budget_usd=NULL`; or flag off |
| Rubric v2 scoring regression | high | Admin switches org `rubric_id` to pre-v2 clone (4B clone API) |
| Catastrophic incident | critical | Docker rollback to v0.4.0 + manual `.down.sql` 0006 → 0005 → 0004 |

**Guideline:** 95% of incidents resolve by flipping a flag. Schema changes only as last resort.

### 11.7 Upgrade documentation

New file `docs/UPGRADE-v0.5.0.md`:

1. Backup database
2. `docker-compose pull`
3. `docker-compose up -d` (migrations auto-run)
4. Log in as admin, verify Settings shows new fields
5. Optional: set `llm_monthly_budget_usd` and enable facet
6. Verify cost dashboard renders
7. If self-hosting Grafana: `cp ops/grafana/*.json` to provisioning dir
8. If using Alertmanager: merge `ops/prometheus/alerts.yml` into existing rules

---

## 12. Testing strategy

Target: 80%+ coverage on new code, per project standard.

### 12.1 Unit tests

**Phase 1:**

| File | Focus | Est. cases |
|------|-------|------------|
| `packages/evaluator/tests/llm/pricing.test.ts` | known model cost; unknown model throws; boundary values | ~8 |
| `packages/evaluator/tests/llm/callWithCostTracking.test.ts` | ledger write on success; no ledger on api_error (D4); 3 error paths | ~12 |
| `packages/evaluator/tests/budget/enforceBudget.test.ts` | table-driven budget states; month rollover; halt persistence | ~15 |
| `apps/api/tests/trpc/routers/evaluatorCost.test.ts` | getCostSummary response shape; projection math; RBAC | ~6 |

**Phase 2:**

| File | Focus | Est. cases |
|------|-------|------------|
| `packages/evaluator/tests/facet/promptBuilder.test.ts` | snapshot tests; truncation logic; token budget boundaries | ~6 |
| `packages/evaluator/tests/facet/parser.test.ts` | valid JSON, malformed, out-of-range enum, missing field, extra field | ~10 |
| `packages/evaluator/tests/signals/facet.test.ts` | all-null signal; partial-null aggregation; ratio/mean/sum/inverted | ~12 |
| `packages/evaluator/tests/rubric/nullAwareWeight.test.ts` | 1/3 null, 2/3 null, all null, section-level null propagation | ~10 |

### 12.2 Integration tests (real Postgres + MSW)

Per handoff feedback: integration tests do not mock the database.

| File | Focus |
|------|-------|
| `apps/gateway/tests/workers/evaluator/ensureFacets.integration.test.ts` | concurrency, mid-window budget hit, parse error row write, prompt_version miss → re-extract |
| `apps/gateway/tests/workers/evaluator/runEvaluation.facet.integration.test.ts` | full worker run: facet rows + ledger + `llm_cost_usd` + `excludedCriteria` |
| `apps/gateway/tests/workers/evaluator/runEvaluation.degraded.integration.test.ts` | degrade: narrative empty, report produced; halt: all LLM blocked rest of month |
| `apps/gateway/tests/integration/streamTranscriptSse.integration.test.ts` | §9.6 SSE round-trip |
| `apps/api/tests/integration/admin/evaluator/cost.integration.test.ts` | getCostSummary + RBAC + month boundary |

### 12.3 E2E tests (Playwright)

| Spec | Flow |
|------|------|
| `30-cost-dashboard.spec.ts` | Admin home widget → full dashboard; no-budget warning state |
| `31-budget-setting.spec.ts` | Settings: set budget 10 → save → warning disappears; clear → warning reappears |
| `32-facet-enable.spec.ts` | Enable facet + choose model → save → manual evaluator trigger → facet drill-down visible |
| `33-rubric-facet-signal.spec.ts` | Rubric editor selects facet signal → dry-run warning → save → visible in report |
| `34-degraded-banner.spec.ts` | SQL-seed ledger over budget (D12) → run evaluator → degraded banner shown |
| `99-post-release-smoke.spec.ts` | §9.5 post-release smoke |

### 12.4 CI additions

**New job:** `no-anthropic-calls-in-ci`

Prevents tests from accidentally hitting real Anthropic API:

```yaml
- name: Ensure no real Anthropic calls
  run: |
    ! grep -r "from '@anthropic-ai/sdk'" apps/*/tests packages/*/tests
    grep ANTHROPIC_API_KEY .github/workflows/ci.yml | grep -q 'test-key-do-not-use'
```

**BullMQ integration test timeout** raised from 60s to 300s to match §7.7 worker timeout.

**Coverage:** global 80% (existing); new files required ≥80% via PR template checklist; Vitest coverage uploaded to Codecov with regression alerts.

### 12.5 Fixtures

New:
- `packages/evaluator/tests/fixtures/sessions/` — 10 realistic session JSONs covering feature_dev/bug_fix/refactor/exploration × success/partial/failure/abandoned
- `packages/evaluator/tests/fixtures/facets/` — expected facet outputs for those sessions
- `apps/gateway/tests/msw/anthropic.ts` — MSW handlers for happy / parseBadJson / timeoutAfter20s / http500 / validationError scenarios

### 12.6 Not tested (explicitly)

- Real Anthropic billing reconciliation (D4 — ledger is internal budget tool)
- Prometheus / Grafana / Alertmanager config effects (infra, not code; canary validates)
- Long-term (year-crossing) month rollover — `date_trunc` covers this; single month-end test suffices

### 12.7 CI runtime budget

| Suite | v0.4.0 | v0.5.0 |
|-------|--------|--------|
| Unit | ~40s | ~55s |
| Integration | ~3min | ~6min |
| E2E | ~5min | ~7min |
| Total | ~12min | ~17min |

---

## 13. Rollout stages

Six stages with entry gates, success criteria, and abort conditions.

### Stage 0 — Pre-merge

**Entry:** all Phase 1 PRs ready
**Exit:** all PRs merged to main

**Gates:** CI green, ≥80% coverage on new files, code-reviewer agent pass, 0004 migration up-down-up verified in dev DB.

### Stage 1 — Phase 1 live (Week 0)

**Entry:** Phase 1 code in prod, 0004 applied
**Duration:** minimum 7 days
**Exit:** canary metrics green, Phase 2 PRs start merging

**Success criteria:**
- `gw_eval_dlq_depth` no new backlog
- `EvaluatorCronNotFiring` no false positive
- Grafana 3 dashboards populated
- Cost dashboard shows real deep-analysis spend
- 8 runbooks merged

**Abort conditions:**
| Condition | Action |
|-----------|--------|
| Migration 0004 prod failure | Rollback to v0.4.0 image + 0004.down; fix, retry |
| `gw_eval_job_failed` rate > 2× v0.4.0 baseline | Regression; rollback image; fix |
| Cost dashboard shows NaN / missing | Non-blocking; UI hotfix merged before Stage 1 completes |

### Stage 2 — Phase 2 shipped, facet off (Week 1)

**Entry:** Stage 1 success + Phase 2 PRs ready
**Exit:** Migrations 0005 + 0006 run, code deployed, flag confirmed off

**Success criteria:**
- Migrations succeed
- `request_body_facets` row count = 0 (flag works)
- Platform rubrics updated to v2
- Self-org evaluator still runs; no metric regression

**Abort conditions:**
| Condition | Action |
|-----------|--------|
| Migration 0005/0006 failure | Run down migrations; code tolerates missing tables via flag gate |
| Self-org report scores shift > 5% vs v0.4.0 baseline | 0006.down; rubric design bug; fix |

### Stage 3 — Facet canary on self-org (Week 1-2)

**Entry:** Stage 2 complete
**Duration:** minimum 7 days
**Exit:** canary metrics green

**Enablement:**

```
ENV      ENABLE_FACET_EXTRACTION=true
ORG      UPDATE organizations SET
           llm_facet_enabled=true,
           llm_facet_model='claude-haiku-4-5',
           llm_monthly_budget_usd=50.00
         WHERE id='<self-org>'
```

**Success criteria:**
- facet success rate ≥ 85%
- `gw_facet_extract_duration_ms` p99 < 12s
- Ledger total vs actual Anthropic bill deviation < 5% (manual cross-check)
- Each daily report includes at least 3 populated facet fields
- `LLMBudgetExceeded` alert silent (unless intentional test)
- Subjective: report quality not worse than v0.4.0

**Abort conditions:**
| Condition | Action |
|-----------|--------|
| parse_error rate > 20% for 4h | flag off; debug prompt; fix |
| Ledger deviation > 5% from bill | flag off; pricing or token calc bug |
| Anthropic 24h spend > 2× budget | flag off + `llm_eval_enabled=false`; budget enforcement broken; hotfix |
| Member score day-over-day delta > 10% for 2 days | flag off; investigate signal/rubric bug |

### Stage 4 — Tag v0.5.0 (Week 2)

**Entry:** Stage 3 green for 7 days
**Exit:** images on ghcr.io + release notes published

**Steps:**
1. `git tag v0.5.0 <sha> && git push origin v0.5.0`
2. release.yml runs: 3-image matrix build + push
3. post-release-smoke.yml runs against canary
4. On smoke fail: auto issue created; release notes not published; tag re-cut as v0.5.1

### Stage 5 — Public availability (Week 2+)

**Entry:** v0.5.0 tagged, smoke passed
**Duration:** 30 days observation
**Exit:** retrospective

**Public actions:**
- Merge `docs/UPGRADE-v0.5.0.md`
- GitHub Release notes: features, migrations, upgrade link, known limits (web arm64 dropped)
- New issue labels: `cost-budget`, `facet-extraction`, `v0.5.0`

**Abort conditions:**
- 3+ deployers report same critical bug in 24h → pin issue + hotfix v0.5.1
- Migration incompatibility found → pin `DO NOT UPGRADE` notice, ship v0.5.1

### Stage 6 — 30-day retrospective

**Entry:** v0.5.0 public 30 days
**Output:** `.claude/plans/2026-05-24-plan-4c-retrospective.md`

**Review:**
- Alert rule true / false positive ratios
- Facet signal impact on scores (with vs without, same member)
- Deployer adoption (issues / discussions)
- Cost dashboard utility (any user feedback)
- Seed for next plan (4D email, Theme C, or otherwise)

---

## 14. Open items and known limitations

Intentionally deferred from Plan 4C (tracked for future plans):

1. **LLM facet backfill** — historical bodies before v0.5.0 never get facets extracted. Admin UI to trigger selective backfill is a future P2 item.
2. **Facet prompt versioning automation** — bumping `CURRENT_PROMPT_VERSION` is manual code change. No UI to view facet-by-version breakdown.
3. **Per-section LLM commentary** — deep analysis narrative remains whole-report. Split is Theme C (future plan).
4. **CSV / PDF export** — reports still JSON only (Theme C).
5. **Rubric formal versioning** — v2 is an UPDATE in place. Future plan could introduce semantic `rubric_version` column with history tracking.
6. **Email notifications** — no GDPR / cost / report emails. Reserved for future Plan 4D.
7. **Cost dashboard for members** — only admin sees costs. Member view not in scope.
8. **Fine-grained ledger queries** — no UI to browse `llm_usage_events` detail. Admin can query via psql if needed.

Inherited from Plan 4B handoff (technical debt still valid):

- SettingsForm Zod resolver (being fixed in §10.1)
- tRPC onError logger at warn level (optional fix)
- `evaluatorQueue` dedicated Redis connection (not addressed in 4C)
- `noiseFilters` flattened shape (not addressed)

---

## 15. Reference files

**Handoff doc:** `.claude/plans/2026-04-24-plan-4c-handoff.md`

**Plan 4B:**
- `.claude/plans/2026-04-22-plan-4b-evaluator-design.md` (891 lines)
- `.claude/plans/2026-04-22-plan-4b-evaluator.md` (1157-line implementation plan)
- `.claude/plans/2026-04-22-plan-4b-handoff.md`

**Subsystem docs:**
- `docs/EVALUATOR.md`
- `docs/runbooks/evaluator-rollout.md`
- `templates/eval-standard.json` (CLI rubric source)

**To be created in Plan 4C:**
- `docs/UPGRADE-v0.5.0.md`
- `docs/runbooks/{evaluator-dlq,body-purge-lag,gdpr-sla,llm-budget,facet-extraction,evaluator-cron,facet-parse-errors,cost-ledger-mismatch}.md`
- `ops/grafana/{evaluator,body-capture,gdpr}.json`
- `ops/prometheus/alerts.yml`
- `ops/alertmanager/alertmanager.yml.example`
- `ops/canary-org.env.example`







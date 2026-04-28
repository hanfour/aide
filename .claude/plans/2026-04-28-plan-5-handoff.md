# Plan 5 Handoff — 2026-04-28

Plan 4C (cost budget + facet enrichment, v0.5.0 candidate) is on `main` but not
yet tagged. Use this doc to seed the Plan 5 brainstorming session.

## Repo state

- Working dir: `/Users/hanfourhuang/ai-dev-eval`
- Main branch: `main` at `4008c3b` (Plan 4C 18 parts + 6 follow-ups + landing
  page redesign all merged via squash; v0.5.0 NOT yet tagged)
- Latest tag: `v0.4.0` (released 2026-04-24T08:56:00Z)
- v0.5.0 release blocked on canary observation per
  `docs/UPGRADE-v0.5.0.md` (Stage 1 + Stage 3, ~14 days total)
- Migration set: 0000, 0001, 0002, 0003 (4A platform rubrics seed),
  0004 (4C cost infra), 0005 (4C facet table), 0006 (4C halt timestamp),
  0007 (4C platform rubric v1.1.0 with facet supports)
- Workspace tests: ~700 unit + integration; CI 6/6 jobs green on main
- Plan 4C feature flags: `ENABLE_EVALUATOR=false` (default),
  `ENABLE_FACET_EXTRACTION=false` (default); Plan 4B 4-layer gate still in place

## Plan 4C summary — what shipped to main

**Phase 1 (Parts 1-12, cost budget infrastructure)**:
- Per-org `llm_monthly_budget_usd` + degrade/halt overage modes
- `llm_usage_events` ledger (per-call cost + tokens + ref to ledger source)
- Cost dashboard at `/dashboard/organizations/[id]/evaluator/costs` + status-page widget
- 6 Prometheus metrics + 3 Grafana dashboards + 11 alert rules + 9 runbooks
- Post-release smoke workflow + SSE → StreamTranscript integration test
- Web Docker image dropped `linux/arm64` (QEMU instability)

**Phase 2 (Parts 13-18, LLM facet enrichment)**:
- `request_body_facets` table (one-to-one with request_bodies, cascade-delete)
- Facet extractor + ensureFacets batch runner
- Gateway-side writers: facetWriter, facetCache, facetLlmClient, bodyToFacetSession
- 6 facet aggregator signals + rule-engine dispatch
- env flag `ENABLE_FACET_EXTRACTION` + per-org `llm_facet_enabled` + `llm_facet_model`

**Follow-ups #1-#6 (post-Phase merge)**:
- #1 wire ensureFacets into runEvaluation (the actual production path)
- #6 `organizations.llm_halted_at` column (cheap halt short-circuit)
- #5 E2E spec locking facet/cost UI surfaces
- #3 report-page facet drill-down card
- #4 facet signals in custom rubrics (rubric editor reference + engine dispatch)
- #2 platform rubric v1.0.0 → v1.1.0 with additive facet supports

## What this handoff exists for

The Plan 4C work is solid for an Anthropic-only future. Plan 5's question is:
**how do we generalise the gateway to support multi-provider upstream
accounts (Anthropic, OpenAI, Google Gemini, ...) without breaking the
Plan 4A scheduler / Plan 4B evaluator / Plan 4C cost+facet plumbing?**

User's concrete need (2026-04-28): internal R&D team wants to share an
OpenAI API key (sk-proj-...) the same way they share Claude OAuth bundles
or sk-ant- keys. Codex CLI uses `auth_mode: "apikey"` (verified on host;
no OAuth) so "Codex sub2api" reduces to "OpenAI sk-key as upstream".

User explicitly **out of scope**: payment systems (EasyPay, Alipay, WeChat,
Stripe), iframe embedding, public Sub2API platform features. aide remains an
internal team tool.

## Current Anthropic coupling — files to review

These are the concrete coupling points Plan 5 must abstract:

| File | Line | Coupling |
|------|------|----------|
| `apps/gateway/src/runtime/oauthRefresh.ts` | 14-15 | Hardcoded `DEFAULT_CLIENT_ID = "9d1c..."` + `DEFAULT_TOKEN_URL = "https://api.anthropic.com/oauth/token"` |
| `apps/gateway/src/routes/chatCompletions.ts` | 65 | `translateOpenAIToAnthropic(body)` — every `/v1/chat/completions` request gets converted to Anthropic shape and dispatched to Anthropic upstream regardless of `account.platform` |
| `apps/gateway/src/routes/chatCompletions.ts` | 87+ | `runFailover` + `callUpstreamMessages` always assume Anthropic API surface |
| `apps/gateway/src/runtime/usageLogging.ts` | 134, 258 | `platform: "anthropic" \| "openai"` typed (good; only anthropic populated currently) |
| `packages/db/src/schema/accounts.ts` | (existing) | `platform: text` — schema is open; runtime is closed |
| `packages/evaluator/src/llm/pricing.ts` | full file | Only `claude-opus-4-7` / `claude-sonnet-4-6` / `claude-haiku-4-5`; no OpenAI / Gemini |
| `packages/evaluator/src/signals/cacheReadRatio.ts` | (existing) | Anthropic-specific (cache_read_input_tokens) |
| `packages/evaluator/src/signals/extendedThinking.ts` | (existing) | Anthropic-specific |
| `packages/evaluator/src/facet/promptBuilder.ts` | full file | Prompt designed for Claude's instruction-following style; not validated on OpenAI / Gemini |

## Proposed Plan 5 phases

### Phase 5A — OpenAI provider (priority)

Goal: ship OpenAI sk-key support as a first-class upstream account type.

- New `apps/gateway/src/providers/` directory with `types.ts`, `anthropic.ts`
  (extracted from existing logic), `openai.ts` (new)
- `UpstreamProvider` interface: `callUpstream`, `extractUsage`, `pricing`,
  `supportedRoutes`, optional `refreshOAuth`
- `runFailover` dispatches by `account.platform`; cross-provider failover
  rejected (model incompatible)
- `/v1/chat/completions` route: when `account.platform === "openai"` →
  forward natively; when `anthropic` → keep existing translate path
- `/v1/messages` route: when `account.platform === "anthropic"` → existing;
  when `openai` → translate Anthropic→OpenAI shape (or reject if a flag
  `ALLOW_CROSS_SHAPE_TRANSLATE=false`)
- `pricing.ts`: add OpenAI models (gpt-4o, gpt-4-turbo, o1, o1-mini, etc.)
- Rubric signal classification: tag each signal `provider: "any" | "anthropic" | "openai"`
  so editors / runtime know which signals work where
- Migration 0008: seed `llm_models` reference table (model → provider mapping)
  if needed; or hardcode in pricing.ts
- Tests: provider abstraction unit tests, failover-rejection tests,
  cross-shape translation tests

### Phase 5B — Gemini provider

Smaller scope. Gemini API uses different shape than both Anthropic and
OpenAI; Google AI Studio uses API key only (no OAuth in current spec).

- `apps/gateway/src/providers/gemini.ts`
- Add `/v1/messages` translation for Gemini upstream (or just `/v1/chat/completions`)
- Pricing: Gemini Pro, Gemini Flash
- Adopt the abstraction shape from 5A

### Phase 5C — Anthropic OAuth refactor

Refactor-only. Move `oauthRefresh.ts` into the Anthropic provider plugin so
new OAuth providers (if any) can implement their own refresh logic. No new
features.

### Out of scope for Plan 5

These would be follow-up plans, not part of 5:
- Per-user token rate limit (currently per-account only)
- Per-user monthly budget (currently per-org only)
- Multi-provider sticky session orchestration (depends on Plan 5 design)
- LLM facet prompt re-tuning for OpenAI/Gemini (calibration exercise, not new code)
- Cross-provider model aliasing (e.g. "fast" → claude-haiku OR gpt-4o-mini)

## Pre-brainstorm questions for the user

Before writing the Plan 5 design spec, answer these:

1. **Phase ordering** — my bias: 5A (OpenAI) first, then 5C (Anthropic
   OAuth refactor), then 5B (Gemini). 5A unblocks the immediate ask;
   5C gives clean abstraction; 5B is "nice to have" once two providers
   exist. Agree, or different order?

2. **Sticky session scope** — Plan 4A has sticky session (same conversation
   → same upstream account when possible). Cross-provider sticky is
   meaningless because models differ. Two options:
   - (a) Sticky scoped by provider: per-user × per-conversation-id × per-provider
   - (b) First-message determines provider for the whole conversation
   - (c) Sticky concept retired, every request re-schedules
   
   Which is the right user-facing semantics?

3. **Rubric signal compatibility flagging** — `cache_read_ratio`,
   `cache_creation_tokens`, `extended_thinking_used` are Anthropic-only.
   When a custom rubric uses these against an org with OpenAI-only
   accounts, what should happen?
   - (a) Silent no-op (signal returns hit:false; section may degrade to standard)
   - (b) Loud error at rubric save time (admin sees "this signal incompatible")
   - (c) Editor warns at compose time but allows save
   
   I lean (c) — but it requires plumbing the per-org provider mix back into
   the editor.

4. **Cross-shape translation policy** — when an `/v1/messages` request comes
   in but only OpenAI accounts are available (or scheduler routes there
   anyway):
   - (a) Translate Anthropic→OpenAI shape (mirror current OpenAI→Anthropic)
   - (b) Reject with "no compatible upstream"
   - (c) Configurable env flag

5. **Failover boundary** — current `runFailover` retries up to N accounts
   if one fails. Across providers: should failover STAY within the same
   provider (model continuity) or span all providers (availability)?
   - (a) Same provider only (recommended; predictable model behaviour)
   - (b) Cross-provider (fallback Anthropic→OpenAI), with caller's request
     possibly getting a different shape back
   - (c) Per-API-key flag: user opts in to cross-provider via a setting

6. **Cost ledger row attribution** — `llm_usage_events.event_type` currently
   `facet_extraction | deep_analysis`. With multi-provider, do we need to
   add `model_provider` as a separate label, or rely on the existing `model`
   field for grouping (e.g. `gpt-4o` is implicitly OpenAI)?

7. **OpenAI organization ID** — OpenAI API supports `OpenAI-Organization`
   header to scope billing. Should `upstream_accounts` schema get an optional
   `organization_id` text field for OpenAI accounts (and other provider-specific
   metadata)? Or is per-key org assignment fine for v1?

8. **Hard deadlines?** — any reason 5A needs to ship by date X? Or is this
   "next plan after v0.5.0 ships"?

## Reference files

- `.claude/plans/2026-04-22-plan-4b-evaluator-design.md` (Plan 4B design)
- `.claude/plans/2026-04-24-plan-4c-design.md` (Plan 4C design — model for Plan 5 spec)
- `.claude/plans/2026-04-24-plan-4c-implementation.md` (Plan 4C implementation
  plan — model for Plan 5 implementation breakdown)
- `.claude/plans/2026-04-24-plan-4c-handoff.md` (Plan 4C handoff that seeded
  the brainstorming — this doc mirrors that format)
- `docs/GATEWAY.md` (existing gateway operator + user reference)
- `docs/UPGRADE-v0.5.0.md` (Plan 4C upgrade playbook with the deferred 4D items)

## Suggested resume prompt for next session

```
讀 .claude/plans/2026-04-28-plan-5-handoff.md
挑 Plan 5 phase 後開始 brainstorm + 寫 design spec。
我傾向 5A 先（OpenAI provider）。先回答 8 個 pre-brainstorm 問題。
```

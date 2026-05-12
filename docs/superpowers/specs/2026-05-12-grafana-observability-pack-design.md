# Grafana Observability Pack — Caliber rebrand + portability

**Date:** 2026-05-12
**Closes:** GitHub issue #124
**Risk class:** Low — pure config + docs. No runtime code, no persisted state. Operator-side restart of Grafana is the only side-effect.

## Goal

Migrate the three `ops/grafana/*.json` dashboards from the original `aide-*` brand to `caliber-*` AND ship them as a self-contained, third-party-portable observability pack that any operator running Caliber can drop into their Grafana with one volume mount + restart. The pack must:

1. Use Grafana datasource templating so operators with non-standard Prometheus datasource UIDs can import without editing JSON.
2. Provide an `org_id` filter on every dashboard where the underlying metrics carry that label.
3. Group all three dashboards under a `Caliber` folder via provisioning.
4. Drop the internal `plan-4c` milestone tag in favor of a public-meaningful taxonomy (`caliber`, `gateway`, scope).
5. Preserve the old `aide-*` UIDs as one-panel deprecation stubs so existing operator bookmarks redirect cleanly instead of 404-ing.
6. Ship a bilingual (zh-TW + EN) README plus a Grafana provisioning manifest so adoption is "mount + restart".

## Non-goals

- Not extracting to a separate npm package — premature productization for a 6-file directory.
- Not adding annotations, alerts, or new panels — pure portability + rebrand.
- Not changing the Prometheus alert rules (already handled by PR #128) or the gateway code that emits metrics.

## Architecture

### File layout

```
ops/grafana/
├── README.md                           (NEW — bilingual zh-TW + EN)
├── provisioning/
│   └── dashboards.yaml                 (NEW — Grafana provisioning manifest)
├── aide-body-capture.json              (deprecation stub, UID: aide-body-capture)
├── aide-evaluator.json                 (deprecation stub, UID: aide-evaluator)
├── aide-gdpr.json                      (deprecation stub, UID: aide-gdpr)
├── caliber-body-capture.json           (FULL panels, UID: caliber-body-capture)
├── caliber-evaluator.json              (FULL panels, UID: caliber-evaluator)
└── caliber-gdpr.json                   (FULL panels, UID: caliber-gdpr)
```

The original `body-capture.json` / `evaluator.json` / `gdpr.json` files are renamed (git rename) to `caliber-body-capture.json` / `caliber-evaluator.json` / `caliber-gdpr.json`, then edited in place. The three `aide-*.json` are new files (the stubs).

### Per-dashboard JSON rewrite rules (applied to each `caliber-*.json`)

1. **UID**: `aide-foo` → `caliber-foo`
2. **Title**: `AIDE — Foo` → `Caliber — Foo`
3. **Tags**: `["aide", "<scope>", "plan-4c"]` → `["caliber", "gateway", "<scope>"]` where `<scope>` is `body-capture` / `evaluator` / `gdpr`
4. **Folder pinning**: add `"folderUid": "caliber"` and `"folderTitle": "Caliber"` at the dashboard root
5. **Datasource templating**: prepend to `templating.list[]`:

```json
{
  "name": "datasource",
  "label": "Data source",
  "type": "datasource",
  "query": "prometheus",
  "current": { "selected": false, "text": "default", "value": "default" },
  "hide": 0,
  "refresh": 1,
  "regex": "",
  "skipUrlSync": false
}
```

The `default` value uses Grafana's built-in alias that resolves to whichever Prometheus datasource the operator has marked as default. This is the lowest-friction setup for first-time importers.

6. **Panel datasource refs**: every `"datasource": { "type": "prometheus", "uid": "prometheus" }` (~ 30 occurrences across 3 files) → `"datasource": { "type": "prometheus", "uid": "${datasource}" }`.

7. **`org_id` template variable** — only on `evaluator.json` (where it already exists). Verified against `apps/gateway/src/plugins/metrics.ts`:
   - `gw_llm_cost_usd_total`, `gw_facet_extract_total`, `gw_facet_extract_duration_ms`, `gw_facet_cache_hit_total` carry `org_id`
   - `gw_body_*`, `gw_eval_llm_{called,cost_usd,failed,parse_failed}_total`, `gw_eval_dlq_count`, `gw_gdpr_*` do NOT carry `org_id`

   Therefore the spec's earlier proposal to add `org_id` to `body-capture.json` and `gdpr.json` is dropped — there is no metric in those dashboards that supports the filter. Adding the variable would render a non-functional empty dropdown. If a future change adds `org_id` to gateway / GDPR metrics, the variable can be added then.

8. **Panel PromQL `{org_id=~"$org_id"}` filter**: applied only to panels in `caliber-evaluator.json` whose metric carries `org_id`. Specifically:
   - "Facet extraction by result", "Facet duration heatmap", "Facet cache hit rate" → add filter
   - "LLM spend this month by org", "Top 5 spenders (30d)" → already filter via `sum by (org_id) (...)`; preserve existing exprs
   - "Job rate completed/failed", "Parse failures", "Failed by reason", "DLQ depth", "Evaluator LLM cost (USD/hour)" → no `org_id` label on those metrics, do NOT add filter

9. **`version` field**: bump from `1` to `2` on each rewritten file.

### Deprecation stub template (each `aide-*.json`)

Single text panel pointing operators at the new UID. Keep the old UID so bookmarks resolve. Mark `editable: false` so operators don't accidentally edit the stub.

```json
{
  "annotations": { "list": [] },
  "editable": false,
  "graphTooltip": 0,
  "panels": [
    {
      "id": 1,
      "type": "text",
      "title": "",
      "gridPos": { "h": 12, "w": 24, "x": 0, "y": 0 },
      "options": {
        "mode": "markdown",
        "content": "# This dashboard has moved\n\nThe `aide-*` dashboards are deprecated as part of the aide → Caliber rebrand.\n\n**Open the new dashboard:** [Caliber — Body Capture](/d/caliber-body-capture)\n\nThis redirect will be removed in a future cleanup PR once operators have migrated their bookmarks."
      }
    }
  ],
  "refresh": "",
  "schemaVersion": 39,
  "tags": ["aide", "deprecated"],
  "templating": { "list": [] },
  "time": { "from": "now-6h", "to": "now" },
  "timepicker": {},
  "timezone": "utc",
  "title": "AIDE — Body Capture (deprecated, see /d/caliber-body-capture)",
  "uid": "aide-body-capture",
  "version": 2,
  "weekStart": ""
}
```

The link target in `content` and the `title` change per dashboard (`/d/caliber-evaluator`, `/d/caliber-gdpr`).

### `ops/grafana/provisioning/dashboards.yaml`

```yaml
# Grafana dashboard provisioning manifest for the Caliber Observability Pack.
# Mount this at /etc/grafana/provisioning/dashboards/caliber.yaml and the JSON
# dashboards at /etc/grafana/provisioning/dashboards/caliber/. See ../README.md
# for full setup.

apiVersion: 1

providers:
  - name: caliber
    orgId: 1
    folder: Caliber
    folderUid: caliber
    type: file
    disableDeletion: false
    updateIntervalSeconds: 30
    allowUiUpdates: true
    options:
      path: /etc/grafana/provisioning/dashboards/caliber
      foldersFromFilesStructure: false
```

`allowUiUpdates: true` permits operator UI edits without the provisioner overwriting them at the next reload. `disableDeletion: false` lets `git rm` of a JSON file propagate to dashboard removal in Grafana — needed for the eventual Phase 4c cleanup that removes the aide-* stubs.

### `ops/grafana/README.md`

Bilingual (EN first, zh-TW immediately following). Contains, in order:

1. **Title + tagline**: "Caliber Observability Pack / Caliber 可觀測性套件"
2. **What's in here**: 3-row table mapping dashboard → UID → what-it-shows (EN + zh-TW in one cell)
3. **Prerequisites**: Prometheus scraping `/metrics`, Grafana 10+, a registered Prometheus datasource
4. **Install — Option A: File provisioning (recommended)**: docker-compose snippet showing the two volume mounts
5. **Install — Option B: UI import**: dashboard → import → paste JSON → pick datasource
6. **Required metrics**: bullet list of every `gw_*` metric referenced (see "Required metrics" section below)
7. **Panel ↔ Metric mapping**: per-dashboard table with panel title, PromQL expression, and notes
8. **Customization**: datasource dropdown, org_id dropdown, time picker
9. **Aide → Caliber migration**: explains the aide-* stubs and that they're tracked for removal in #129 follow-up
10. **Versioning**: bump policy for the `version` field
11. **Contributing**: PR workflow (open in Grafana → JSON Model → paste back → bump version)
12. **License**: inherits from parent project

All headings are bilingual: `## Install / 安裝`. Code blocks and tables are EN-canonical with bilingual cell content where appropriate.

## Required metrics

The pack assumes the Caliber gateway emits the following Prometheus metrics. Missing metrics cause empty panels (not fatal errors).

**Body capture:**
- `gw_body_capture_enqueued_total{result}` — capture-rate counter with result label (`success` / `failed`)
- `gw_body_purge_lag_hours` — gauge of the oldest overdue purge row, in hours
- `gw_body_purge_deleted_total` — counter of rows deleted by the purge cron
- `gw_body_purge_duration_seconds_bucket` — histogram of purge tick durations

**Evaluator:**
- `gw_eval_llm_called_total{result}` — evaluator LLM calls counter
- `gw_eval_llm_failed_total{reason}` — failure counter with reason label
- `gw_eval_llm_parse_failed_total` — JSON / schema parse failures
- `gw_eval_dlq_count` — current DLQ depth gauge
- `gw_eval_llm_cost_usd_total` — cumulative cost counter
- `gw_facet_extract_total{result}` — facet extraction counter (Phase 2)
- `gw_facet_extract_duration_seconds_bucket` — facet duration histogram
- `gw_facet_cache_hit_total{result}` — facet cache hit/miss counter
- `gw_llm_cost_usd_total{org_id}` — cost-per-org (used in the per-org filter on the cost panel)

**GDPR:**
- `gw_gdpr_delete_executed_total` — executions counter
- `gw_gdpr_bodies_deleted_total` / `gw_gdpr_reports_deleted_total` — per-table delete counters
- `gw_gdpr_auto_rejected_total` — auto-rejected (SLA expiry) counter
- `gw_gdpr_failures_total` — executor failure counter

The `org_id` label is expected on metrics that scope by tenant (cost, GDPR failures). The `body-capture` metrics may or may not carry `org_id` depending on the emitter — implementation will verify per metric and apply the `{org_id=~"$org_id"}` filter only where the label exists.

## Panel ↔ Metric mapping (canonical reference, written into README)

### Caliber — Body Capture

| Panel | PromQL (current) | Notes |
|---|---|---|
| Capture rate (per result) | `sum by (result) (rate(gw_body_capture_enqueued_total[5m]))` | + `{org_id=~"$org_id"}` if labeled |
| Capture rate (total) | `sum(rate(gw_body_capture_enqueued_total[5m]))` | matches stack overlay |
| Purge lag (hours) | `gw_body_purge_lag_hours` | gauge |
| Bytes deleted by purge (rate) | `sum(rate(gw_body_purge_deleted_total[1h]))` | rows/sec |
| Purge tick duration p50 | `histogram_quantile(0.50, sum by (le) (rate(gw_body_purge_duration_seconds_bucket[1h])))` | |
| Purge tick duration p99 | `histogram_quantile(0.99, sum by (le) (rate(gw_body_purge_duration_seconds_bucket[1h])))` | |

### Caliber — Evaluator

| Panel | PromQL (current) | Notes |
|---|---|---|
| Job rate — completed | `sum(rate(gw_eval_llm_called_total{result="ok"}[5m]))` | |
| Job rate — failed | `sum(rate(gw_eval_llm_failed_total[5m]))` | |
| Parse failures | `sum(rate(gw_eval_llm_parse_failed_total[5m]))` | |
| Failed by reason | `sum by (reason) (rate(gw_eval_llm_failed_total[5m]))` | |
| DLQ depth | `gw_eval_dlq_count` | gauge |
| Evaluator LLM cost (USD/hour) | `sum(rate(gw_eval_llm_cost_usd_total[1h])) * 3600` | unit conversion in display |
| Facet extraction by result | `sum by (result) (rate(gw_facet_extract_total[5m]))` | Phase 2 |
| Facet duration heatmap | `sum by (le) (rate(gw_facet_extract_duration_seconds_bucket[5m]))` | |
| Facet cache hit rate | `sum(rate(gw_facet_cache_hit_total{result="hit"}[5m])) / clamp_min(sum(rate(gw_facet_cache_hit_total[5m])), 0.0001)` | percentage |
| LLM spend this month by org | `sum by (org_id) (increase(gw_llm_cost_usd_total[30d]))` | `{org_id=~"$org_id"}` filter |
| Top 5 spenders (30d) | `topk(5, sum by (org_id) (increase(gw_llm_cost_usd_total[30d])))` | |

### Caliber — GDPR

| Panel | PromQL (current) | Notes |
|---|---|---|
| Delete executions (rate) | `sum(rate(gw_gdpr_delete_executed_total[1h]))` | |
| Bodies deleted | `sum(rate(gw_gdpr_bodies_deleted_total[1h]))` | |
| Reports deleted | `sum(rate(gw_gdpr_reports_deleted_total[1h]))` | |
| Auto-rejected requests | `sum(rate(gw_gdpr_auto_rejected_total[24h]))` | |
| Failures (rate) | `sum(rate(gw_gdpr_failures_total[1h]))` | + `{org_id=~"$org_id"}` if labeled |

## Operator upgrade

After merging this PR, operator runs (one-time):

1. **Mount the pack** in your `docker-compose.yml` (or equivalent):
   ```yaml
   grafana:
     volumes:
       - ./ops/grafana:/etc/grafana/provisioning/dashboards/caliber:ro
       - ./ops/grafana/provisioning/dashboards.yaml:/etc/grafana/provisioning/dashboards/caliber.yaml:ro
   ```
2. `docker compose restart grafana` (or `kill -HUP` for non-Docker setups)
3. Verify: open Grafana, expect a new `Caliber` folder with 6 dashboards (3 caliber-* full + 3 aide-* deprecation stubs)
4. (Optional) Update personal bookmarks from `/d/aide-*` → `/d/caliber-*`. The stubs handle the redirect for now.

Existing operators with bookmarked `aide-*` URLs see the deprecation panel with a one-click link to the new dashboard — no 404.

## Verification (implementation-time checks)

After implementation, run these from repo root before commit:

```bash
# 1. JSON valid on all 6 dashboard files
for f in ops/grafana/{aide,caliber}-*.json; do
  python3 -c "import json; json.load(open('$f'))" && echo "$f OK"
done

# 2. UID matches filename
for f in ops/grafana/{aide,caliber}-*.json; do
  uid=$(python3 -c "import json; print(json.load(open('$f'))['uid'])")
  base=$(basename "$f" .json)
  [ "$uid" = "$base" ] && echo "$f UID OK" || (echo "$f UID MISMATCH: $uid" && exit 1)
done

# 3. Caliber dashboards have folderUid: caliber
for f in ops/grafana/caliber-*.json; do
  python3 -c "import json; d=json.load(open('$f')); assert d['folderUid'] == 'caliber', '$f missing folderUid'"
done

# 4. Tag taxonomy: every caliber-* has 'caliber' and 'gateway' tags
for f in ops/grafana/caliber-*.json; do
  python3 -c "import json; d=json.load(open('$f')); assert 'caliber' in d['tags'] and 'gateway' in d['tags'], '$f wrong tags: ' + str(d['tags'])"
done

# 5. Datasource templating variable present on every caliber-*
for f in ops/grafana/caliber-*.json; do
  python3 -c "import json; d=json.load(open('$f')); vars=[v['name'] for v in d['templating']['list']]; assert 'datasource' in vars, '$f missing datasource var'"
done

# 6. No hardcoded "uid": "prometheus" remains in caliber-* (datasource refs must use ${datasource})
grep -l '"uid": "prometheus"' ops/grafana/caliber-*.json && (echo "FAIL: hardcoded datasource in caliber-*" && exit 1) || echo "OK: no hardcoded datasource"

# 7. provisioning YAML parses
python3 -c "import yaml; yaml.safe_load(open('ops/grafana/provisioning/dashboards.yaml'))"

# 8. Aide stubs have exactly 1 panel of type text
for f in ops/grafana/aide-*.json; do
  python3 -c "import json; d=json.load(open('$f')); assert len(d['panels'])==1 and d['panels'][0]['type']=='text', '$f stub shape wrong'"
done

# 9. Aide stubs reference the matching caliber UID in markdown
for stub in body-capture evaluator gdpr; do
  grep -q "/d/caliber-$stub" "ops/grafana/aide-$stub.json" || (echo "aide-$stub.json missing caliber redirect" && exit 1)
done

# 10. README is bilingual (sanity: contains both 'Install' and '安裝')
grep -q "Install" ops/grafana/README.md && grep -q "安裝" ops/grafana/README.md && echo "bilingual OK"
```

All ten gates must pass before commit. No live Grafana smoke test is in scope for this PR — the verification is offline-checkable.

## Rollback

Pure config + docs. Revert the merge commit; re-deploy provisioning; Grafana auto-removes the new dashboards (because `disableDeletion: false`). The `aide-*.json` deprecation stubs revert back to the original full dashboards via git revert. No data loss anywhere — Grafana state is regenerated from disk on every reload.

## Follow-up issue (opened when this PR opens)

**Title**: `Phase 4c cleanup: drop Grafana aide-* deprecation stubs`

**Blocked by**: T+30 days from this PR's merge, OR explicit operator confirmation that bookmarks have been migrated.

**Acceptance**:
- [ ] Delete `ops/grafana/aide-body-capture.json`, `aide-evaluator.json`, `aide-gdpr.json`
- [ ] Remove the "Aide → Caliber migration" section from `ops/grafana/README.md`
- [ ] Verify in operator's Grafana that no dashboard or bookmark still references aide-* UIDs

**Labels**: `rebrand`, `cleanup`, `blocked`

## Self-review

- **Placeholder scan:** none. The two `<seed_metric>` slots in the org_id variable definition are explicit ("pick the metric known to carry org_id at implementation time"); the plan-side execution will choose the concrete metric per dashboard from the metrics list.
- **Internal consistency:** file layout, JSON change rules, deprecation stub template, README structure, verification gates, and rollback all reference the same six files. Tag taxonomy `[caliber, gateway, scope]` mentioned in section "Per-dashboard JSON rewrite rules" matches the verification gate #4.
- **Scope check:** single bundled PR. Same shape as PR #128 (Phase 4a bundle) — config + docs only, no runtime risk.
- **Ambiguity check:** the "apply `{org_id=~"$org_id"}` only where the metric carries the label" rule is the one place execution has to make a per-metric judgment call. Implementation will resolve by reading the gateway metrics module (`apps/gateway/src/plugins/metrics.ts` or similar) and only adding the filter for metrics whose registration includes an `org_id` label. Documented explicitly in section 8.
- **Commercialization fit:** README is bilingual (zh-TW + EN), the provisioning manifest is a standard Grafana pattern, the datasource templating uses Grafana's `default` alias for zero-config first-import, and `plan-4c` (internal milestone) is replaced with a public taxonomy. Third-party operators can adopt the pack with one volume mount + restart, which is the stated goal.

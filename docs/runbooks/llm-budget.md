# LLMBudgetWarning / LLMBudgetExceeded

## Severity
info (warn) | warning (exceeded)

## Symptoms
- `gw_llm_budget_warn_total` ticks (org crossed 80% of monthly budget).
- `gw_llm_budget_exceeded_total{behavior="degrade"}` or `{behavior="halt"}` ticks.
- Org admins report missing deep-analysis output (degrade) or all evaluator features blocked (halt).
- Cost dashboard widget on the org status page shows >=80% of budget consumed.

## Likely causes
1. Organic growth — org's traffic increased and they need a higher monthly budget.
2. New feature/integration started flooding evaluator with eval-eligible jobs.
3. Pricing miss (`gw_pricing_miss_total`) caused under-counting earlier; a bulk reprice corrected the ledger upward.
4. A misconfigured rubric is forcing every request through deep analysis.

## Diagnosis commands

```bash
# Current month spend per org
curl -s http://gateway:3002/metrics | grep gw_llm_cost_usd_total | head -20

# Budget config from DB
psql "$DATABASE_URL" -c "
  SELECT id, name, llm_monthly_budget_usd, llm_budget_overage_behavior
  FROM organizations
  WHERE llm_monthly_budget_usd IS NOT NULL
  ORDER BY llm_monthly_budget_usd DESC LIMIT 20;
"

# Top spenders this month from the ledger
psql "$DATABASE_URL" -c "
  SELECT org_id, event_type, model, SUM(cost_usd) AS spend
  FROM cost_ledger
  WHERE occurred_at >= date_trunc('month', NOW())
  GROUP BY org_id, event_type, model
  ORDER BY spend DESC LIMIT 20;
"
```

## Resolution steps
1. Open the org's `/dashboard/organizations/[id]/cost` page and confirm the spend matches what the ledger reports.
2. For warn: notify the org's billing contact via the standard customer-success workflow. No action required from ops.
3. For exceeded (degrade): confirm the org still gets rule-based evaluation; no immediate action unless customer escalates.
4. For exceeded (halt): the org has chosen to halt by config. If they need an emergency lift, an admin can edit `llm_monthly_budget_usd` for the current month.
5. After raising budget, the next ledger insert will clear the alert (no manual reset needed).

## Escalation
- If `gw_llm_budget_exceeded_total{behavior="halt"}` fires for a paying customer, page customer success within 1 business hour.
- If `gw_pricing_miss_total` correlates with the spike, escalate to platform-eng — the pricing table is stale.

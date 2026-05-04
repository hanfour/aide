# Local deploy handoff — start here next session

**Goal**: Stand up aide on the operator's laptop following
[`docs/LOCAL_DEPLOY.md`](../../docs/LOCAL_DEPLOY.md), starting at Mode
1 (pure local evaluation, ~5 min) and escalating as the operator
chooses.

This session ends with `docs/LOCAL_DEPLOY.md` + 16 PRs already merged
to main; the next session opens with the operator running commands on
their machine and the assistant in co-pilot mode.

## How to start the next session

```
讀 .claude/plans/2026-05-04-local-deploy-handoff.md。
我要按 docs/LOCAL_DEPLOY.md 跑本機部署。Mode 1。我已經在 aide
repo 根目錄了，剛 git pull 完。
```

Or jump straight in by pasting your first command's output.

## What's on main right now

15 PRs across 4 themes, all merged 2026-05-04:

| Theme | PRs | What it covers |
|---|---|---|
| API-key migration features | #52, #53, #55, #56, #57, #59 | OpenAI api_key onboarding, accountGroups admin CRUD, log redaction, RPM rate limit, response cache |
| Plan progress | #54, #58, #60 | Migration plan tracking |
| Deploy readiness | #61, #63 | Compose env passthrough + cloud deploy templates (Render / Fly / Railway / Vercel-not-supported) |
| Operations | #62, #64, #65 | 4 production runbooks, Prometheus alerts, reverse proxy configs, cache + rate-limit metrics |

Plus this session's docs PR (#66 or whatever number it lands as) —
`docs/LOCAL_DEPLOY.md` covering the 3 local-deploy modes.

## Co-pilot deployment — how the assistant should behave

The user is running commands on their own machine. The assistant
cannot SSH there or execute on their behalf. Useful patterns:

1. **Be patient between checkpoints.** Each command may take 30s–2min
   to run; let the user paste output.
2. **Read errors precisely.** Most pitfalls are docs-known — refer
   the user to the right `LOCAL_DEPLOY.md` § or runbook.
3. **Generate secrets when asked.** `openssl rand -base64 48` is the
   canonical AUTH_SECRET pattern; `openssl rand -hex 32` for the two
   gateway-side secrets. Don't actually run them locally — explain
   the user runs them on their machine and pastes the result into
   `.env`.
4. **Don't push code unless the user asks.** This session ended on
   "deploy from current main" — code changes need a clear trigger
   (a real bug surfacing, an unmet requirement).
5. **Don't open PRs without explicit ask.** Same reason.
6. **If the user reports a bug**, treat it as evidence to fix in a
   new branch — but checkpoint before opening the PR. The user might
   want to test the fix locally first.

## Likely first-session pitfalls + what to look for

These are the docs-known traps in `LOCAL_DEPLOY.md` Mode 1:

| Symptom | Cause | Fix |
|---|---|---|
| `migrate` container exits 1 | Postgres not yet healthy or `DATABASE_URL` typo | Wait 10s, re-run `docker compose up -d migrate`. If persistent, `docker compose down -v` (destroys data) and start clean |
| OAuth callback error after sign-in | Redirect URL on Google/GitHub doesn't match `NEXTAUTH_URL` | Re-register the app's redirect URI; both providers allow `http://localhost:3000/...` for development |
| `ENV: AUTH_SECRET must be ≥32 chars` on web boot | User pasted an empty or short value | Re-run `openssl rand -base64 48`, paste verbatim into `.env`, restart web |
| Gateway 503 on first request | No upstream account onboarded yet | Mode 2 step 2 — admin UI walkthrough |
| `x-ratelimit-remaining` always at 600 | RPM limit isn't engaging — could be Redis flake or `GATEWAY_APIKEY_RPM_LIMIT=0` | Check `gw_rate_limit_fail_open_total` metric; check env value |

If a NEW pitfall surfaces (not in `LOCAL_DEPLOY.md` §Troubleshooting),
the natural next action is to add it to the doc as a follow-up PR.

## Out-of-scope reminders

These aren't blockers for local deploy and should not be tackled in
the deploy session:

- **Phase 2** (ChatGPT Team / Enterprise admin API integration) —
  deferred until external customer trigger. Don't propose research.
- **Helm chart** — separate plan, not started.
- **5b branch** (`feat/plan-5a-pr5b-oauth-callback-flow`) — local
  abandoned branch, calendar deletion ≈ 2026-05-18. The user's git
  may show it; ignore.

## When to end the next session

- The user signs in successfully + sees the dashboard → Mode 1 done.
- They onboard a real OpenAI key + the smoke-test curl returns 200
  with the expected headers → Mode 2 done.
- They report the stack auto-restarted cleanly after a reboot →
  Mode 3 done (or at least the systemd part).

After any of those checkpoints, the assistant should ask whether to
continue escalating modes or stop. Don't volunteer to continue
without confirmation.

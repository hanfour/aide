#!/usr/bin/env bash
# Plan 4A — gateway post-deploy smoke.
#
# Verifies a deployed gateway accepts real traffic end-to-end:
#
#   1. GET  ${GATEWAY_URL}/health   → 200 + {"status":"ok"}
#   2. GET  ${GATEWAY_URL}/metrics  → 200 + some `gw_` series
#   3. POST ${GATEWAY_URL}/v1/messages with a real API key → 200 + assistant
#      response shape
#   4. (optional) if DATABASE_URL is exported, psql assert that a usage_logs
#      row was written within the last 5 min for this key's prefix — catches
#      silent BullMQ worker drops
#
# Required env:
#   GATEWAY_URL — e.g. https://gateway.example.com  (no trailing slash)
#   API_KEY     — a self-issued or admin-issued platform key (`sk-aide-...`)
#
# Optional env:
#   MODEL         — Anthropic model slug (default: claude-3-haiku-20240307)
#   DATABASE_URL  — if set, run the psql assert step (needs `psql` on PATH)
#   CURL_OPTS     — extra curl flags (e.g. `--insecure` for self-signed dev)
#   TIMEOUT       — per-curl timeout seconds (default: 15)
#
# Exit codes:
#   0  all assertions passed
#   >0 first failing step; stderr shows the reason
#
# Usage:
#   GATEWAY_URL=https://gateway.example.com API_KEY=sk-aide-... \
#     ./scripts/smoke-gateway.sh
#
# Intended for the v0.3.0 release checklist (Plan 4A Part 13). Safe to run
# repeatedly — each invocation appends one row to usage_logs.

set -euo pipefail

# ── Config ──────────────────────────────────────────────────────────────────

: "${GATEWAY_URL:?GATEWAY_URL is required, e.g. https://gateway.example.com}"
: "${API_KEY:?API_KEY is required (sk-aide-...)}"

MODEL="${MODEL:-claude-3-haiku-20240307}"
TIMEOUT="${TIMEOUT:-15}"
CURL_OPTS="${CURL_OPTS:-}"

# Trim trailing slash from GATEWAY_URL so path concat stays clean.
GATEWAY_URL="${GATEWAY_URL%/}"

# ── Helpers ─────────────────────────────────────────────────────────────────

ok()    { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn()  { printf '  \033[33m!\033[0m %s\n' "$1" >&2; }
fail()  { printf '  \033[31m✗\033[0m %s\n' "$1" >&2; exit 1; }
step()  { printf '\n\033[1m%s\033[0m\n' "$1"; }

# Run curl, capture body + http status in one pass. Trailing `;` after
# `-w` prints status after a marker we can split on.
#
# Args: METHOD URL [-- extra curl args]
# Emits on stdout: <body>\n<<<HTTP_STATUS>>>\n<status>
http_call() {
  local method="$1"; shift
  local url="$1"; shift
  # shellcheck disable=SC2086
  curl --silent --show-error --max-time "${TIMEOUT}" ${CURL_OPTS} \
    -X "${method}" \
    -w '\n<<<HTTP_STATUS>>>\n%{http_code}' \
    "$@" \
    "${url}"
}

split_status() {
  # Reads the combined output from http_call on stdin, sets globals:
  #   SMOKE_BODY   — the response body (may be multi-line JSON)
  #   SMOKE_STATUS — HTTP status code (3 digits, string)
  local combined marker='<<<HTTP_STATUS>>>'
  combined="$(cat)"
  # Strip everything up to and including the marker to isolate the status.
  SMOKE_STATUS="${combined##*${marker}}"
  # Strip the marker and everything after it to isolate the body.
  SMOKE_BODY="${combined%${marker}*}"
  # Normalise: parameter stripping leaves leading/trailing newlines behind.
  SMOKE_STATUS="${SMOKE_STATUS//[[:space:]]/}"
  SMOKE_BODY="${SMOKE_BODY%$'\n'}"
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

require_cmd curl

# ── Step 1: /health ─────────────────────────────────────────────────────────

step "1/4  GET ${GATEWAY_URL}/health"
http_call GET "${GATEWAY_URL}/health" | split_status

if [[ "${SMOKE_STATUS}" != "200" ]]; then
  fail "health endpoint returned ${SMOKE_STATUS}; body: ${SMOKE_BODY}"
fi
if ! grep -q '"status":"ok"' <<<"${SMOKE_BODY}"; then
  fail "health endpoint did not report status=ok; body: ${SMOKE_BODY}"
fi
ok "health returned 200 status=ok"

# ── Step 2: /metrics ────────────────────────────────────────────────────────

step "2/4  GET ${GATEWAY_URL}/metrics"
http_call GET "${GATEWAY_URL}/metrics" | split_status

if [[ "${SMOKE_STATUS}" != "200" ]]; then
  fail "metrics endpoint returned ${SMOKE_STATUS}"
fi
if ! grep -q '^gw_' <<<"${SMOKE_BODY}"; then
  fail "metrics endpoint served 200 but emitted no gw_* series"
fi
ok "metrics returned 200 with gw_* series"

# ── Step 3: POST /v1/messages ───────────────────────────────────────────────

step "3/4  POST ${GATEWAY_URL}/v1/messages  (model=${MODEL})"
REQ_BODY="$(cat <<JSON
{
  "model": "${MODEL}",
  "max_tokens": 8,
  "messages": [{"role": "user", "content": "smoke-ping"}]
}
JSON
)"

http_call POST "${GATEWAY_URL}/v1/messages" \
  -H "x-api-key: ${API_KEY}" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  --data "${REQ_BODY}" | split_status

if [[ "${SMOKE_STATUS}" != "200" ]]; then
  fail "POST /v1/messages returned ${SMOKE_STATUS}; body: ${SMOKE_BODY}"
fi
if ! grep -q '"type":"message"' <<<"${SMOKE_BODY}"; then
  fail "response missing type=message; body: ${SMOKE_BODY}"
fi
ok "gateway proxied POST /v1/messages and returned 200"

# ── Step 4 (optional): usage_logs row written ───────────────────────────────

step "4/4  usage_logs assertion"
if [[ -z "${DATABASE_URL:-}" ]]; then
  warn "DATABASE_URL not set — skipping usage_logs assertion"
  warn "export DATABASE_URL and rerun to verify the async write landed"
  exit 0
fi
require_cmd psql

# Key prefix (first 8 chars of the raw key) — same shape the DB stores in
# api_keys.key_prefix. Used as the join key so we don't need the key_hash
# or the api_key id.
KEY_PREFIX="${API_KEY:0:8}"

# Poll up to 15 seconds — the write path is BullMQ-batched, so a row may
# not be visible the moment POST /v1/messages returns.
ATTEMPTS=15
for ((i=1; i<=ATTEMPTS; i++)); do
  count="$(psql "${DATABASE_URL}" --tuples-only --no-align --command "
    SELECT count(*)
    FROM usage_logs ul
    JOIN api_keys ak ON ak.id = ul.api_key_id
    WHERE ak.key_prefix = '${KEY_PREFIX}'
      AND ul.created_at > now() - interval '5 minutes';
  " 2>/dev/null | tr -d '[:space:]' )"
  if [[ "${count}" =~ ^[0-9]+$ ]] && (( count >= 1 )); then
    ok "usage_logs row found for key_prefix=${KEY_PREFIX} (count=${count})"
    exit 0
  fi
  sleep 1
done

fail "no usage_logs row found for key_prefix=${KEY_PREFIX} after ${ATTEMPTS}s; BullMQ worker may be stalled or api_keys.key_prefix does not match"

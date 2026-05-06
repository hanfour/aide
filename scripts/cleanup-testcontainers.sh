#!/bin/sh
# Reclaim leaked testcontainers before running tests.
#
# Most of the time this is a no-op — testcontainers' Ryuk sidecar reaps
# its own children when the parent test process exits cleanly. But if
# the parent is SIGKILL'd, hits OOM, or panics in a way Ryuk can't
# observe (which has been seen on macOS + OrbStack), the spawned
# postgres / redis containers leak. They keep running indefinitely and
# accumulate across runs.
#
# Symptom of accumulation: subsequent `pnpm test` runs see all those
# containers as Docker resource pressure; new testcontainer beforeAll
# hooks then can't allocate / start within the default 10s timeout, so
# tests fail with `Hook timed out in 10000ms` even though the test
# code is fine. Removing the leftovers restores normal behaviour.
#
# This script is wired as the root `pretest` npm hook so it runs once
# before each `pnpm test` invocation — including the one inside
# `prepublishOnly` (which gates `npm publish`).
#
# Safe to run with no Docker daemon (silently no-ops); safe to run
# when there are zero leaked containers (silently no-ops).
#
# Concurrency caveat: this nukes ALL testcontainer-labelled containers
# system-wide, including any in use by a parallel `pnpm test` (e.g. one
# from VS Code Test Explorer alongside one from a terminal). For solo
# sequential workflows this is fine. If you regularly run multiple test
# processes in parallel, scope by container age / session id before
# enabling this hook.
set -eu

# Skip silently if Docker isn't reachable — many CI / build envs don't
# have docker even though they run vitest.
if ! docker info >/dev/null 2>&1; then
  exit 0
fi

ids=$(docker ps -aq --filter 'label=org.testcontainers=true' 2>/dev/null || true)
if [ -z "$ids" ]; then
  exit 0
fi

count=$(printf '%s\n' "$ids" | wc -l | tr -d ' ')
echo "[pretest] reclaiming $count leaked testcontainer(s)..."
# shellcheck disable=SC2086
docker rm -f $ids >/dev/null 2>&1 || true
exit 0

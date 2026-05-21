# caliber-agent Phase 2 PR1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land caliber-agent Phase 2 PR1 — Go module scaffold under `agent/`, the `enroll <token>` command end-to-end (server token exchange → macOS keychain → config.toml → empty-default project allow-list wizard), and the release pipeline. Watcher / ingest / launchd are deferred to later PRs.

**Architecture:** New Go module at `agent/` inside the TypeScript monorepo (`github.com/hanfour/ai-dev-eval/agent`). Layered internal packages: `cli` (Cobra + exit-code plumbing), `api` (HTTP client), `config` (TOML + state.json), `keychain` (macOS `security` shell-out), `wizard` (interactive prompts), `version` (ldflags-injected metadata). Single binary `caliber-agent`.

**Tech Stack:** Go 1.25 (`go.mod` will pin to 1.25), Cobra (CLI), BurntSushi/toml (config), charmbracelet/huh (prompts), stdlib `testing` + `stretchr/testify`. Server-side prerequisite uses existing pnpm + Vitest + Drizzle 0.45.2 + Fastify stack.

**Authoritative spec:** `docs/superpowers/specs/2026-05-21-caliber-agent-phase2-pr1-design.md`. When the plan and spec disagree, the spec wins — flag the discrepancy.

---

## Phase 0 — Server prerequisite: enrollment-token race fix

This is a separate small server PR that **must merge before any agent code runs against this stack**. Fixes the race documented in spec §9a: two concurrent `POST /v1/devices/enroll` calls with the same token can both succeed.

### Task 0.1: Add SELECT FOR UPDATE + rowCount check on the enrollment route

**Files:**
- Modify: `apps/api/src/rest/devicesEnroll.ts:49-105`
- Modify: `apps/api/tests/integration/rest/devicesEnroll.test.ts` (append a new `describe` block)

- [ ] **Step 1: Write the failing concurrent-redeem test**

Append at the end of `apps/api/tests/integration/rest/devicesEnroll.test.ts`, inside the existing top-level `describe("POST /v1/devices/enroll", ...)` after the last `it(...)` but before the closing `});`:

```typescript
  it("rejects concurrent redemptions of the same token (one 201, rest 410)", async () => {
    const org = await makeOrg(testDb.db);
    const user = await makeUser(testDb.db, { orgId: org.id });
    const { token } = await seedEnrollmentToken({
      userId: user.id,
      orgId: org.id,
    });

    const concurrency = 10;
    const responses = await Promise.all(
      Array.from({ length: concurrency }, (_, i) =>
        app.inject({
          method: "POST",
          url: "/v1/devices/enroll",
          payload: {
            token,
            hostname: `host-${i}`,
            os: "darwin 25.3.0",
            agentVersion: "dev",
          },
        }),
      ),
    );

    const statuses = responses.map((r) => r.statusCode).sort((a, b) => a - b);
    const ok = statuses.filter((s) => s === 201).length;
    const gone = statuses.filter((s) => s === 410).length;
    expect(ok).toBe(1);
    expect(gone).toBe(concurrency - 1);

    // Exactly one device + one device_api_key row for this token.
    const deviceRows = await testDb.db
      .select({ id: devices.id })
      .from(devices)
      .where(eq(devices.orgId, org.id));
    expect(deviceRows).toHaveLength(1);

    const keyRows = await testDb.db
      .select({ id: deviceApiKeys.id })
      .from(deviceApiKeys)
      .where(eq(deviceApiKeys.deviceId, deviceRows[0]!.id));
    expect(keyRows).toHaveLength(1);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/api
pnpm exec vitest run tests/integration/rest/devicesEnroll.test.ts -t "concurrent"
```

Expected: FAIL — both `ok` and `gone` come back as numbers other than 1 / N-1 (typically `ok > 1`, `deviceRows.length > 1`), confirming the race.

- [ ] **Step 3: Apply the row-lock fix**

In `apps/api/src/rest/devicesEnroll.ts` inside the `tx.transaction(async (tx) => {...})` block, change the existing SELECT (around line 50-60) to acquire a row lock — method order mirrors `apps/api/src/services/invites.ts:136`:

```typescript
const [tokenRow] = await tx
  .select({
    id: deviceEnrollmentTokens.id,
    userId: deviceEnrollmentTokens.userId,
    orgId: deviceEnrollmentTokens.orgId,
    expiresAt: deviceEnrollmentTokens.expiresAt,
    usedAt: deviceEnrollmentTokens.usedAt,
  })
  .from(deviceEnrollmentTokens)
  .where(eq(deviceEnrollmentTokens.tokenHash, tokenHash))
  .limit(1)
  .for("update");
```

Then immediately after the existing UPDATE (around line 94-105) — i.e. after `.where(and(eq(...id), isNull(...usedAt)))` — capture and verify the result:

```typescript
const updateResult = await tx
  .update(deviceEnrollmentTokens)
  .set({
    usedAt: sql`NOW()`,
    usedByDeviceId: deviceRow.id,
  })
  .where(
    and(
      eq(deviceEnrollmentTokens.id, tokenRow.id),
      isNull(deviceEnrollmentTokens.usedAt),
    ),
  );
if (updateResult.rowCount !== 1) {
  // Should be unreachable because the row is locked via FOR UPDATE above.
  // If it ever fires, our invariant is broken — abort and force the
  // caller to retry-or-investigate via TOKEN_USED.
  throw { code: "TOKEN_USED" as const };
}
```

(If the existing code already assigns the update result to a different variable name, use that name. The substantive change is the new `if (updateResult.rowCount !== 1) throw ...` guard.)

- [ ] **Step 4: Re-run the test to verify it passes**

```bash
cd apps/api
pnpm exec vitest run tests/integration/rest/devicesEnroll.test.ts
```

Expected: all tests pass, including the new "concurrent redemptions" case.

- [ ] **Step 5: Type-check and lint**

```bash
pnpm -r build
```

Expected: no type errors.

- [ ] **Step 6: Commit the prerequisite**

```bash
git add apps/api/src/rest/devicesEnroll.ts apps/api/tests/integration/rest/devicesEnroll.test.ts
git commit -m "fix(api): serialise concurrent device enrollments via SELECT FOR UPDATE

Two concurrent POST /v1/devices/enroll calls for the same enrollment
token could both succeed because the SELECT was unlocked and the
post-INSERT UPDATE never checked rowCount. Adds .for('update') on the
token read and asserts rowCount === 1 on the UPDATE.

Integration test fires 10 concurrent enrollments for one token and
asserts exactly one 201 + nine 410s + exactly one device + one key."
```

- [ ] **Step 7: Open the PR and wait for merge before continuing to Phase 1**

```bash
git push -u origin <branch-name>
gh pr create --title "fix(api): serialise concurrent device enrollments" --body "$(cat <<'EOF'
## Summary
- SELECT ... FOR UPDATE on the enrollment-token row before INSERTing device + key
- Defence-in-depth: assert UPDATE marked exactly one row, else throw TOKEN_USED
- Add concurrent-redeem integration test (10 parallel POSTs → 1×201, 9×410)

## Why
Prerequisite for caliber-agent PR1 — the daemon's no-retry posture and "token already used" UX both assume single-use semantics that the server didn't actually enforce. See docs/superpowers/specs/2026-05-21-caliber-agent-phase2-pr1-design.md §9a.

## Test plan
- [x] Existing devicesEnroll integration tests still pass
- [x] New concurrent-redeem test fails without the fix, passes with it
- [x] pnpm -r build clean
EOF
)"
```

**Do not start Phase 1 until this PR is merged into main.**

---

## Phase 1 — Agent Go module scaffold

Creates the empty Go module, the entry point, version metadata, and the Cobra root with the exit-code plumbing from spec §4.7. No commands wired yet beyond `version`.

### Task 1.1: Initialise the Go module

**Files:**
- Create: `agent/go.mod`
- Create: `agent/.gitignore`

- [ ] **Step 1: Create the module directory and initialise**

```bash
mkdir -p agent
cd agent
go mod init github.com/hanfour/ai-dev-eval/agent
```

Expected: `agent/go.mod` exists with `module github.com/hanfour/ai-dev-eval/agent` and `go 1.25`.

- [ ] **Step 2: Add `.gitignore` for build artefacts**

Create `agent/.gitignore`:

```
# Local build artefacts
/caliber-agent
/dist/build/

# Test coverage
cover.out
*.coverprofile

# Editor scratch
.idea/
.vscode/
```

- [ ] **Step 3: Commit the empty module**

```bash
git add agent/go.mod agent/.gitignore
git commit -m "feat(agent): scaffold empty Go module at agent/"
```

### Task 1.2: Add the `version` package

**Files:**
- Create: `agent/internal/version/version.go`
- Create: `agent/internal/version/version_test.go`

- [ ] **Step 1: Write the failing test**

Create `agent/internal/version/version_test.go`:

```go
package version

import (
	"strings"
	"testing"
)

func TestStringWithDefaults(t *testing.T) {
	// Defaults represent a developer's `go run` build with no ldflags.
	if got := String(); got != "dev (unknown, unknown)" {
		t.Fatalf("String() with defaults = %q, want %q", got, "dev (unknown, unknown)")
	}
}

func TestStringWithOverrides(t *testing.T) {
	defer func(v, c, b string) { Version, Commit, BuiltAt = v, c, b }(Version, Commit, BuiltAt)
	Version = "0.1.0"
	Commit = "abc1234"
	BuiltAt = "2026-05-21T10:00:00Z"
	got := String()
	if !strings.Contains(got, "0.1.0") || !strings.Contains(got, "abc1234") || !strings.Contains(got, "2026-05-21T10:00:00Z") {
		t.Fatalf("String() with overrides = %q, missing one of the fields", got)
	}
}
```

- [ ] **Step 2: Run to verify failure**

```bash
cd agent
go test ./internal/version/...
```

Expected: FAIL — package undefined / no Go files.

- [ ] **Step 3: Implement the package**

Create `agent/internal/version/version.go`:

```go
// Package version exposes build metadata. Production builds override the
// vars via -ldflags; `go run` / unset builds keep the defaults so the
// daemon is still functional and identifiable as a dev build.
package version

import "fmt"

var (
	Version = "dev"
	Commit  = "unknown"
	BuiltAt = "unknown"
)

// String returns a single-line human-readable build identifier.
func String() string {
	return fmt.Sprintf("%s (%s, %s)", Version, Commit, BuiltAt)
}
```

- [ ] **Step 4: Run tests to verify pass**

```bash
cd agent
go test ./internal/version/... -v
```

Expected: PASS, both tests green.

- [ ] **Step 5: Commit**

```bash
git add agent/internal/version/
git commit -m "feat(agent): add version package with ldflags-injectable metadata"
```

### Task 1.3: Add the `ExitError` type and helpers

**Files:**
- Create: `agent/internal/cli/exit.go`
- Create: `agent/internal/cli/exit_test.go`

- [ ] **Step 1: Write the failing tests**

Create `agent/internal/cli/exit_test.go`:

```go
package cli

import (
	"errors"
	"testing"
)

func TestExitErrorImplementsErrorAndUnwrap(t *testing.T) {
	inner := errors.New("boom")
	ee := &ExitError{Code: 7, Err: inner}
	if ee.Error() != "boom" {
		t.Fatalf("Error() = %q, want %q", ee.Error(), "boom")
	}
	if !errors.Is(ee, inner) {
		t.Fatal("errors.Is(ee, inner) = false, want true (Unwrap)")
	}
}

func TestExitNotImplementedReturns64(t *testing.T) {
	err := ExitNotImplemented("status")
	var ee *ExitError
	if !errors.As(err, &ee) {
		t.Fatal("ExitNotImplemented should return *ExitError")
	}
	if ee.Code != 64 {
		t.Fatalf("Code = %d, want 64", ee.Code)
	}
}

func TestExitFromErrPassesThroughExitError(t *testing.T) {
	original := &ExitError{Code: 130, Err: errors.New("cancelled")}
	out := ExitFromErr(original)
	if out != original {
		t.Fatal("ExitFromErr should pass *ExitError through unchanged")
	}
}

func TestExitFromErrDefaultsTo1(t *testing.T) {
	out := ExitFromErr(errors.New("any random error"))
	if out.Code != 1 {
		t.Fatalf("Code = %d, want 1", out.Code)
	}
}
```

- [ ] **Step 2: Verify failure**

```bash
cd agent
go test ./internal/cli/...
```

Expected: FAIL — package undefined.

- [ ] **Step 3: Implement `exit.go`**

Create `agent/internal/cli/exit.go`:

```go
package cli

import (
	"context"
	"errors"
	"fmt"
)

// ExitError carries a non-zero process exit code through Cobra's error chain.
// Sub-commands return *ExitError when they need a specific code; the top-level
// Execute func unwraps it. Codes are documented in spec §8.
type ExitError struct {
	Code int
	Err  error
}

func (e *ExitError) Error() string { return e.Err.Error() }
func (e *ExitError) Unwrap() error { return e.Err }

// ExitFromErr maps a domain error into an *ExitError. Already-*ExitError
// values pass through unchanged. context.Canceled becomes exit 130 (SIGINT).
// All other errors become exit 1.
func ExitFromErr(err error) *ExitError {
	if err == nil {
		return nil
	}
	var ee *ExitError
	if errors.As(err, &ee) {
		return ee
	}
	if errors.Is(err, context.Canceled) {
		return &ExitError{Code: 130, Err: err}
	}
	return &ExitError{Code: 1, Err: err}
}

// ExitNotImplemented is returned by command stubs that exist for CLI surface
// stability but have no body yet (spec §4.6).
func ExitNotImplemented(cmd string) error {
	return &ExitError{
		Code: 64,
		Err:  fmt.Errorf("caliber-agent %s: not yet implemented in this release; see https://github.com/hanfour/caliber for the daemon roadmap", cmd),
	}
}
```

- [ ] **Step 4: Verify pass**

```bash
cd agent
go test ./internal/cli/... -v
```

Expected: PASS, all four tests green.

- [ ] **Step 5: Commit**

```bash
git add agent/internal/cli/
git commit -m "feat(agent): add ExitError type + ExitFromErr/ExitNotImplemented helpers"
```

### Task 1.4: Add Cobra root + Execute() function

**Files:**
- Create: `agent/internal/cli/root.go`
- Create: `agent/internal/cli/version.go`
- Create: `agent/internal/cli/root_test.go`
- Modify: `agent/go.mod` (via `go get`)

- [ ] **Step 1: Add Cobra dependency**

```bash
cd agent
go get github.com/spf13/cobra@v1.8.1
```

Expected: `go.mod` and `go.sum` updated; module cache populated.

- [ ] **Step 2: Write the failing test for `version` subcommand**

Create `agent/internal/cli/root_test.go`:

```go
package cli

import (
	"bytes"
	"context"
	"strings"
	"testing"
)

func TestVersionSubcommandPrintsBuildString(t *testing.T) {
	cmd := New()
	var out bytes.Buffer
	cmd.SetOut(&out)
	cmd.SetErr(&out)
	cmd.SetArgs([]string{"version"})

	if err := cmd.ExecuteContext(context.Background()); err != nil {
		t.Fatalf("ExecuteContext: %v", err)
	}
	if !strings.Contains(out.String(), "dev") {
		t.Fatalf("expected 'dev' in output, got %q", out.String())
	}
}

func TestUnknownSubcommandReturnsExitError(t *testing.T) {
	// Cobra returns an error for unknown commands; Execute() should map it to 1.
	cmd := New()
	var out bytes.Buffer
	cmd.SetOut(&out)
	cmd.SetErr(&out)
	cmd.SetArgs([]string{"definitely-not-a-command"})
	err := cmd.ExecuteContext(context.Background())
	if err == nil {
		t.Fatal("expected error for unknown command")
	}
}

func TestExecuteReturns0OnSuccess(t *testing.T) {
	// Smoke: Execute wraps the cobra command and returns an int.
	// We can't easily inject argv, but we can call it with the version path.
	// This test just verifies the function exists with the right signature.
	_ = Execute // compile-time check
}
```

- [ ] **Step 3: Verify failure**

```bash
cd agent
go test ./internal/cli/...
```

Expected: FAIL — `New` / `Execute` undefined.

- [ ] **Step 4: Implement `root.go`**

Create `agent/internal/cli/root.go`:

```go
package cli

import (
	"context"
	"errors"

	"github.com/spf13/cobra"
)

// PersistentFlags captures the root-level flags shared by every sub-command.
// Resolution order is documented in spec §4.6.
type PersistentFlags struct {
	ConfigDir  string // --config-dir
	APIBaseURL string // --api-base-url
	Verbose    bool   // -v / --verbose
}

var flags PersistentFlags

// New returns a fresh root *cobra.Command. Sub-commands are attached here.
// Returned as a value so tests can inject argv / stdin / stdout.
func New() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "caliber-agent",
		Short: "Caliber daemon: ship LLM coding-session telemetry from local clients to caliber",
		SilenceUsage:  true, // don't print usage on error
		SilenceErrors: false,
	}
	cmd.PersistentFlags().StringVar(&flags.ConfigDir, "config-dir", "", "override CALIBER_AGENT_HOME")
	cmd.PersistentFlags().StringVar(&flags.APIBaseURL, "api-base-url", "", "override CALIBER_API_BASE_URL / config api_base_url")
	cmd.PersistentFlags().BoolVarP(&flags.Verbose, "verbose", "v", false, "print extra error context")

	cmd.AddCommand(newVersionCmd())
	return cmd
}

// Execute is the entry point called by cmd/caliber-agent/main.go. It returns
// the int exit code the process should use (spec §4.7).
func Execute(ctx context.Context) int {
	cmd := New()
	err := cmd.ExecuteContext(ctx)
	if err == nil {
		return 0
	}
	var ee *ExitError
	if errors.As(err, &ee) {
		return ee.Code
	}
	if errors.Is(err, context.Canceled) {
		return 130
	}
	return 1
}
```

- [ ] **Step 5: Implement `version.go`**

Create `agent/internal/cli/version.go`:

```go
package cli

import (
	"github.com/spf13/cobra"

	"github.com/hanfour/ai-dev-eval/agent/internal/version"
)

func newVersionCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "version",
		Short: "Print the daemon build version",
		RunE: func(cmd *cobra.Command, _ []string) error {
			cmd.OutOrStdout().Write([]byte(version.String() + "\n"))
			return nil
		},
	}
}
```

- [ ] **Step 6: Verify pass**

```bash
cd agent
go test ./internal/cli/... -v
```

Expected: PASS, all tests green.

- [ ] **Step 7: Commit**

```bash
git add agent/go.mod agent/go.sum agent/internal/cli/
git commit -m "feat(agent): Cobra root + version subcommand + Execute() exit-code plumbing"
```

### Task 1.5: Add `cmd/caliber-agent/main.go` with signal handling + panic recover

**Files:**
- Create: `agent/cmd/caliber-agent/main.go`

- [ ] **Step 1: Implement main**

Create `agent/cmd/caliber-agent/main.go`:

```go
// Package main is the caliber-agent entry point. All real logic lives in
// internal/cli; main is responsible only for signal handling, panic recovery,
// and translating the int exit code from cli.Execute into os.Exit.
package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/hanfour/ai-dev-eval/agent/internal/cli"
	"github.com/hanfour/ai-dev-eval/agent/internal/version"
)

func main() {
	os.Exit(run())
}

func run() (exitCode int) {
	defer func() {
		if r := recover(); r != nil {
			fmt.Fprintf(os.Stderr,
				"internal error: %v\nversion: %s\nPlease report at https://github.com/hanfour/caliber/issues\n",
				r, version.String())
			exitCode = 70
		}
	}()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	return cli.Execute(ctx)
}
```

- [ ] **Step 2: Verify it builds**

```bash
cd agent
go build -o /tmp/caliber-agent-build-check ./cmd/caliber-agent
/tmp/caliber-agent-build-check version
rm /tmp/caliber-agent-build-check
```

Expected: build succeeds; running `version` prints `dev (unknown, unknown)`.

- [ ] **Step 3: Commit**

```bash
git add agent/cmd/caliber-agent/
git commit -m "feat(agent): main entry point with signal.NotifyContext + panic recover"
```

---

## Phase 2 — Config + keychain primitives

Two leaf packages with no dependencies on the rest of the daemon. Implement and test in isolation; later phases wire them in via the wizard.

### Task 2.1: `internal/config/paths` — path resolution

**Files:**
- Create: `agent/internal/config/paths.go`
- Create: `agent/internal/config/paths_test.go`

- [ ] **Step 1: Write the failing test**

Create `agent/internal/config/paths_test.go`:

```go
package config

import (
	"path/filepath"
	"testing"
)

func TestRootDirHonoursOverride(t *testing.T) {
	t.Setenv("CALIBER_AGENT_HOME", "/custom/path")
	if got := RootDir(); got != "/custom/path" {
		t.Fatalf("RootDir() = %q, want %q", got, "/custom/path")
	}
}

func TestRootDirFallsBackToHome(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("CALIBER_AGENT_HOME", "")
	t.Setenv("HOME", tmp)
	want := filepath.Join(tmp, ".caliber-agent")
	if got := RootDir(); got != want {
		t.Fatalf("RootDir() = %q, want %q", got, want)
	}
}

func TestDerivedPaths(t *testing.T) {
	t.Setenv("CALIBER_AGENT_HOME", "/x")
	cases := map[string]string{
		"ConfigPath": ConfigPath(),
		"StatePath":  StatePath(),
		"LogPath":    LogPath(),
	}
	wants := map[string]string{
		"ConfigPath": "/x/config.toml",
		"StatePath":  "/x/state.json",
		"LogPath":    "/x/agent.log",
	}
	for k, got := range cases {
		if got != wants[k] {
			t.Errorf("%s = %q, want %q", k, got, wants[k])
		}
	}
}
```

- [ ] **Step 2: Verify failure**

```bash
cd agent
go test ./internal/config/...
```

Expected: FAIL — package undefined.

- [ ] **Step 3: Implement paths.go**

Create `agent/internal/config/paths.go`:

```go
package config

import (
	"os"
	"path/filepath"
)

// RootDir returns the root of caliber-agent state. CALIBER_AGENT_HOME wins
// if set; otherwise ~/.caliber-agent. Tests can override via t.Setenv.
func RootDir() string {
	if override := os.Getenv("CALIBER_AGENT_HOME"); override != "" {
		return override
	}
	home, err := os.UserHomeDir()
	if err != nil {
		// UserHomeDir only fails when both $HOME and the platform-specific
		// fallbacks are empty — extremely unlikely on darwin. Fall through
		// to a relative path so callers still see a deterministic error.
		home = "."
	}
	return filepath.Join(home, ".caliber-agent")
}

func ConfigPath() string { return filepath.Join(RootDir(), "config.toml") }
func StatePath() string  { return filepath.Join(RootDir(), "state.json") }
func LogPath() string    { return filepath.Join(RootDir(), "agent.log") }
```

- [ ] **Step 4: Verify pass**

```bash
cd agent
go test ./internal/config/... -v
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/internal/config/
git commit -m "feat(agent): config.RootDir + derived paths with CALIBER_AGENT_HOME override"
```

### Task 2.2: `internal/config/config` — TOML round-trip with atomic save

**Files:**
- Create: `agent/internal/config/config.go`
- Create: `agent/internal/config/config_test.go`
- Modify: `agent/go.mod` (via `go get`)

- [ ] **Step 1: Add TOML dependency**

```bash
cd agent
go get github.com/BurntSushi/toml@v1.4.0
```

- [ ] **Step 2: Write the failing tests**

Create `agent/internal/config/config_test.go`:

```go
package config

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
)

func TestLoadMissingReturnsErrNotEnrolled(t *testing.T) {
	t.Setenv("CALIBER_AGENT_HOME", t.TempDir())
	_, err := Load()
	if !errors.Is(err, ErrNotEnrolled) {
		t.Fatalf("err = %v, want ErrNotEnrolled", err)
	}
}

func TestSaveThenLoadRoundTrip(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("CALIBER_AGENT_HOME", tmp)

	c := &Config{
		DeviceID:     "dev-abc",
		Hostname:     "h4",
		OS:           "darwin 25.3.0",
		APIBaseURL:   "https://caliber.local",
		Mode:         "metadata-only",
		IncludePaths: []string{},
	}
	if err := Save(c); err != nil {
		t.Fatalf("Save: %v", err)
	}

	info, err := os.Stat(filepath.Join(tmp, "config.toml"))
	if err != nil {
		t.Fatalf("Stat: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("perm = %o, want 0600", perm)
	}

	got, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if got.DeviceID != c.DeviceID || got.APIBaseURL != c.APIBaseURL {
		t.Errorf("round-trip mismatch: got %+v, want %+v", got, c)
	}
	if got.IncludePaths == nil {
		t.Error("IncludePaths should be empty slice, not nil")
	}
	if len(got.IncludePaths) != 0 {
		t.Errorf("IncludePaths = %v, want empty", got.IncludePaths)
	}
}

func TestSaveIsAtomic(t *testing.T) {
	// After Save, no .tmp file should remain.
	tmp := t.TempDir()
	t.Setenv("CALIBER_AGENT_HOME", tmp)
	if err := Save(&Config{DeviceID: "x"}); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(tmp)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if filepath.Ext(e.Name()) == ".tmp" {
			t.Errorf("leftover tmp file: %s", e.Name())
		}
	}
}

func TestSaveCreatesParentDir(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("CALIBER_AGENT_HOME", filepath.Join(tmp, "nested", "deep"))
	if err := Save(&Config{DeviceID: "x"}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if _, err := os.Stat(filepath.Join(tmp, "nested", "deep", "config.toml")); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			t.Fatal("config file was not created in nested dir")
		}
		t.Fatal(err)
	}
}
```

- [ ] **Step 3: Verify failure**

```bash
cd agent
go test ./internal/config/...
```

Expected: FAIL — undefined symbols.

- [ ] **Step 4: Implement config.go**

Create `agent/internal/config/config.go`:

```go
package config

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"

	"github.com/BurntSushi/toml"
)

// ErrNotEnrolled is returned by Load when no config file exists. Callers
// use errors.Is to branch.
var ErrNotEnrolled = errors.New("config: device not enrolled")

// Config is the on-disk shape of ~/.caliber-agent/config.toml. Spec §4.3.
type Config struct {
	DeviceID     string   `toml:"device_id"`
	Hostname     string   `toml:"hostname"`
	OS           string   `toml:"os"`
	APIBaseURL   string   `toml:"api_base_url"`
	Mode         string   `toml:"mode"`
	IncludePaths []string `toml:"include_paths"`
}

// Load reads and parses the config file. Returns ErrNotEnrolled if no file.
func Load() (*Config, error) {
	path := ConfigPath()
	bs, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, ErrNotEnrolled
		}
		return nil, fmt.Errorf("config: read %s: %w", path, err)
	}
	c := &Config{}
	if err := toml.Unmarshal(bs, c); err != nil {
		return nil, fmt.Errorf("config: parse %s: %w", path, err)
	}
	if c.IncludePaths == nil {
		c.IncludePaths = []string{}
	}
	return c, nil
}

// Save writes the config atomically via tmp + rename. Permission is 0600
// because the file references the device identity. Parent dir created if
// missing.
func Save(c *Config) error {
	if c.IncludePaths == nil {
		c.IncludePaths = []string{}
	}
	root := RootDir()
	if err := os.MkdirAll(root, 0o700); err != nil {
		return fmt.Errorf("config: mkdir %s: %w", root, err)
	}
	final := ConfigPath()
	tmp, err := os.CreateTemp(root, ".config.toml.*")
	if err != nil {
		return fmt.Errorf("config: create tmp: %w", err)
	}
	defer func() {
		_ = tmp.Close()
		_ = os.Remove(tmp.Name()) // no-op if rename succeeded
	}()
	if err := os.Chmod(tmp.Name(), 0o600); err != nil {
		return fmt.Errorf("config: chmod tmp: %w", err)
	}
	if err := toml.NewEncoder(tmp).Encode(c); err != nil {
		return fmt.Errorf("config: encode: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		return fmt.Errorf("config: fsync tmp: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("config: close tmp: %w", err)
	}
	if err := os.Rename(tmp.Name(), final); err != nil {
		return fmt.Errorf("config: rename %s → %s: %w", filepath.Base(tmp.Name()), final, err)
	}
	return nil
}
```

- [ ] **Step 5: Verify pass**

```bash
cd agent
go test ./internal/config/... -v
```

Expected: PASS, all four tests green.

- [ ] **Step 6: Commit**

```bash
git add agent/go.mod agent/go.sum agent/internal/config/config.go agent/internal/config/config_test.go
git commit -m "feat(agent): config.Load/Save TOML round-trip with atomic 0600 write"
```

### Task 2.3: `internal/config/state` — JSON skeleton

**Files:**
- Create: `agent/internal/config/state.go`
- Create: `agent/internal/config/state_test.go`

- [ ] **Step 1: Write the failing test**

Create `agent/internal/config/state_test.go`:

```go
package config

import (
	"testing"
	"time"
)

func TestLoadStateMissingReturnsEmpty(t *testing.T) {
	t.Setenv("CALIBER_AGENT_HOME", t.TempDir())
	s, err := LoadState()
	if err != nil {
		t.Fatalf("LoadState on empty: %v", err)
	}
	if s == nil || s.Files == nil {
		t.Fatal("LoadState should return non-nil State with non-nil Files map")
	}
	if len(s.Files) != 0 {
		t.Fatalf("Files = %v, want empty", s.Files)
	}
}

func TestStateRoundTrip(t *testing.T) {
	t.Setenv("CALIBER_AGENT_HOME", t.TempDir())
	now := time.Now().UTC().Truncate(time.Second)
	s := &State{Files: map[string]FileWatermark{
		"/path/to/a.jsonl": {Offset: 42, LastSync: now},
	}}
	if err := SaveState(s); err != nil {
		t.Fatalf("SaveState: %v", err)
	}
	loaded, err := LoadState()
	if err != nil {
		t.Fatalf("LoadState: %v", err)
	}
	if got := loaded.Files["/path/to/a.jsonl"]; got.Offset != 42 || !got.LastSync.Equal(now) {
		t.Errorf("round-trip mismatch: %+v", got)
	}
}
```

- [ ] **Step 2: Verify failure**

```bash
cd agent
go test ./internal/config/... -run TestState
```

Expected: FAIL.

- [ ] **Step 3: Implement state.go**

Create `agent/internal/config/state.go`:

```go
package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"time"
)

// State is the persisted watcher watermark map. PR1 ships only the
// skeleton — the watcher PR populates Files.
type State struct {
	Files map[string]FileWatermark `json:"files"`
}

type FileWatermark struct {
	Offset   int64     `json:"offset"`
	LastSync time.Time `json:"last_sync"`
}

func LoadState() (*State, error) {
	path := StatePath()
	bs, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return &State{Files: map[string]FileWatermark{}}, nil
		}
		return nil, fmt.Errorf("state: read %s: %w", path, err)
	}
	s := &State{}
	if err := json.Unmarshal(bs, s); err != nil {
		return nil, fmt.Errorf("state: parse %s: %w", path, err)
	}
	if s.Files == nil {
		s.Files = map[string]FileWatermark{}
	}
	return s, nil
}

func SaveState(s *State) error {
	if s.Files == nil {
		s.Files = map[string]FileWatermark{}
	}
	root := RootDir()
	if err := os.MkdirAll(root, 0o700); err != nil {
		return fmt.Errorf("state: mkdir %s: %w", root, err)
	}
	final := StatePath()
	tmp, err := os.CreateTemp(root, ".state.json.*")
	if err != nil {
		return fmt.Errorf("state: create tmp: %w", err)
	}
	defer func() {
		_ = tmp.Close()
		_ = os.Remove(tmp.Name())
	}()
	if err := os.Chmod(tmp.Name(), 0o600); err != nil {
		return fmt.Errorf("state: chmod tmp: %w", err)
	}
	enc := json.NewEncoder(tmp)
	enc.SetIndent("", "  ")
	if err := enc.Encode(s); err != nil {
		return fmt.Errorf("state: encode: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		return fmt.Errorf("state: fsync: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("state: close: %w", err)
	}
	return os.Rename(tmp.Name(), final)
}
```

- [ ] **Step 4: Verify pass**

```bash
cd agent
go test ./internal/config/... -v
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/internal/config/state.go agent/internal/config/state_test.go
git commit -m "feat(agent): state.json skeleton with atomic save"
```

### Task 2.4: `internal/keychain` — darwin shell-out + non-darwin stub

**Files:**
- Create: `agent/internal/keychain/keychain_darwin.go`
- Create: `agent/internal/keychain/keychain_other.go`
- Create: `agent/internal/keychain/keychain_darwin_test.go`
- Create: `agent/internal/keychain/keychain_other_test.go`

- [ ] **Step 1: Write the failing darwin test**

Create `agent/internal/keychain/keychain_darwin_test.go`:

```go
//go:build darwin

package keychain

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// writeFakeSecurity creates an executable shell script at <dir>/security that
// records its argv to <dir>/argv.log and exits with the given code.
func writeFakeSecurity(t *testing.T, dir string, exitCode int, stdoutLine string) {
	t.Helper()
	script := "#!/bin/sh\n" +
		"echo \"$@\" >> \"" + dir + "/argv.log\"\n"
	if stdoutLine != "" {
		script += "echo \"" + stdoutLine + "\"\n"
	}
	if exitCode != 0 {
		script += "exit " + itoa(exitCode) + "\n"
	}
	path := filepath.Join(dir, "security")
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
}

func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	out := ""
	for i > 0 {
		out = string(rune('0'+i%10)) + out
		i /= 10
	}
	return out
}

func TestSetInvokesSecurityWithExpectedArgs(t *testing.T) {
	dir := t.TempDir()
	writeFakeSecurity(t, dir, 0, "")

	orig := SecurityBin
	SecurityBin = filepath.Join(dir, "security")
	t.Cleanup(func() { SecurityBin = orig })

	if err := Set("dev-abc", "cda_secret"); err != nil {
		t.Fatalf("Set: %v", err)
	}

	bs, err := os.ReadFile(filepath.Join(dir, "argv.log"))
	if err != nil {
		t.Fatal(err)
	}
	got := string(bs)
	for _, want := range []string{"add-generic-password", "-U", "-s", ServiceName, "-a", "dev-abc", "-w", "cda_secret"} {
		if !strings.Contains(got, want) {
			t.Errorf("argv missing %q in %q", want, got)
		}
	}
}

func TestSetReturnsErrorOnNonZeroExit(t *testing.T) {
	dir := t.TempDir()
	writeFakeSecurity(t, dir, 1, "")
	orig := SecurityBin
	SecurityBin = filepath.Join(dir, "security")
	t.Cleanup(func() { SecurityBin = orig })

	if err := Set("dev-abc", "cda_x"); err == nil {
		t.Fatal("expected non-nil error on exit 1")
	}
}

func TestGetReturnsErrNotFoundOnExit44(t *testing.T) {
	// security exits 44 when the item is not in the keychain.
	dir := t.TempDir()
	writeFakeSecurity(t, dir, 44, "")
	orig := SecurityBin
	SecurityBin = filepath.Join(dir, "security")
	t.Cleanup(func() { SecurityBin = orig })

	_, err := Get("missing")
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
}

func TestGetReturnsPasswordFromStdout(t *testing.T) {
	dir := t.TempDir()
	writeFakeSecurity(t, dir, 0, "cda_returned_secret")
	orig := SecurityBin
	SecurityBin = filepath.Join(dir, "security")
	t.Cleanup(func() { SecurityBin = orig })

	got, err := Get("dev-abc")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got != "cda_returned_secret" {
		t.Fatalf("Get = %q, want %q", got, "cda_returned_secret")
	}
}
```

- [ ] **Step 2: Write the non-darwin test**

Create `agent/internal/keychain/keychain_other_test.go`:

```go
//go:build !darwin

package keychain

import (
	"errors"
	"testing"
)

func TestNonDarwinReturnsErrUnsupported(t *testing.T) {
	if err := Set("a", "b"); !errors.Is(err, ErrUnsupported) {
		t.Errorf("Set: %v", err)
	}
	if _, err := Get("a"); !errors.Is(err, ErrUnsupported) {
		t.Errorf("Get: %v", err)
	}
	if err := Delete("a"); !errors.Is(err, ErrUnsupported) {
		t.Errorf("Delete: %v", err)
	}
}
```

- [ ] **Step 3: Verify failure**

```bash
cd agent
go test ./internal/keychain/...
```

Expected: FAIL — package undefined.

- [ ] **Step 4: Implement `keychain_darwin.go`**

Create `agent/internal/keychain/keychain_darwin.go`:

```go
//go:build darwin

// Package keychain wraps the macOS `security` CLI for secret storage.
// The wrapper exec's an absolute-path binary (default /usr/bin/security)
// to avoid PATH injection; the binary path is a package-level var so tests
// can inject a fake that records argv.
package keychain

import (
	"bytes"
	"errors"
	"fmt"
	"os/exec"
	"strings"
)

// ServiceName is the macOS keychain "service" identifier for all entries
// written by caliber-agent.
const ServiceName = "tw.caliber.agent"

// SecurityBin is the path to the security(1) binary. Production default is
// /usr/bin/security; tests rewrite this to a fake script. It is a var rather
// than a const specifically to enable that injection.
var SecurityBin = "/usr/bin/security"

// ErrNotFound is returned by Get when the requested keychain item is absent.
var ErrNotFound = errors.New("keychain: not found")

// ErrUnsupported is returned by the non-darwin stub. Declared here too so
// callers can switch on it without build tags.
var ErrUnsupported = errors.New("keychain: not supported on this platform")

// Set writes (or upserts via -U) a generic password to the login keychain
// under ServiceName + account. The secret is never logged.
func Set(account, secret string) error {
	cmd := exec.Command(SecurityBin, "add-generic-password",
		"-U",
		"-s", ServiceName,
		"-a", account,
		"-w", secret,
	)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("keychain: security add-generic-password: %w (stderr: %s)", err, strings.TrimSpace(stderr.String()))
	}
	return nil
}

// Get returns the bare password for ServiceName + account, or ErrNotFound.
func Get(account string) (string, error) {
	cmd := exec.Command(SecurityBin, "find-generic-password",
		"-s", ServiceName,
		"-a", account,
		"-w",
	)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) && exitErr.ExitCode() == 44 {
			return "", ErrNotFound
		}
		return "", fmt.Errorf("keychain: security find-generic-password: %w (stderr: %s)", err, strings.TrimSpace(stderr.String()))
	}
	return strings.TrimRight(stdout.String(), "\n"), nil
}

// Delete removes the entry for ServiceName + account.
func Delete(account string) error {
	cmd := exec.Command(SecurityBin, "delete-generic-password",
		"-s", ServiceName,
		"-a", account,
	)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) && exitErr.ExitCode() == 44 {
			return ErrNotFound
		}
		return fmt.Errorf("keychain: security delete-generic-password: %w (stderr: %s)", err, strings.TrimSpace(stderr.String()))
	}
	return nil
}
```

- [ ] **Step 5: Implement `keychain_other.go`**

Create `agent/internal/keychain/keychain_other.go`:

```go
//go:build !darwin

package keychain

import "errors"

const ServiceName = "tw.caliber.agent"

var SecurityBin = "" // unused on non-darwin; kept for API symmetry

var ErrNotFound = errors.New("keychain: not found")
var ErrUnsupported = errors.New("keychain: not supported on this platform")

func Set(account, secret string) error      { return ErrUnsupported }
func Get(account string) (string, error)    { return "", ErrUnsupported }
func Delete(account string) error           { return ErrUnsupported }
```

- [ ] **Step 6: Verify pass**

```bash
cd agent
go test ./internal/keychain/... -v
```

Expected: PASS, all darwin tests green (you're on darwin/arm64).

- [ ] **Step 7: Commit**

```bash
git add agent/internal/keychain/
git commit -m "feat(agent): keychain darwin wrapper + non-darwin stub, injectable SecurityBin"
```

---

## Phase 3 — API client

HTTP client for `POST /v1/devices/enroll` with typed errors. No retry. No gzip. The `*APIError.Is` method makes both `errors.Is(err, ErrInvalidToken)` and `errors.As(err, &apiErr)` succeed on the same returned value (spec §4.4).

### Task 3.1: `internal/api/errors` — sentinels + `APIError.Is`

**Files:**
- Create: `agent/internal/api/errors.go`
- Create: `agent/internal/api/errors_test.go`

- [ ] **Step 1: Write the failing test**

Create `agent/internal/api/errors_test.go`:

```go
package api

import (
	"errors"
	"testing"
)

func TestAPIErrorImplementsErrorAndIsAgainstSentinels(t *testing.T) {
	cases := []struct {
		name       string
		statusCode int
		tag        string
		sentinel   error
	}{
		{"invalid token", 401, "invalid_token", ErrInvalidToken},
		{"token used", 410, "token_already_used", ErrTokenUsed},
		{"token expired", 410, "token_expired", ErrTokenExpired},
		{"server misconf", 500, "server_misconfigured", ErrServerMisconf},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := error(&APIError{StatusCode: tc.statusCode, ErrorTag: tc.tag, Body: "{}"})
			if !errors.Is(err, tc.sentinel) {
				t.Errorf("errors.Is(err, %v) = false", tc.sentinel)
			}
			var apiErr *APIError
			if !errors.As(err, &apiErr) {
				t.Errorf("errors.As did not find *APIError")
			}
		})
	}
}

func TestAPIErrorIsReturnsFalseForUnknownSentinel(t *testing.T) {
	err := &APIError{StatusCode: 400, ErrorTag: "invalid_body"}
	if errors.Is(err, ErrInvalidToken) {
		t.Fatal("status 400 invalid_body should not match ErrInvalidToken")
	}
}

func TestAPIErrorErrorIncludesStatusAndTag(t *testing.T) {
	err := &APIError{StatusCode: 401, ErrorTag: "invalid_token", Body: `{"error":"invalid_token"}`}
	s := err.Error()
	if !contains(s, "401") || !contains(s, "invalid_token") {
		t.Fatalf("Error() = %q, should mention status + tag", s)
	}
}

func contains(haystack, needle string) bool {
	return len(haystack) >= len(needle) && indexOf(haystack, needle) >= 0
}

func indexOf(haystack, needle string) int {
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return i
		}
	}
	return -1
}
```

- [ ] **Step 2: Verify failure**

```bash
cd agent
go test ./internal/api/...
```

Expected: FAIL — package undefined.

- [ ] **Step 3: Implement errors.go**

Create `agent/internal/api/errors.go`:

```go
package api

import (
	"errors"
	"fmt"
)

// Sentinel errors callers can match with errors.Is. *APIError.Is below
// fulfils each contract.
var (
	ErrInvalidToken  = errors.New("api: invalid_token")
	ErrTokenUsed     = errors.New("api: token_already_used")
	ErrTokenExpired  = errors.New("api: token_expired")
	ErrServerMisconf = errors.New("api: server misconfigured")
)

// APIError is the only error type the api package returns for HTTP failures.
// It carries the parsed `error` tag from the server response body plus the
// raw body for debugging. The custom Is method lets callers use either
// errors.Is(err, ErrInvalidToken) or errors.As(err, &apiErr) on the same
// returned value (spec §4.4).
type APIError struct {
	StatusCode int
	ErrorTag   string // parsed from JSON `error` field
	Body       string // first 200 chars of raw response body
}

func (e *APIError) Error() string {
	return fmt.Sprintf("api: status %d, tag %q, body: %s", e.StatusCode, e.ErrorTag, e.Body)
}

// Is matches sentinel errors by (StatusCode, ErrorTag) pairs. Spec §4.4.
func (e *APIError) Is(target error) bool {
	switch target {
	case ErrInvalidToken:
		return e.StatusCode == 401 && e.ErrorTag == "invalid_token"
	case ErrTokenUsed:
		return e.StatusCode == 410 && e.ErrorTag == "token_already_used"
	case ErrTokenExpired:
		return e.StatusCode == 410 && e.ErrorTag == "token_expired"
	case ErrServerMisconf:
		return e.StatusCode == 500 && e.ErrorTag == "server_misconfigured"
	}
	return false
}
```

- [ ] **Step 4: Verify pass**

```bash
cd agent
go test ./internal/api/... -v
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/internal/api/errors.go agent/internal/api/errors_test.go
git commit -m "feat(agent): APIError type + sentinel errors with custom Is matching"
```

### Task 3.2: `internal/api/client` + `Enroll` end-to-end against httptest

**Files:**
- Create: `agent/internal/api/client.go`
- Create: `agent/internal/api/enroll.go`
- Create: `agent/internal/api/client_test.go`
- Create: `agent/internal/api/enroll_test.go`

- [ ] **Step 1: Write the failing tests**

Create `agent/internal/api/client_test.go`:

```go
package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestClientSendsUserAgent(t *testing.T) {
	var gotUA string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotUA = r.Header.Get("User-Agent")
		w.WriteHeader(201)
		w.Write([]byte(`{"deviceId":"d","key":"cda_k","keyPrefix":"cda_"}`))
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "caliber-agent/dev")
	_, err := c.Enroll(context.Background(), EnrollRequest{Token: "t", Hostname: "h", OS: "o", AgentVersion: "v"})
	if err != nil {
		t.Fatalf("Enroll: %v", err)
	}
	if !strings.Contains(gotUA, "caliber-agent/dev") {
		t.Fatalf("User-Agent = %q", gotUA)
	}
}

func TestClientTimeoutFires(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(2 * time.Second)
		w.WriteHeader(201)
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "ua")
	c.HTTP.Timeout = 100 * time.Millisecond
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	_, err := c.Enroll(ctx, EnrollRequest{Token: "t", Hostname: "h", OS: "o", AgentVersion: "v"})
	if err == nil {
		t.Fatal("expected timeout error")
	}
}
```

Create `agent/internal/api/enroll_test.go`:

```go
package api

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

func handlerReturning(status int, body string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(status)
		w.Write([]byte(body))
	})
}

func TestEnrollHappyPath(t *testing.T) {
	srv := httptest.NewServer(handlerReturning(201, `{"deviceId":"d-1","key":"cda_secret","keyPrefix":"cda_xxxx"}`))
	defer srv.Close()

	c := NewClient(srv.URL, "ua")
	resp, err := c.Enroll(context.Background(), EnrollRequest{Token: "t", Hostname: "h", OS: "o", AgentVersion: "v"})
	if err != nil {
		t.Fatalf("Enroll: %v", err)
	}
	if resp.DeviceID != "d-1" || resp.Key != "cda_secret" {
		t.Fatalf("resp = %+v", resp)
	}
}

func TestEnrollStatusToSentinel(t *testing.T) {
	cases := []struct {
		name   string
		status int
		body   string
		want   error
	}{
		{"401 invalid_token", 401, `{"error":"invalid_token"}`, ErrInvalidToken},
		{"410 token_already_used", 410, `{"error":"token_already_used"}`, ErrTokenUsed},
		{"410 token_expired", 410, `{"error":"token_expired"}`, ErrTokenExpired},
		{"500 server_misconfigured", 500, `{"error":"server_misconfigured"}`, ErrServerMisconf},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(handlerReturning(tc.status, tc.body))
			defer srv.Close()
			c := NewClient(srv.URL, "ua")
			_, err := c.Enroll(context.Background(), EnrollRequest{Token: "t", Hostname: "h", OS: "o", AgentVersion: "v"})
			if !errors.Is(err, tc.want) {
				t.Fatalf("err = %v, want %v", err, tc.want)
			}
			var apiErr *APIError
			if !errors.As(err, &apiErr) {
				t.Fatal("errors.As(err, *APIError) failed")
			}
			if apiErr.StatusCode != tc.status {
				t.Errorf("StatusCode = %d, want %d", apiErr.StatusCode, tc.status)
			}
		})
	}
}

func TestEnroll400ReturnsAPIErrorWithoutSentinel(t *testing.T) {
	srv := httptest.NewServer(handlerReturning(400, `{"error":"invalid_body","details":{}}`))
	defer srv.Close()
	c := NewClient(srv.URL, "ua")
	_, err := c.Enroll(context.Background(), EnrollRequest{Token: "t"})
	if errors.Is(err, ErrInvalidToken) {
		t.Fatal("400 invalid_body must not match ErrInvalidToken")
	}
	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		t.Fatal("errors.As failed")
	}
	if apiErr.ErrorTag != "invalid_body" {
		t.Errorf("tag = %q", apiErr.ErrorTag)
	}
}

func TestEnrollBodyTruncatedTo200Chars(t *testing.T) {
	long := make([]byte, 1000)
	for i := range long {
		long[i] = 'x'
	}
	srv := httptest.NewServer(handlerReturning(500, string(long)))
	defer srv.Close()
	c := NewClient(srv.URL, "ua")
	_, err := c.Enroll(context.Background(), EnrollRequest{Token: "t"})
	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		t.Fatal("errors.As failed")
	}
	if len(apiErr.Body) > 200 {
		t.Errorf("body = %d chars, want ≤ 200", len(apiErr.Body))
	}
}
```

- [ ] **Step 2: Verify failure**

```bash
cd agent
go test ./internal/api/...
```

Expected: FAIL.

- [ ] **Step 3: Implement client.go**

Create `agent/internal/api/client.go`:

```go
package api

import (
	"net/http"
	"time"
)

// Client is the thin HTTP client for caliber. PR1 only exposes Enroll;
// later PRs add Ingest. Public fields are settable from tests.
type Client struct {
	BaseURL   string
	HTTP      *http.Client
	UserAgent string
}

// NewClient constructs a Client with a 30s default timeout (spec §4.4).
func NewClient(baseURL, userAgent string) *Client {
	return &Client{
		BaseURL:   baseURL,
		UserAgent: userAgent,
		HTTP:      &http.Client{Timeout: 30 * time.Second},
	}
}
```

- [ ] **Step 4: Implement enroll.go**

Create `agent/internal/api/enroll.go`:

```go
package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
)

type EnrollRequest struct {
	Token        string `json:"token"`
	Hostname     string `json:"hostname"`
	OS           string `json:"os"`
	AgentVersion string `json:"agentVersion"`
}

type EnrollResponse struct {
	DeviceID  string `json:"deviceId"`
	Key       string `json:"key"`
	KeyPrefix string `json:"keyPrefix"`
}

// errorBody is the shape of all 4xx/5xx responses from /v1/devices/enroll
// (see apps/api/src/rest/devicesEnroll.ts:39,134-149).
type errorBody struct {
	Error string `json:"error"`
}

func (c *Client) Enroll(ctx context.Context, req EnrollRequest) (*EnrollResponse, error) {
	payload, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("api: marshal enroll: %w", err)
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, c.BaseURL+"/v1/devices/enroll", bytes.NewReader(payload))
	if err != nil {
		return nil, fmt.Errorf("api: build request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("User-Agent", c.UserAgent)

	resp, err := c.HTTP.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("api: enroll http: %w", err)
	}
	defer resp.Body.Close()

	bodyBytes, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<16)) // 64 KiB cap is safety, real bodies are tiny

	if resp.StatusCode == http.StatusCreated {
		out := &EnrollResponse{}
		if err := json.Unmarshal(bodyBytes, out); err != nil {
			return nil, fmt.Errorf("api: parse 201 body: %w", err)
		}
		return out, nil
	}

	// Failure: parse the { error: "..." } shape into APIError.
	var eb errorBody
	_ = json.Unmarshal(bodyBytes, &eb) // best-effort; missing fields tolerated

	body := string(bodyBytes)
	if len(body) > 200 {
		body = body[:200]
	}
	return nil, &APIError{
		StatusCode: resp.StatusCode,
		ErrorTag:   eb.Error,
		Body:       body,
	}
}
```

- [ ] **Step 5: Verify pass**

```bash
cd agent
go test ./internal/api/... -v -race
```

Expected: PASS, all tests green.

- [ ] **Step 6: Commit**

```bash
git add agent/internal/api/
git commit -m "feat(agent): api.Client.Enroll with httptest-driven failure mappings"
```

---

## Phase 4 — Interactive wizard

Spec §4.5. Three pieces: project scanner (JSONL primary, dirname fallback, io.LimitReader bound), Prompter interface (allows stdin injection in tests), and the enrollment orchestrator.

### Task 4.1: `internal/wizard/projects` — ScanClaudeProjects with bounded reads

**Files:**
- Create: `agent/internal/wizard/projects.go`
- Create: `agent/internal/wizard/projects_test.go`

- [ ] **Step 1: Write the failing test (cases 1, 2, 8 — the exported path)**

Create `agent/internal/wizard/projects_test.go`:

```go
package wizard

import (
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

func writeFile(t *testing.T, path string, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// Encode an absolute path into Claude's project-dir convention: replace "/"
// with "-". E.g. "/tmp/foo-bar" → "-tmp-foo-bar".
func encodeClaudeDir(abs string) string {
	return strings.ReplaceAll(abs, "/", "-")
}

func TestScan_DashedRealCWD(t *testing.T) {
	tmp := t.TempDir()
	realDir := filepath.Join(tmp, "test", "dashed-real-name")
	if err := os.MkdirAll(realDir, 0o755); err != nil {
		t.Fatal(err)
	}
	claudeRoot := filepath.Join(tmp, "claude-projects")
	claudeDir := filepath.Join(claudeRoot, encodeClaudeDir(realDir))
	writeFile(t, filepath.Join(claudeDir, "sess.jsonl"),
		`{"type":"user","cwd":"`+realDir+`"}`+"\n")

	cands, err := ScanClaudeProjects(claudeRoot)
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}
	if len(cands) != 1 || cands[0].CWD != realDir {
		t.Fatalf("got %+v, want CWD=%q", cands, realDir)
	}
}

func TestScan_CleanCWD(t *testing.T) {
	tmp := t.TempDir()
	realDir := filepath.Join(tmp, "test", "plain")
	if err := os.MkdirAll(realDir, 0o755); err != nil {
		t.Fatal(err)
	}
	claudeRoot := filepath.Join(tmp, "claude-projects")
	claudeDir := filepath.Join(claudeRoot, encodeClaudeDir(realDir))
	writeFile(t, filepath.Join(claudeDir, "sess.jsonl"),
		`{"type":"user","cwd":"`+realDir+`"}`+"\n")

	cands, err := ScanClaudeProjects(claudeRoot)
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}
	if len(cands) != 1 || cands[0].CWD != realDir {
		t.Fatalf("got %+v", cands)
	}
}

func TestScan_NoLeadingDashSkipped(t *testing.T) {
	tmp := t.TempDir()
	claudeRoot := filepath.Join(tmp, "claude-projects")
	writeFile(t, filepath.Join(claudeRoot, "not-a-claude-project", "x.jsonl"), `{"cwd":"`+tmp+`"}`)
	cands, err := ScanClaudeProjects(claudeRoot)
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}
	if len(cands) != 0 {
		t.Fatalf("expected 0 candidates, got %+v", cands)
	}
}

func TestScan_StaleCWDSkipped(t *testing.T) {
	tmp := t.TempDir()
	claudeRoot := filepath.Join(tmp, "claude-projects")
	claudeDir := filepath.Join(claudeRoot, "-nonexistent-path")
	writeFile(t, filepath.Join(claudeDir, "s.jsonl"), `{"cwd":"/path/that/does/not/exist"}`)
	cands, _ := ScanClaudeProjects(claudeRoot)
	if len(cands) != 0 {
		t.Fatalf("expected 0, got %+v", cands)
	}
}

func TestScan_CorruptJSONLFallbackToDirname(t *testing.T) {
	tmp := t.TempDir()
	realDir := filepath.Join(tmp, "test", "fb")
	if err := os.MkdirAll(realDir, 0o755); err != nil {
		t.Fatal(err)
	}
	claudeRoot := filepath.Join(tmp, "claude-projects")
	claudeDir := filepath.Join(claudeRoot, encodeClaudeDir(realDir))
	writeFile(t, filepath.Join(claudeDir, "bad.jsonl"), "this is not json\n")

	cands, _ := ScanClaudeProjects(claudeRoot)
	if len(cands) != 1 || cands[0].CWD != realDir {
		t.Fatalf("got %+v, want %q", cands, realDir)
	}
}

func TestScan_NoJSONLFallbackToDirname(t *testing.T) {
	tmp := t.TempDir()
	realDir := filepath.Join(tmp, "test", "empty-proj")
	if err := os.MkdirAll(realDir, 0o755); err != nil {
		t.Fatal(err)
	}
	claudeRoot := filepath.Join(tmp, "claude-projects")
	claudeDir := filepath.Join(claudeRoot, encodeClaudeDir(realDir))
	if err := os.MkdirAll(claudeDir, 0o755); err != nil {
		t.Fatal(err)
	}
	cands, _ := ScanClaudeProjects(claudeRoot)
	if len(cands) != 1 || cands[0].CWD != realDir {
		t.Fatalf("got %+v, want %q", cands, realDir)
	}
	if cands[0].SessionCt != 0 {
		t.Errorf("SessionCt = %d, want 0", cands[0].SessionCt)
	}
}

// Cases 6 + 7 use the unexported scanClaudeProjects test seam to inject a
// byte-counter opener.
type countingReader struct {
	r io.ReadCloser
	n *int64
}

func (c *countingReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	atomic.AddInt64(c.n, int64(n))
	return n, err
}
func (c *countingReader) Close() error { return c.r.Close() }

func TestScan_ByteBudgetExhaustedManySmallLines(t *testing.T) {
	tmp := t.TempDir()
	claudeRoot := filepath.Join(tmp, "claude-projects")
	claudeDir := filepath.Join(claudeRoot, "-nonexistent-bigfile")
	if err := os.MkdirAll(claudeDir, 0o755); err != nil {
		t.Fatal(err)
	}
	// 300 KiB of "no cwd" lines, exceeds 256 KiB budget.
	f, err := os.Create(filepath.Join(claudeDir, "big.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	line := `{"type":"noise","payload":"` + strings.Repeat("x", 200) + `"}` + "\n"
	for i := 0; i < 1500; i++ {
		f.WriteString(line)
	}
	f.Close()

	var bytesRead int64
	opener := func(p string) (io.ReadCloser, error) {
		f, err := os.Open(p)
		if err != nil {
			return nil, err
		}
		return &countingReader{r: f, n: &bytesRead}, nil
	}
	cands, _ := scanClaudeProjects(claudeRoot, opener)
	if len(cands) != 0 {
		t.Errorf("expected 0 candidates (fallback dirname is invalid), got %+v", cands)
	}
	if bytesRead > 256*1024 {
		t.Errorf("bytesRead = %d, want ≤ 256 KiB", bytesRead)
	}
}

func TestScan_GiantSingleLineBounded(t *testing.T) {
	tmp := t.TempDir()
	claudeRoot := filepath.Join(tmp, "claude-projects")
	claudeDir := filepath.Join(claudeRoot, "-nonexistent-giant")
	if err := os.MkdirAll(claudeDir, 0o755); err != nil {
		t.Fatal(err)
	}
	// 20 MiB single-line JSONL with no newline.
	f, err := os.Create(filepath.Join(claudeDir, "huge.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	chunk := strings.Repeat("x", 64*1024)
	for i := 0; i < 320; i++ { // 320 × 64 KiB = 20 MiB
		f.WriteString(chunk)
	}
	f.Close()

	var bytesRead int64
	opener := func(p string) (io.ReadCloser, error) {
		f, err := os.Open(p)
		if err != nil {
			return nil, err
		}
		return &countingReader{r: f, n: &bytesRead}, nil
	}
	cands, _ := scanClaudeProjects(claudeRoot, opener)
	if len(cands) != 0 {
		t.Errorf("expected 0 candidates, got %+v", cands)
	}
	if bytesRead > 256*1024 {
		t.Errorf("bytesRead = %d, want ≤ 256 KiB (io.LimitReader bound violated)", bytesRead)
	}
}
```

- [ ] **Step 2: Verify failure**

```bash
cd agent
go test ./internal/wizard/...
```

Expected: FAIL.

- [ ] **Step 3: Implement projects.go**

Create `agent/internal/wizard/projects.go`:

```go
package wizard

import (
	"bufio"
	"encoding/json"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

type ProjectCandidate struct {
	CWD       string    // absolute, stat-verified directory
	LastSeen  time.Time // max mtime of *.jsonl, or dir mtime when SessionCt == 0
	SessionCt int       // count of *.jsonl files under this candidate
}

// Opener is the file-open seam used by the scanner. Production passes
// os.Open; tests inject byte-counting wrappers. Returns io.ReadCloser so
// callers can wrap freely without changing the contract.
type opener func(path string) (io.ReadCloser, error)

const perDirByteBudget int64 = 256 * 1024

// ScanClaudeProjects walks <root> and returns one ProjectCandidate per
// resolvable Claude project directory. JSONL content is the primary cwd
// source; dirname dash-decode is the fallback. Spec §4.5.
func ScanClaudeProjects(root string) ([]ProjectCandidate, error) {
	return scanClaudeProjects(root, defaultOpener)
}

func defaultOpener(p string) (io.ReadCloser, error) {
	return os.Open(p)
}

func scanClaudeProjects(root string, open opener) ([]ProjectCandidate, error) {
	entries, err := os.ReadDir(root)
	if err != nil {
		if errors.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	out := []ProjectCandidate{}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		name := e.Name()
		if !strings.HasPrefix(name, "-") {
			continue
		}
		dir := filepath.Join(root, name)
		cand, ok := resolveDir(dir, name, open)
		if !ok {
			continue
		}
		out = append(out, cand)
	}
	// Dedupe by CWD, keep newest LastSeen.
	dedup := map[string]ProjectCandidate{}
	for _, c := range out {
		if existing, ok := dedup[c.CWD]; !ok || c.LastSeen.After(existing.LastSeen) {
			dedup[c.CWD] = c
		}
	}
	result := make([]ProjectCandidate, 0, len(dedup))
	for _, c := range dedup {
		result = append(result, c)
	}
	sort.Slice(result, func(i, j int) bool {
		return result[i].LastSeen.After(result[j].LastSeen)
	})
	return result, nil
}

// resolveDir attempts to find the cwd for a single claude project directory.
// Returns (candidate, true) on success, zero-value + false otherwise.
func resolveDir(dir, name string, open opener) (ProjectCandidate, bool) {
	jsonls, lastSeen := listJSONL(dir)

	cwd := scanJSONLForCWD(dir, jsonls, open)
	if cwd == "" {
		cwd = dirnameFallback(name)
	}
	if cwd == "" {
		return ProjectCandidate{}, false
	}

	if len(jsonls) == 0 {
		info, err := os.Stat(dir)
		if err != nil {
			return ProjectCandidate{}, false
		}
		lastSeen = info.ModTime()
	}
	return ProjectCandidate{CWD: cwd, LastSeen: lastSeen, SessionCt: len(jsonls)}, true
}

// listJSONL returns the *.jsonl files in dir sorted newest-mtime-first and
// the latest mtime observed.
func listJSONL(dir string) ([]string, time.Time) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, time.Time{}
	}
	type entry struct {
		path  string
		mtime time.Time
	}
	var es []entry
	for _, e := range entries {
		if e.IsDir() || filepath.Ext(e.Name()) != ".jsonl" {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		es = append(es, entry{path: filepath.Join(dir, e.Name()), mtime: info.ModTime()})
	}
	sort.Slice(es, func(i, j int) bool { return es[i].mtime.After(es[j].mtime) })

	paths := make([]string, len(es))
	var newest time.Time
	for i, e := range es {
		paths[i] = e.path
		if e.mtime.After(newest) {
			newest = e.mtime
		}
	}
	return paths, newest
}

// scanJSONLForCWD reads files newest-first, bounded by perDirByteBudget
// total bytes across all files in the dir. Returns the first cwd that
// stats as a directory.
func scanJSONLForCWD(_ string, jsonls []string, open opener) string {
	budget := perDirByteBudget
	for _, path := range jsonls {
		if budget <= 0 {
			break
		}
		f, err := open(path)
		if err != nil {
			continue
		}
		// io.LimitReader bounds *total* bytes drawn from the file to the
		// remaining budget; this is what prevents ReadString from
		// allocating multi-MB single-line files (spec §4.5).
		lr := io.LimitReader(f, budget)
		reader := bufio.NewReaderSize(lr, 64*1024)
		for budget > 0 {
			line, err := reader.ReadString('\n')
			budget -= int64(len(line))
			if len(line) > 0 {
				if cwd := tryExtractCWD(line); cwd != "" {
					_ = f.Close()
					return cwd
				}
			}
			if err == io.EOF {
				break
			}
			if err != nil {
				break
			}
		}
		_ = f.Close()
	}
	return ""
}

// tryExtractCWD parses one JSONL line and returns its cwd if it stats as
// a directory. Empty string otherwise. Tolerates malformed JSON silently.
func tryExtractCWD(line string) string {
	var obj struct {
		CWD string `json:"cwd"`
	}
	if err := json.Unmarshal([]byte(line), &obj); err != nil {
		return ""
	}
	if obj.CWD == "" {
		return ""
	}
	info, err := os.Stat(obj.CWD)
	if err != nil || !info.IsDir() {
		return ""
	}
	return obj.CWD
}

// dirnameFallback decodes Claude's dash-encoded project dir name back into
// an absolute path. Lossy on paths with native hyphens; only used when
// JSONL scan returned nothing.
func dirnameFallback(name string) string {
	if !strings.HasPrefix(name, "-") {
		return ""
	}
	body := strings.TrimPrefix(name, "-")
	candidate := "/" + strings.ReplaceAll(body, "-", "/")
	info, err := os.Stat(candidate)
	if err != nil || !info.IsDir() {
		return ""
	}
	return candidate
}
```

Add the missing import for `errors.IsNotExist` — actually use `os.IsNotExist` (stdlib) or `errors.Is(err, fs.ErrNotExist)`:

Replace the `errors.IsNotExist(err)` line above with:

```go
		if errors.Is(err, fs.ErrNotExist) {
			return nil, nil
		}
```

And add the `"errors"` import.

- [ ] **Step 4: Verify pass**

```bash
cd agent
go test ./internal/wizard/... -v -race
```

Expected: PASS, all 8 sub-tests green.

- [ ] **Step 5: Commit**

```bash
git add agent/internal/wizard/projects.go agent/internal/wizard/projects_test.go
git commit -m "feat(agent): wizard.ScanClaudeProjects with io.LimitReader-bounded JSONL scan"
```

### Task 4.2: `internal/wizard/prompt` — Prompter interface + fake for tests

**Files:**
- Create: `agent/internal/wizard/prompt.go`
- Create: `agent/internal/wizard/prompt_test.go`
- Modify: `agent/go.mod` (via `go get`)

- [ ] **Step 1: Add huh dependency**

```bash
cd agent
go get github.com/charmbracelet/huh@v0.5.3
```

- [ ] **Step 2: Write the failing test**

Create `agent/internal/wizard/prompt_test.go`:

```go
package wizard

import "testing"

func TestFakePrompterConfirmDefault(t *testing.T) {
	fp := NewFakePrompter()
	fp.Answers.Confirms = []bool{true}
	got, err := fp.Confirm("question?", false)
	if err != nil {
		t.Fatal(err)
	}
	if !got {
		t.Errorf("Confirm returned false, want true (from scripted answer)")
	}
}

func TestFakePrompterSelectMulti(t *testing.T) {
	fp := NewFakePrompter()
	fp.Answers.Selections = [][]int{{0, 2}}
	got, err := fp.SelectMulti("pick", []string{"a", "b", "c"})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0] != 0 || got[1] != 2 {
		t.Errorf("selections = %v, want [0,2]", got)
	}
}

func TestFakePrompterExhaustedReturnsError(t *testing.T) {
	fp := NewFakePrompter()
	if _, err := fp.Confirm("q", false); err == nil {
		t.Fatal("expected error when answers exhausted")
	}
}
```

- [ ] **Step 3: Verify failure**

```bash
cd agent
go test ./internal/wizard/... -run FakePrompter
```

Expected: FAIL.

- [ ] **Step 4: Implement prompt.go**

Create `agent/internal/wizard/prompt.go`:

```go
package wizard

import "fmt"

// Prompter is the interface exposed to the enroll wizard. The stdin
// implementation uses charmbracelet/huh; tests inject FakePrompter to feed
// scripted answers without touching the real terminal.
type Prompter interface {
	Confirm(question string, def bool) (bool, error)
	SelectMulti(question string, options []string) ([]int, error)
	InputLine(question string) (string, error)
}

// FakePrompter consumes pre-scripted answers in order. Used by tests.
type FakePrompter struct {
	Answers struct {
		Confirms   []bool
		Selections [][]int
		Inputs     []string
	}
	confirmIdx int
	selectIdx  int
	inputIdx   int
}

func NewFakePrompter() *FakePrompter { return &FakePrompter{} }

func (p *FakePrompter) Confirm(_ string, _ bool) (bool, error) {
	if p.confirmIdx >= len(p.Answers.Confirms) {
		return false, fmt.Errorf("FakePrompter: Confirm answers exhausted (idx=%d)", p.confirmIdx)
	}
	v := p.Answers.Confirms[p.confirmIdx]
	p.confirmIdx++
	return v, nil
}

func (p *FakePrompter) SelectMulti(_ string, _ []string) ([]int, error) {
	if p.selectIdx >= len(p.Answers.Selections) {
		return nil, fmt.Errorf("FakePrompter: SelectMulti answers exhausted (idx=%d)", p.selectIdx)
	}
	v := p.Answers.Selections[p.selectIdx]
	p.selectIdx++
	return v, nil
}

func (p *FakePrompter) InputLine(_ string) (string, error) {
	if p.inputIdx >= len(p.Answers.Inputs) {
		return "", fmt.Errorf("FakePrompter: InputLine answers exhausted (idx=%d)", p.inputIdx)
	}
	v := p.Answers.Inputs[p.inputIdx]
	p.inputIdx++
	return v, nil
}

// StdinPrompter wraps huh. Real interactive flow.
type StdinPrompter struct{}

func NewStdinPrompter() *StdinPrompter { return &StdinPrompter{} }

func (StdinPrompter) Confirm(question string, def bool) (bool, error) {
	var out bool = def
	// Lazy import of huh kept inside the function so non-stdin paths
	// (i.e. tests via FakePrompter) don't have to pay the huh init cost.
	return out, runHuh(func() error {
		return huhConfirm(question, def, &out)
	})
}

func (StdinPrompter) SelectMulti(question string, options []string) ([]int, error) {
	var selected []int
	return selected, runHuh(func() error {
		return huhMultiSelect(question, options, &selected)
	})
}

func (StdinPrompter) InputLine(question string) (string, error) {
	var out string
	return out, runHuh(func() error {
		return huhInput(question, &out)
	})
}
```

Create `agent/internal/wizard/prompt_huh.go` (separated so the huh imports live in one spot):

```go
package wizard

import "github.com/charmbracelet/huh"

// runHuh is a thin indirection that runs the supplied form-builder and
// returns its error. The wrapper exists so prompt.go can stay focused on
// the Prompter contract.
func runHuh(fn func() error) error { return fn() }

func huhConfirm(question string, def bool, out *bool) error {
	*out = def
	return huh.NewConfirm().Title(question).Value(out).Run()
}

func huhMultiSelect(question string, options []string, out *[]int) error {
	opts := make([]huh.Option[int], len(options))
	for i, label := range options {
		opts[i] = huh.NewOption(label, i)
	}
	return huh.NewMultiSelect[int]().Title(question).Options(opts...).Value(out).Run()
}

func huhInput(question string, out *string) error {
	return huh.NewInput().Title(question).Value(out).Run()
}
```

- [ ] **Step 5: Verify pass**

```bash
cd agent
go test ./internal/wizard/... -run FakePrompter -v
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add agent/go.mod agent/go.sum agent/internal/wizard/prompt.go agent/internal/wizard/prompt_huh.go agent/internal/wizard/prompt_test.go
git commit -m "feat(agent): wizard.Prompter interface + huh stdin impl + FakePrompter for tests"
```

### Task 4.3: `internal/wizard/enroll` — RunEnrollWizard orchestrator

**Files:**
- Create: `agent/internal/wizard/enroll.go`
- Create: `agent/internal/wizard/enroll_test.go`

- [ ] **Step 1: Write the failing test**

Create `agent/internal/wizard/enroll_test.go`:

```go
package wizard

import (
	"context"
	"errors"
	"testing"

	"github.com/hanfour/ai-dev-eval/agent/internal/api"
	"github.com/hanfour/ai-dev-eval/agent/internal/config"
)

func TestRunEnrollWizard_HappyPathNoPaths(t *testing.T) {
	t.Setenv("CALIBER_AGENT_HOME", t.TempDir())

	fp := NewFakePrompter()
	fp.Answers.Confirms = []bool{true, true} // "begin?" yes, "confirm config" yes
	fp.Answers.Selections = [][]int{{}}      // user picks "none"

	var enrolledWith api.EnrollRequest
	var setSecretCalled bool
	deps := Deps{
		Prompter: fp,
		Scan:     func(string) ([]ProjectCandidate, error) { return nil, nil },
		Enroll: func(ctx context.Context, req api.EnrollRequest) (*api.EnrollResponse, error) {
			enrolledWith = req
			return &api.EnrollResponse{DeviceID: "d-1", Key: "cda_secret", KeyPrefix: "cda_xxxx"}, nil
		},
		SetSecret: func(account, secret string) error {
			setSecretCalled = true
			if account != "d-1" || secret != "cda_secret" {
				t.Errorf("SetSecret args wrong: %q / %q", account, secret)
			}
			return nil
		},
		Hostname:     "h4",
		OS:           "darwin 25.3.0",
		AgentVersion: "dev",
		APIBaseURL:   "http://localhost:3001",
	}
	if err := RunEnrollWizard(context.Background(), deps, "some-enroll-token"); err != nil {
		t.Fatalf("RunEnrollWizard: %v", err)
	}
	if !setSecretCalled {
		t.Error("SetSecret was not called")
	}
	if enrolledWith.Token != "some-enroll-token" || enrolledWith.Hostname != "h4" {
		t.Errorf("Enroll called with %+v", enrolledWith)
	}

	got, err := config.Load()
	if err != nil {
		t.Fatalf("config.Load: %v", err)
	}
	if got.DeviceID != "d-1" {
		t.Errorf("DeviceID = %q", got.DeviceID)
	}
	if len(got.IncludePaths) != 0 {
		t.Errorf("IncludePaths = %v, want empty (privacy default)", got.IncludePaths)
	}
}

func TestRunEnrollWizard_TokenInvalid(t *testing.T) {
	t.Setenv("CALIBER_AGENT_HOME", t.TempDir())
	fp := NewFakePrompter()
	fp.Answers.Confirms = []bool{true}
	deps := Deps{
		Prompter: fp,
		Scan:     func(string) ([]ProjectCandidate, error) { return nil, nil },
		Enroll: func(_ context.Context, _ api.EnrollRequest) (*api.EnrollResponse, error) {
			return nil, &api.APIError{StatusCode: 401, ErrorTag: "invalid_token"}
		},
		SetSecret: func(_, _ string) error {
			t.Fatal("SetSecret must NOT be called on 401")
			return nil
		},
	}
	err := RunEnrollWizard(context.Background(), deps, "bad")
	if !errors.Is(err, api.ErrInvalidToken) {
		t.Fatalf("err = %v, want ErrInvalidToken", err)
	}
	if _, lerr := config.Load(); !errors.Is(lerr, config.ErrNotEnrolled) {
		t.Errorf("config should not exist after 401, got: %v", lerr)
	}
}

func TestRunEnrollWizard_KeychainFailsAfterAPI(t *testing.T) {
	t.Setenv("CALIBER_AGENT_HOME", t.TempDir())
	fp := NewFakePrompter()
	fp.Answers.Confirms = []bool{true}
	deps := Deps{
		Prompter: fp,
		Scan:     func(string) ([]ProjectCandidate, error) { return nil, nil },
		Enroll: func(_ context.Context, _ api.EnrollRequest) (*api.EnrollResponse, error) {
			return &api.EnrollResponse{DeviceID: "d-X", Key: "cda_lost_secret"}, nil
		},
		SetSecret: func(_, _ string) error { return errors.New("keychain: permission denied") },
	}
	err := RunEnrollWizard(context.Background(), deps, "t")
	if err == nil {
		t.Fatal("expected error when SetSecret fails")
	}
	// Per spec §5 Failure C: the raw key must be surfaced. The wizard's
	// returned error wraps the keychain error; the caller is responsible
	// for emitting the user-visible recovery message. We verify the error
	// chain carries a marker so the cli layer can detect this case.
	var lk *LostKeyError
	if !errors.As(err, &lk) {
		t.Fatalf("err = %v, want *LostKeyError chain", err)
	}
	if lk.RawKey != "cda_lost_secret" || lk.DeviceID != "d-X" {
		t.Errorf("LostKeyError = %+v", lk)
	}
	if _, lerr := config.Load(); !errors.Is(lerr, config.ErrNotEnrolled) {
		t.Errorf("config must not be written on Failure C, got: %v", lerr)
	}
}
```

- [ ] **Step 2: Verify failure**

```bash
cd agent
go test ./internal/wizard/... -run RunEnrollWizard
```

Expected: FAIL.

- [ ] **Step 3: Implement enroll.go**

Create `agent/internal/wizard/enroll.go`:

```go
package wizard

import (
	"context"
	"fmt"

	"github.com/hanfour/ai-dev-eval/agent/internal/api"
	"github.com/hanfour/ai-dev-eval/agent/internal/config"
)

// Deps is the dependency bag for RunEnrollWizard. Splitting them out makes
// the wizard trivially testable: production wires real api.Client + keychain
// callbacks; tests pass fakes.
type Deps struct {
	Prompter Prompter
	Scan     func(root string) ([]ProjectCandidate, error)
	Enroll   func(ctx context.Context, req api.EnrollRequest) (*api.EnrollResponse, error)
	SetSecret func(account, secret string) error

	// Static metadata shipped in the enroll request body.
	Hostname     string
	OS           string
	AgentVersion string

	// Persisted into the new config.toml.
	APIBaseURL       string
	ClaudeProjectsRoot string // typically ~/.claude/projects
}

// LostKeyError is returned by RunEnrollWizard when the server returned a
// device key but the daemon could not persist it. The cli layer detects
// this via errors.As and emits the Failure-C user message (spec §5).
type LostKeyError struct {
	DeviceID string
	RawKey   string
	Cause    error
}

func (e *LostKeyError) Error() string {
	return fmt.Sprintf("api returned device key but local storage failed: %v", e.Cause)
}
func (e *LostKeyError) Unwrap() error { return e.Cause }

// RunEnrollWizard orchestrates the full enroll flow defined in spec §5.
// On success the function returns nil and the config has been written.
// On failure it returns a typed error suitable for cli.ExitFromErr.
func RunEnrollWizard(ctx context.Context, d Deps, token string) error {
	// Step 1: Confirm intent before anything observable happens.
	begin, err := d.Prompter.Confirm("Begin device enrollment with caliber?", true)
	if err != nil {
		return err
	}
	if !begin {
		return fmt.Errorf("enrollment cancelled by user")
	}

	// Step 2: Server credential exchange.
	resp, err := d.Enroll(ctx, api.EnrollRequest{
		Token:        token,
		Hostname:     d.Hostname,
		OS:           d.OS,
		AgentVersion: d.AgentVersion,
	})
	if err != nil {
		return err
	}

	// Step 3: Keychain. Failure here is Failure C — credentials are lost
	// because the API call already succeeded but we can't store them.
	if err := d.SetSecret(resp.DeviceID, resp.Key); err != nil {
		return &LostKeyError{DeviceID: resp.DeviceID, RawKey: resp.Key, Cause: err}
	}

	// Step 4: Initial config.toml with empty IncludePaths (privacy default).
	cfg := &config.Config{
		DeviceID:     resp.DeviceID,
		Hostname:     d.Hostname,
		OS:           d.OS,
		APIBaseURL:   d.APIBaseURL,
		Mode:         "metadata-only",
		IncludePaths: []string{},
	}
	if err := config.Save(cfg); err != nil {
		return fmt.Errorf("config save: %w", err)
	}

	// Step 5: Scan + present candidate paths. Default is "none".
	cands, _ := d.Scan(d.ClaudeProjectsRoot)
	options := make([]string, 0, len(cands)+1)
	options = append(options, "None — start with 0 paths (recommended)")
	for _, c := range cands {
		options = append(options, c.CWD)
	}
	picks, err := d.Prompter.SelectMulti("Which projects should caliber-agent watch?", options)
	if err != nil {
		return err
	}
	include := []string{}
	for _, idx := range picks {
		if idx == 0 {
			// "None" picked; treat as empty regardless of other picks.
			include = nil
			include = []string{}
			break
		}
		if idx-1 < len(cands) {
			include = append(include, cands[idx-1].CWD)
		}
	}

	// Step 6: Final confirm + write.
	confirmed, err := d.Prompter.Confirm(fmt.Sprintf("Save config with %d include_paths?", len(include)), true)
	if err != nil {
		return err
	}
	if !confirmed {
		return nil // wizard ends but keychain + initial config persist
	}
	cfg.IncludePaths = include
	if err := config.Save(cfg); err != nil {
		return fmt.Errorf("config save (paths): %w", err)
	}
	return nil
}
```

- [ ] **Step 4: Verify pass**

```bash
cd agent
go test ./internal/wizard/... -v -race
```

Expected: PASS, all wizard tests green.

- [ ] **Step 5: Commit**

```bash
git add agent/internal/wizard/enroll.go agent/internal/wizard/enroll_test.go
git commit -m "feat(agent): wizard.RunEnrollWizard with LostKeyError on Failure C"
```

---

## Phase 5 — CLI command wiring

Wire `enroll` to its dependencies and add stubs for every other command in the spec so the public CLI surface is frozen at PR1 (spec §8).

### Task 5.1: Add `not yet implemented` stubs for non-PR1 commands

**Files:**
- Create: `agent/internal/cli/status.go`
- Create: `agent/internal/cli/addpath.go`
- Create: `agent/internal/cli/removepath.go`
- Create: `agent/internal/cli/pause.go`
- Create: `agent/internal/cli/resume.go`
- Create: `agent/internal/cli/setmode.go`
- Create: `agent/internal/cli/uninstall.go`
- Create: `agent/internal/cli/stubs_test.go`
- Modify: `agent/internal/cli/root.go` (register the new commands)

- [ ] **Step 1: Write the stub-coverage test**

Create `agent/internal/cli/stubs_test.go`:

```go
package cli

import (
	"bytes"
	"context"
	"errors"
	"testing"
)

func runCmd(t *testing.T, args ...string) error {
	t.Helper()
	cmd := New()
	var buf bytes.Buffer
	cmd.SetOut(&buf)
	cmd.SetErr(&buf)
	cmd.SetArgs(args)
	return cmd.ExecuteContext(context.Background())
}

func TestEachStubReturnsExit64(t *testing.T) {
	commands := []string{"status", "add-path", "remove-path", "pause", "resume", "set-mode", "uninstall"}
	for _, name := range commands {
		t.Run(name, func(t *testing.T) {
			err := runCmd(t, name)
			if err == nil {
				t.Fatalf("%s: expected error", name)
			}
			var ee *ExitError
			if !errors.As(err, &ee) {
				t.Fatalf("%s: expected *ExitError, got %T", name, err)
			}
			if ee.Code != 64 {
				t.Errorf("%s: code = %d, want 64", name, ee.Code)
			}
		})
	}
}
```

- [ ] **Step 2: Verify failure**

```bash
cd agent
go test ./internal/cli/... -run Stubs
```

Expected: FAIL — commands not registered.

- [ ] **Step 3: Implement the seven stub files**

For each command, create a one-file stub. Example for `agent/internal/cli/status.go`:

```go
package cli

import "github.com/spf13/cobra"

func newStatusCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "status",
		Short: "Show daemon status (not yet implemented)",
		RunE: func(_ *cobra.Command, _ []string) error {
			return ExitNotImplemented("status")
		},
	}
}
```

Repeat verbatim with `status` swapped out, for the other six. Each file is identical apart from the command name in three places (`Use`, function name, `ExitNotImplemented` arg):

- `agent/internal/cli/addpath.go` → `newAddPathCmd`, `Use: "add-path"`, `ExitNotImplemented("add-path")`
- `agent/internal/cli/removepath.go` → `newRemovePathCmd`, `Use: "remove-path"`, `ExitNotImplemented("remove-path")`
- `agent/internal/cli/pause.go` → `newPauseCmd`, `Use: "pause"`, `ExitNotImplemented("pause")`
- `agent/internal/cli/resume.go` → `newResumeCmd`, `Use: "resume"`, `ExitNotImplemented("resume")`
- `agent/internal/cli/setmode.go` → `newSetModeCmd`, `Use: "set-mode"`, `ExitNotImplemented("set-mode")`
- `agent/internal/cli/uninstall.go` → `newUninstallCmd`, `Use: "uninstall"`, `ExitNotImplemented("uninstall")`

- [ ] **Step 4: Register the stubs in `root.go`**

In `agent/internal/cli/root.go`, replace the section that adds commands with:

```go
	cmd.AddCommand(newVersionCmd())
	cmd.AddCommand(newStatusCmd())
	cmd.AddCommand(newAddPathCmd())
	cmd.AddCommand(newRemovePathCmd())
	cmd.AddCommand(newPauseCmd())
	cmd.AddCommand(newResumeCmd())
	cmd.AddCommand(newSetModeCmd())
	cmd.AddCommand(newUninstallCmd())
```

(`newEnrollCmd` is added in Task 5.2.)

- [ ] **Step 5: Verify pass**

```bash
cd agent
go test ./internal/cli/... -v
```

Expected: PASS, all 7 stub sub-tests green.

- [ ] **Step 6: Commit**

```bash
git add agent/internal/cli/
git commit -m "feat(agent): stub status/add-path/remove-path/pause/resume/set-mode/uninstall → exit 64"
```

### Task 5.2: Wire the real `enroll` command

**Files:**
- Create: `agent/internal/cli/enroll.go`
- Create: `agent/internal/cli/enroll_test.go`
- Modify: `agent/internal/cli/root.go`

- [ ] **Step 1: Write the failing integration test**

Create `agent/internal/cli/enroll_test.go`:

```go
package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/hanfour/ai-dev-eval/agent/internal/config"
	"github.com/hanfour/ai-dev-eval/agent/internal/keychain"
)

// withFakeSecurity rewrites keychain.SecurityBin to a stub that records argv.
// Returns the recorded log path.
func withFakeSecurity(t *testing.T, exitCode int, stdoutLine string) string {
	t.Helper()
	dir := t.TempDir()
	script := "#!/bin/sh\necho \"$@\" >> \"" + dir + "/argv.log\"\n"
	if stdoutLine != "" {
		script += "echo \"" + stdoutLine + "\"\n"
	}
	if exitCode != 0 {
		script += "exit 1\n"
	}
	path := filepath.Join(dir, "security")
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	orig := keychain.SecurityBin
	keychain.SecurityBin = path
	t.Cleanup(func() { keychain.SecurityBin = orig })
	return filepath.Join(dir, "argv.log")
}

func TestEnrollHappyPath_WritesConfigAndKeychain(t *testing.T) {
	t.Setenv("CALIBER_AGENT_HOME", t.TempDir())
	argvLog := withFakeSecurity(t, 0, "")

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]string
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["token"] == "" {
			t.Errorf("server received empty token")
		}
		w.WriteHeader(201)
		w.Write([]byte(`{"deviceId":"d-7","key":"cda_test_secret","keyPrefix":"cda_test"}`))
	}))
	defer srv.Close()
	t.Setenv("CALIBER_API_BASE_URL", srv.URL)

	// Inject FakePrompter into the enroll command via the test-only hook.
	useFakePrompter(t, []bool{true, true}, [][]int{{0}})

	cmd := New()
	var buf bytes.Buffer
	cmd.SetOut(&buf)
	cmd.SetErr(&buf)
	cmd.SetArgs([]string{"enroll", "some-enroll-token"})

	if err := cmd.ExecuteContext(context.Background()); err != nil {
		t.Fatalf("enroll: %v\noutput: %s", err, buf.String())
	}

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("config.Load: %v", err)
	}
	if cfg.DeviceID != "d-7" {
		t.Errorf("DeviceID = %q", cfg.DeviceID)
	}
	if len(cfg.IncludePaths) != 0 {
		t.Errorf("IncludePaths = %v, want empty", cfg.IncludePaths)
	}

	logBytes, _ := os.ReadFile(argvLog)
	if !strings.Contains(string(logBytes), "add-generic-password") {
		t.Errorf("fake security not invoked: %s", logBytes)
	}
}

func TestEnrollAlreadyEnrolled_ReturnsExit1(t *testing.T) {
	home := t.TempDir()
	t.Setenv("CALIBER_AGENT_HOME", home)
	if err := config.Save(&config.Config{DeviceID: "existing"}); err != nil {
		t.Fatal(err)
	}

	cmd := New()
	var buf bytes.Buffer
	cmd.SetOut(&buf)
	cmd.SetErr(&buf)
	cmd.SetArgs([]string{"enroll", "t"})
	err := cmd.ExecuteContext(context.Background())

	var ee *ExitError
	if !errors.As(err, &ee) {
		t.Fatalf("err = %v, want *ExitError", err)
	}
	if ee.Code != 1 {
		t.Errorf("Code = %d, want 1", ee.Code)
	}
}

func TestEnrollMissingBaseURL_ReturnsExit1(t *testing.T) {
	t.Setenv("CALIBER_AGENT_HOME", t.TempDir())
	t.Setenv("CALIBER_API_BASE_URL", "")

	cmd := New()
	var buf bytes.Buffer
	cmd.SetOut(&buf)
	cmd.SetErr(&buf)
	cmd.SetArgs([]string{"enroll", "t"})
	err := cmd.ExecuteContext(context.Background())

	if err == nil {
		t.Fatal("expected error when API base URL is unset")
	}
	if !strings.Contains(err.Error(), "api base url") && !strings.Contains(err.Error(), "API base URL") {
		t.Errorf("error should mention API base URL, got: %v", err)
	}
}
```

- [ ] **Step 2: Verify failure**

```bash
cd agent
go test ./internal/cli/... -run Enroll
```

Expected: FAIL.

- [ ] **Step 3: Implement enroll.go**

Create `agent/internal/cli/enroll.go`:

```go
package cli

import (
	"errors"
	"fmt"
	"os"
	"runtime"
	"testing"

	"github.com/spf13/cobra"

	"github.com/hanfour/ai-dev-eval/agent/internal/api"
	"github.com/hanfour/ai-dev-eval/agent/internal/config"
	"github.com/hanfour/ai-dev-eval/agent/internal/keychain"
	"github.com/hanfour/ai-dev-eval/agent/internal/version"
	"github.com/hanfour/ai-dev-eval/agent/internal/wizard"
)

// testPrompterHook lets enroll_test.go inject a FakePrompter without
// touching the production path. Production sets this to nil and we fall
// through to the real stdin prompter.
var testPrompterHook wizard.Prompter

// useFakePrompter is a test helper imported by enroll_test.go.
func useFakePrompter(t *testing.T, confirms []bool, selections [][]int) {
	t.Helper()
	fp := wizard.NewFakePrompter()
	fp.Answers.Confirms = confirms
	fp.Answers.Selections = selections
	testPrompterHook = fp
	t.Cleanup(func() { testPrompterHook = nil })
}

func newEnrollCmd() *cobra.Command {
	var force bool
	cmd := &cobra.Command{
		Use:   "enroll <token>",
		Short: "Enrol this device with caliber using a one-shot enrollment token",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return runEnroll(cmd, args[0], force)
		},
	}
	cmd.Flags().BoolVar(&force, "force", false, "re-enroll over an existing device")
	return cmd
}

func runEnroll(cmd *cobra.Command, token string, force bool) error {
	// Already enrolled?
	if existing, err := config.Load(); err == nil && !force {
		return &ExitError{Code: 1, Err: fmt.Errorf("device already enrolled as %q; use --force to re-enroll", existing.DeviceID)}
	} else if err != nil && !errors.Is(err, config.ErrNotEnrolled) {
		return &ExitError{Code: 1, Err: err}
	}

	// Resolve API base URL: flag > env > (config — N/A during enroll).
	baseURL := flags.APIBaseURL
	if baseURL == "" {
		baseURL = os.Getenv("CALIBER_API_BASE_URL")
	}
	if baseURL == "" {
		return &ExitError{Code: 1, Err: fmt.Errorf("API base URL not configured: pass --api-base-url or set CALIBER_API_BASE_URL")}
	}

	prompter := wizard.Prompter(wizard.NewStdinPrompter())
	if testPrompterHook != nil {
		prompter = testPrompterHook
	}

	hostname, _ := os.Hostname()
	osName := fmt.Sprintf("%s %s", runtime.GOOS, runtime.GOARCH)

	deps := wizard.Deps{
		Prompter:           prompter,
		Scan:               wizard.ScanClaudeProjects,
		Enroll:             api.NewClient(baseURL, "caliber-agent/"+version.Version).Enroll,
		SetSecret:          keychain.Set,
		Hostname:           hostname,
		OS:                 osName,
		AgentVersion:       version.Version,
		APIBaseURL:         baseURL,
		ClaudeProjectsRoot: claudeProjectsRoot(),
	}
	if err := wizard.RunEnrollWizard(cmd.Context(), deps, token); err != nil {
		return ExitFromErr(translateEnrollErr(err))
	}
	fmt.Fprintln(cmd.OutOrStdout(), "✓ Enrolled. Watcher arrives in next release.")
	return nil
}

func translateEnrollErr(err error) error {
	var lk *wizard.LostKeyError
	if errors.As(err, &lk) {
		// Failure C — emit raw key to stderr per spec §5 before propagating.
		fmt.Fprintf(os.Stderr,
			"ERROR: API returned a device key but local storage failed (%v).\n"+
				"  device_id: %s\n"+
				"  key:       %s\n"+
				"To clean up, revoke this device in /dashboard/devices and try again.\n"+
				"The key has NOT been saved locally and CANNOT be retrieved later.\n",
			lk.Cause, lk.DeviceID, lk.RawKey)
	}
	return err
}

// claudeProjectsRoot returns the default ~/.claude/projects path. Tests can
// override via CALIBER_CLAUDE_PROJECTS env (undocumented; tests only).
func claudeProjectsRoot() string {
	if override := os.Getenv("CALIBER_CLAUDE_PROJECTS"); override != "" {
		return override
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return home + "/.claude/projects"
}
```

- [ ] **Step 4: Register `enroll` in `root.go`**

In `agent/internal/cli/root.go`, append `cmd.AddCommand(newEnrollCmd())` to the AddCommand block.

- [ ] **Step 5: Verify pass**

```bash
cd agent
go test ./internal/cli/... -v -race
```

Expected: PASS, all cli tests green (version, stubs × 7, enroll happy / already / missing-url).

- [ ] **Step 6: Commit**

```bash
git add agent/internal/cli/
git commit -m "feat(agent): cli.enroll wires wizard + api + keychain end-to-end with Failure-C handling"
```

### Task 5.3: Coverage gate sanity check

**Files:** (no new files; verify-only)

- [ ] **Step 1: Run the full agent test suite with coverage**

```bash
cd agent
go test ./internal/... -race -coverprofile=cover.out
go tool cover -func=cover.out | tail -1
```

Expected: total coverage ≥ 80%. If below, identify the under-tested package and add a focused test for the gap (most likely candidates: `internal/cli/root.go` unknown-command path, `internal/api/client.go` timeout branch).

- [ ] **Step 2: Clean up the coverage profile (not committed)**

```bash
rm agent/cover.out
```

---

## Phase 6 — CI, release pipeline, Homebrew stub, smoke, README

Locks the public contracts from spec §8: tag pattern, exit codes, paths, env vars. Watchman PRs build on top of these.

### Task 6.1: `agent-ci.yml` GitHub Actions workflow

**Files:**
- Create: `.github/workflows/agent-ci.yml`

- [ ] **Step 1: Create the workflow**

Create `.github/workflows/agent-ci.yml`:

```yaml
name: agent-ci

on:
  push:
    paths:
      - 'agent/**'
      - '.github/workflows/agent-*.yml'
  pull_request:
    paths:
      - 'agent/**'
      - '.github/workflows/agent-*.yml'

defaults:
  run:
    working-directory: agent

jobs:
  test:
    runs-on: macos-14
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version-file: agent/go.mod
          cache-dependency-path: agent/go.sum
      - name: Install staticcheck
        run: go install honnef.co/go/tools/cmd/staticcheck@latest
      - run: go vet ./...
      - run: staticcheck ./...
      - name: gofmt
        run: test -z "$(gofmt -l .)"
      - run: go test ./internal/... -race -coverprofile=cover.out
      - name: Coverage gate (≥ 80%)
        run: |
          total=$(go tool cover -func=cover.out | tail -1 | awk '{print $3}' | tr -d %)
          echo "total: $total%"
          awk -v t="$total" 'BEGIN { exit (t+0 < 80.0) }'
```

- [ ] **Step 2: Validate the YAML syntactically**

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/agent-ci.yml'))"
```

Expected: no output (parse succeeds).

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/agent-ci.yml
git commit -m "ci(agent): vet + staticcheck + gofmt + race tests + 80% coverage gate"
```

### Task 6.2: `agent-release.yml` workflow

**Files:**
- Create: `.github/workflows/agent-release.yml`

- [ ] **Step 1: Create the workflow**

Create `.github/workflows/agent-release.yml`:

```yaml
name: agent-release

on:
  push:
    tags:
      - 'agent/v*'

jobs:
  build:
    runs-on: macos-14
    strategy:
      matrix:
        include:
          - goos: darwin
            goarch: arm64
          - goos: darwin
            goarch: amd64
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version-file: agent/go.mod
          cache-dependency-path: agent/go.sum

      - name: Build
        working-directory: agent
        env:
          GOOS: ${{ matrix.goos }}
          GOARCH: ${{ matrix.goarch }}
        run: |
          TAG="${GITHUB_REF#refs/tags/}"
          COMMIT="${GITHUB_SHA::7}"
          BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
          mkdir -p ../dist
          go build -trimpath \
            -ldflags "-s -w \
              -X github.com/hanfour/ai-dev-eval/agent/internal/version.Version=${TAG} \
              -X github.com/hanfour/ai-dev-eval/agent/internal/version.Commit=${COMMIT} \
              -X github.com/hanfour/ai-dev-eval/agent/internal/version.BuiltAt=${BUILT_AT}" \
            -o ../dist/caliber-agent \
            ./cmd/caliber-agent

      - name: Tar + sha256
        working-directory: dist
        run: |
          TAG="${GITHUB_REF#refs/tags/}"
          SAFE_TAG="${TAG//\//_}"
          NAME="caliber-agent-${SAFE_TAG}-${{ matrix.goos }}-${{ matrix.goarch }}"
          tar -czf "${NAME}.tar.gz" caliber-agent
          shasum -a 256 "${NAME}.tar.gz" > "${NAME}.tar.gz.sha256"
          ls -la

      - uses: softprops/action-gh-release@v2
        with:
          files: |
            dist/caliber-agent-*.tar.gz
            dist/caliber-agent-*.tar.gz.sha256
```

- [ ] **Step 2: Validate the YAML**

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/agent-release.yml'))"
```

Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/agent-release.yml
git commit -m "ci(agent): release workflow — darwin/arm64+amd64 cross-compile on agent/v* tags"
```

### Task 6.3: Homebrew formula stub + smoke script + README

**Files:**
- Create: `agent/dist/Formula/caliber-agent.rb`
- Create: `agent/scripts/smoke.sh`
- Create: `agent/README.md`

- [ ] **Step 1: Formula stub**

Create `agent/dist/Formula/caliber-agent.rb`:

```ruby
class CaliberAgent < Formula
  desc "Caliber daemon: ship LLM coding-session telemetry from local clients to caliber"
  homepage "https://github.com/hanfour/caliber"
  version "0.1.0-pre"
  on_macos do
    on_arm do
      url "https://github.com/hanfour/caliber/releases/download/agent/v0.1.0-pre/caliber-agent-agent_v0.1.0-pre-darwin-arm64.tar.gz"
      sha256 "<placeholder-fill-from-gh-release-sha256-sidecar>"
    end
    on_intel do
      url "https://github.com/hanfour/caliber/releases/download/agent/v0.1.0-pre/caliber-agent-agent_v0.1.0-pre-darwin-amd64.tar.gz"
      sha256 "<placeholder-fill-from-gh-release-sha256-sidecar>"
    end
  end
  def install
    bin.install "caliber-agent"
  end
  def caveats
    <<~EOS
      caliber-agent is currently an interactive CLI. Background daemon
      mode (launchd integration) ships in the next release.
    EOS
  end
end
```

- [ ] **Step 2: Smoke script**

Create `agent/scripts/smoke.sh`:

```bash
#!/usr/bin/env bash
# Manual smoke against running local caliber stack.
# Not in CI. Run before merging PR1.
set -euo pipefail

TOKEN="${1:?usage: $0 <enrollment-token>}"
WORKDIR=$(mktemp -d)
trap 'rm -rf "$WORKDIR"' EXIT

# Build runs inside the agent module — relative ./cmd path is module-relative.
( cd "$(dirname "$0")/.." && go build -o "$WORKDIR/caliber-agent" ./cmd/caliber-agent )

CALIBER_API_BASE_URL=http://localhost:3001 \
CALIBER_AGENT_HOME="$WORKDIR/home" \
  "$WORKDIR/caliber-agent" enroll "$TOKEN"

security find-generic-password -s tw.caliber.agent >/dev/null && echo "PASS: keychain entry exists"
test -f "$WORKDIR/home/config.toml" && echo "PASS: config.toml exists"
grep -q 'include_paths = \[\]' "$WORKDIR/home/config.toml" && echo "PASS: include_paths defaults empty"
```

Make it executable:

```bash
chmod +x agent/scripts/smoke.sh
```

- [ ] **Step 3: README**

Create `agent/README.md`:

```markdown
# caliber-agent

Go single-binary daemon that ships LLM coding-session telemetry from local
Claude / Codex transcripts to a caliber instance.

**Status (PR1):** scaffolding + interactive `enroll`. Watcher, ingest,
launchd, and the remaining commands land in subsequent PRs.

## Install

```sh
brew install hanfour/caliber/caliber-agent  # once the tap is published
# or download a release binary:
curl -L https://github.com/hanfour/caliber/releases/download/agent/v0.1.0/caliber-agent-agent_v0.1.0-darwin-arm64.tar.gz | tar -xz
```

## Enrol a device

1. In the caliber web UI, go to `/dashboard/devices` and click "Issue
   enrollment token". Copy the token.
2. Run:

   ```sh
   CALIBER_API_BASE_URL=https://your-caliber.example caliber-agent enroll <token>
   ```

The interactive wizard prompts for which project paths to watch. The
default is **none** — caliber-agent will not upload anything until you
explicitly add paths. This is a deliberate privacy contract.

## Environment

- `CALIBER_AGENT_HOME` — config root, defaults to `~/.caliber-agent`
- `CALIBER_API_BASE_URL` — caliber API URL (required during `enroll`)

## Build from source

```sh
git clone https://github.com/hanfour/caliber
cd caliber/agent
go build -o caliber-agent ./cmd/caliber-agent
```

## Release tag pattern

The agent uses its own tag namespace `agent/v*` so it can be released on
a separate cadence from the main caliber server.
```

- [ ] **Step 4: Quick build sanity check**

```bash
cd agent
go build -o /tmp/ca-sanity ./cmd/caliber-agent
/tmp/ca-sanity version
/tmp/ca-sanity status   # should exit 64 with "not yet implemented"
rm /tmp/ca-sanity
```

Expected: `version` prints `dev (unknown, unknown)`; `status` exits 64.

- [ ] **Step 5: Commit**

```bash
git add agent/dist/Formula/caliber-agent.rb agent/scripts/smoke.sh agent/README.md
git commit -m "feat(agent): Homebrew formula stub, smoke script, README"
```

---

## Phase 7 — Local smoke + PR

### Task 7.1: Smoke against the live local stack

**Files:** (none — verification step)

- [ ] **Step 1: Confirm the local stack is up**

```bash
docker ps --format '{{.Names}} {{.Status}}' | grep caliber
```

Expected: docker-api-1, docker-gateway-1, docker-web-1 all healthy.

- [ ] **Step 2: Issue an enrollment token via the dashboard**

Open `http://localhost:3000/dashboard/devices` in a browser, sign in, click "Issue enrollment token", copy the token.

- [ ] **Step 3: Run the smoke script**

```bash
./agent/scripts/smoke.sh <paste-token-here>
```

Expected: three `PASS:` lines printed, exit 0.

- [ ] **Step 4: Verify the device showed up in caliber**

Refresh `/dashboard/devices`. The new device should be listed with the hostname matching `hostname -s`.

- [ ] **Step 5: Tear-down (optional)**

In `/dashboard/devices`, revoke the smoke-test device so it doesn't pollute the device list.

### Task 7.2: Open the PR

**Files:** (none)

- [ ] **Step 1: Push the branch and open the PR**

```bash
git push -u origin <branch-name>
gh pr create --title "feat(agent): Phase 2 PR1 — scaffold + enroll end-to-end" --body "$(cat <<'EOF'
## Summary
- New Go module at `agent/` (`github.com/hanfour/ai-dev-eval/agent`)
- `caliber-agent enroll <token>` end-to-end: API exchange → macOS keychain → `~/.caliber-agent/config.toml` → interactive project-path wizard (empty-default)
- Stubs for all other commands return exit 64 to freeze the CLI surface
- GitHub Actions: `agent-ci.yml` (vet + staticcheck + race tests + 80% coverage gate), `agent-release.yml` (darwin/arm64+amd64 cross-compile on `agent/v*` tags)
- Homebrew formula stub in `agent/dist/Formula/caliber-agent.rb`

## Design doc
`docs/superpowers/specs/2026-05-21-caliber-agent-phase2-pr1-design.md`

## Out of scope (deferred to later PRs)
- claude-code / codex watchers (PR2)
- `POST /v1/ingest` client + redaction (PR3)
- launchd plist + `install-launchd` (PR4)
- Real implementations of status/pause/resume/add-path/remove-path/set-mode/uninstall (PR4+)
- Homebrew tap push automation (manual for now)

## Prerequisite
- [x] `fix(api): serialise concurrent device enrollments` (Phase 0 PR) merged

## Test plan
- [x] `cd agent && go test ./internal/... -race -cover` ≥ 80% locally
- [x] `agent/scripts/smoke.sh <token>` against local v0.7.0 stack — three PASS lines, device appears in dashboard
- [x] CI green
EOF
)"
```

- [ ] **Step 2: Return the PR URL to the user**

---

## Self-Review

Before considering this plan done, an engineer reading task-by-task can verify:

**Spec coverage**
- §1–§3 (goal, non-goals, layout): Phase 1 tasks 1.1–1.5 create the module + entry point. Layout matches.
- §4.1 version: Task 1.2.
- §4.2 keychain: Task 2.4 (darwin + non-darwin, injectable SecurityBin).
- §4.3 config: Tasks 2.1–2.3 (paths, config, state).
- §4.4 api: Tasks 3.1–3.2 (errors + client).
- §4.5 wizard: Tasks 4.1–4.3 (projects, prompt, enroll orchestrator).
- §4.6 cli: Tasks 1.3–1.4 (exit plumbing + root + version), Tasks 5.1–5.2 (stubs + enroll).
- §4.7 main + signal/recover: Task 1.5.
- §5 data flow (happy + Failures A–H): Tasks 4.3 + 5.2 cover Failures A (already enrolled), B (token rejected), C (LostKeyError), D (Ctrl-C → context.Canceled → 130), G (no API base URL), H (panic in main). E (network error) and F (non-darwin) are covered by the api client tests and the keychain stub respectively.
- §6 error principles: enforced by Task 3.1 (typed APIError) + Task 1.3 (ExitError).
- §7 testing: per-package tests in every implementation task, plus Task 5.3 coverage gate + Task 6.1 CI gate.
- §8 public contract: frozen by Tasks 5.1 (stub set), 6.2 (tag pattern), 6.3 (formula version).
- §9 risks: huh binary size, security flakiness, tag-collision — accepted in spec.
- §9a server prerequisite: Phase 0 (Task 0.1).

**Placeholder scan**
- No "TBD", "TODO", "fill in details" in any task body. The Homebrew formula contains `<placeholder-fill-from-gh-release-sha256-sidecar>` — that is the deliberate sha256 placeholder documented in spec §7, not a plan failure.
- No "Add appropriate error handling" — every step shows actual code.
- "Similar to Task N" — Task 5.1 step 3 says "Repeat verbatim with `status` swapped out" for six near-identical stub files. The exemplar code IS shown; the diff between files is mechanical (three string changes) and the substitution rule is explicit.

**Type consistency**
- `Config` shape: identical across Tasks 2.2, 4.3, 5.2.
- `EnrollRequest`/`EnrollResponse`: identical across Tasks 3.2, 4.3, 5.2.
- `*ExitError`: created in 1.3, used in 5.1, 5.2.
- `LostKeyError`: defined in 4.3, detected in 5.2 (`translateEnrollErr`).
- `Prompter` interface: defined in 4.2, consumed in 4.3, injected via `testPrompterHook` in 5.2.
- `ScanClaudeProjects(root)` vs `scanClaudeProjects(root, opener)`: exported wired in 5.2 (`deps.Scan: wizard.ScanClaudeProjects`); unexported used in 4.1 byte-budget tests.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-21-caliber-agent-phase2-pr1.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**

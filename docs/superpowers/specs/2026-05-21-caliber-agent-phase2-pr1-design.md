# caliber-agent Phase 2 PR1 — Scaffold + enroll end-to-end

**Date:** 2026-05-21
**Author:** brainstorming session (h4 + Claude)
**Status:** Approved design, pending implementation
**Parent spec:** `docs/superpowers/specs/2026-05-18-multi-source-ingest-design.md` (Phase 2 — Daemon MVP)
**Tracking PR:** to be created

---

## 1. Goal

Land the first PR of Phase 2 `caliber-agent` daemon. PR1 establishes the Go module, CLI structure, end-to-end `enroll` command (server credential exchange → macOS keychain → config.toml → interactive privacy-default wizard), and the release pipeline (GitHub Actions cross-compile, Homebrew formula stub). PR1 deliberately excludes the watcher, ingest client, launchd plist, and all daemon-loop behaviour — those land in later PRs of Phase 2.

The success criterion for PR1: a fresh macOS workstation can run `caliber-agent enroll <cda_token>` against a live caliber stack, walk through an interactive wizard that defaults the project allow-list to empty, and exit with a stored device key in keychain plus a valid `~/.caliber-agent/config.toml`.

---

## 2. Non-Goals (explicit)

The following are intentionally out of scope for PR1 and have their own future PRs:

- claude-code transcript watcher (`~/.claude/projects/`)
- codex sessions watcher (`~/.codex/sessions/`)
- ingest HTTP client (`POST /v1/ingest` chunked gzip upload)
- watermark persistence loop (only `state.json` skeleton lands)
- redaction layer (modes: `metadata-only` / `redacted-body` / `full-body`)
- launchd plist (`tw.caliber.agent.plist`) and `caliber-agent install-launchd`
- `status` / `pause` / `resume` / `set-mode` / `add-path` / `remove-path` / `uninstall` command implementations — these are wired into the Cobra tree but return `exit 64 not yet implemented`
- Homebrew tap push automation (the formula stub ships in `agent/dist/Formula/`, but pushing to a tap repo is manual)
- Linux build target (workflow matrix targets darwin/{arm64,amd64} only)
- Logging to disk (`~/.caliber-agent/agent.log` — wired in watcher PR)

---

## 3. Repo Layout

PR1 introduces `ai-dev-eval/agent/` as a new Go module living inside the existing TypeScript monorepo. Module path: `github.com/hanfour/ai-dev-eval/agent`. Binary name: `caliber-agent`.

```
ai-dev-eval/
  agent/
    go.mod
    go.sum
    cmd/caliber-agent/main.go            # entry point; ldflags injects version
    internal/
      cli/                               # Cobra root + one file per command
        root.go
        enroll.go
        status.go
        addpath.go
        removepath.go
        pause.go
        resume.go
        setmode.go
        uninstall.go
        version.go
      api/                               # HTTP client + DTOs
        client.go
        enroll.go
        errors.go
      config/                            # ~/.caliber-agent/{config.toml,state.json}
        paths.go
        config.go
        state.go
      keychain/                          # macOS keychain wrapper
        keychain_darwin.go               # build tag: darwin
        keychain_other.go                # build tag: !darwin (returns ErrUnsupported)
      wizard/                            # interactive enroll wizard
        enroll.go
        prompt.go
        projects.go                      # scan ~/.claude/projects/
      version/
        version.go                       # ldflags-injected build metadata
    testdata/                            # fixture JSONL, fake security script
      claude-projects/...
      security-fake.sh
    dist/Formula/caliber-agent.rb        # Homebrew formula stub
    scripts/smoke.sh                     # manual end-to-end smoke (not CI)
    README.md                            # install + usage (PR1-scope only)
  .github/workflows/
    agent-ci.yml                         # vet + staticcheck + test + coverage gate
    agent-release.yml                    # cross-compile + GitHub Release on tag `agent/v*`
```

### Module boundaries

| Package | Owns | Does NOT do |
|---|---|---|
| `internal/cli` | Cobra command wiring, exit codes, stdout/stderr formatting | business logic, HTTP, file I/O |
| `internal/api` | HTTP, JSON, gzip, typed errors mapped from HTTP status | filesystem, keychain |
| `internal/config` | TOML/JSON read+write, atomic rename, 0600 permissions | HTTP, exec |
| `internal/keychain` | shell-out to `/usr/bin/security` | knowledge of caliber-agent's other state |
| `internal/wizard` | interactive prompts, project candidate discovery | HTTP, keychain, command-level orchestration |
| `internal/version` | `Version`, `Commit`, `BuiltAt` string accessors | anything else |

---

## 4. Components

### 4.1 `internal/version`

```go
var (
    Version = "dev"
    Commit  = "unknown"
    BuiltAt = "unknown"
)
func String() string  // "0.1.0 (abc1234, 2026-05-21T10:00:00Z)"
```

The release workflow injects values via `-ldflags`:
```
-X github.com/hanfour/ai-dev-eval/agent/internal/version.Version=$TAG
-X github.com/hanfour/ai-dev-eval/agent/internal/version.Commit=$GITHUB_SHA
-X github.com/hanfour/ai-dev-eval/agent/internal/version.BuiltAt=$ISO_TIMESTAMP
```

For local `go run ./agent/cmd/caliber-agent` development, ldflags are not set; the daemon reports `dev (unknown, unknown)` and sends `"agentVersion": "dev"` in the enrollment request. The server-side schema (`apps/api/src/rest/devicesEnroll.ts:16-21`) accepts any string up to 64 chars, so dev builds enrol successfully — `dev` simply propagates as the audit-log `agentVersion`.

### 4.2 `internal/keychain` (darwin only via build tag)

```go
// keychain_darwin.go
const ServiceName = "tw.caliber.agent"
func Set(account, secret string) error       // exec /usr/bin/security add-generic-password -U
func Get(account string) (string, error)     // exec /usr/bin/security find-generic-password -w
func Delete(account string) error            // exec /usr/bin/security delete-generic-password
var ErrNotFound = errors.New("keychain: not found")
var ErrUnsupported = errors.New("keychain: not supported on this platform")
```

Implementation notes:
- shell-out to `/usr/bin/security`, no cgo. Cross-compile stays trivial.
- `-U` (update-if-exists) makes `Set` idempotent.
- stdout/stderr captured but not logged — never leak the secret.
- `keychain_other.go` (`//go:build !darwin`) stubs each function to return `ErrUnsupported`.

### 4.3 `internal/config`

```go
// paths.go
func RootDir() string       // resolves CALIBER_AGENT_HOME, defaults to "$HOME/.caliber-agent"
func ConfigPath() string    // <RootDir>/config.toml
func StatePath() string     // <RootDir>/state.json
func LogPath() string       // <RootDir>/agent.log  (unused in PR1, reserved)

// config.go
type Config struct {
    DeviceID     string   `toml:"device_id"`
    Hostname     string   `toml:"hostname"`
    OS           string   `toml:"os"`
    APIBaseURL   string   `toml:"api_base_url"`     // no compiled-in default; see §4.6 resolution order
    Mode         string   `toml:"mode"`             // default "metadata-only"
    IncludePaths []string `toml:"include_paths"`    // default []
}
func Load() (*Config, error)             // returns ErrNotEnrolled if file missing
func Save(c *Config) error               // tmp + rename, 0600
var ErrNotEnrolled = errors.New("config: device not enrolled")

// state.go (skeleton only in PR1; map will be populated by watcher PR)
type State struct {
    Files map[string]FileWatermark `json:"files"`
}
type FileWatermark struct {
    Offset   int64     `json:"offset"`
    LastSync time.Time `json:"last_sync"`
}
func LoadState() (*State, error)         // returns empty State if file missing
func SaveState(s *State) error           // tmp + rename
```

TOML library: `github.com/BurntSushi/toml`. State uses stdlib `encoding/json`.

### 4.4 `internal/api`

```go
type Client struct {
    BaseURL   string
    HTTP      *http.Client            // default Timeout: 30 * time.Second
    UserAgent string                  // "caliber-agent/<version>"
}

type EnrollRequest struct {
    Token        string `json:"token"`
    Hostname     string `json:"hostname"`
    OS           string `json:"os"`
    AgentVersion string `json:"agentVersion"`
}

type EnrollResponse struct {
    DeviceID  string `json:"deviceId"`
    Key       string `json:"key"`         // bare cda_*
    KeyPrefix string `json:"keyPrefix"`
}

func (c *Client) Enroll(ctx context.Context, req EnrollRequest) (*EnrollResponse, error)

// errors.go
var (
    ErrInvalidToken  = errors.New("api: invalid_token")
    ErrTokenUsed     = errors.New("api: token_already_used")
    ErrTokenExpired  = errors.New("api: token_expired")
    ErrServerMisconf = errors.New("api: server misconfigured")
)
type APIError struct {
    StatusCode int
    Code       string  // server-supplied error code, e.g. "invalid_token"
    Body       string  // first 200 chars of response body
}
func (e *APIError) Error() string
```

No retry. Enrollment is one-shot and 4xx/5xx propagate to user. Body is small; no gzip on request.

### 4.5 `internal/wizard`

```go
// projects.go
type ProjectCandidate struct {
    CWD       string
    LastSeen  time.Time
    SessionCt int
}
func ScanClaudeProjects(root string) ([]ProjectCandidate, error)
```

Behaviour: walk `<root>/*/[0-9a-f-]*.jsonl`, read the first line of each file as JSON, extract `.cwd` field. Skip lines that fail to parse, files missing `cwd`, or files larger than 50 MB head. Dedupe by `cwd`, sort by `LastSeen` descending.

```go
// prompt.go
type Prompter interface {
    Confirm(question string, def bool) (bool, error)
    SelectMulti(question string, options []string) ([]int, error)
    InputLine(question string) (string, error)
}
func NewStdinPrompter() Prompter
```

Uses `github.com/charmbracelet/huh` as the underlying implementation. The `Prompter` interface lets tests substitute a fake without touching stdin/stdout.

```go
// enroll.go
type Deps struct {
    Config    *config.Config
    Prompter  Prompter
    Scan      func(root string) ([]ProjectCandidate, error)
    Enroll    func(ctx context.Context, req api.EnrollRequest) (*api.EnrollResponse, error)
    SetSecret func(account, secret string) error
}
func RunEnrollWizard(ctx context.Context, deps Deps, token string) error
```

Flow:
1. Verify config is in `not yet enrolled` state (caller already checked; this is a defensive double-check).
2. `Confirm("Begin device enrollment with caliber? [Y/n]", def=true)`.
3. POST `/v1/devices/enroll` via `deps.Enroll`.
4. Write keychain via `deps.SetSecret(deviceID, key)`.
5. Write `config.toml` with `device_id`, `hostname`, `os`, defaults.
6. `deps.Scan(~/.claude/projects)` → present candidates. Always include a `None — start with 0 paths (recommended)` option that is the default.
7. `SelectMulti` returns chosen indices. Default-empty privacy contract: if user just hits enter, `include_paths=[]`.
8. Show summary, confirm with `Confirm("Write this config? [Y/n]", def=true)`.
9. `config.Save` with chosen `include_paths`.
10. Final message: `✓ Enrolled as device <id>. Configured <N> paths. Watcher arrives in next release.`

### 4.6 `internal/cli`

```go
// root.go
func New() *cobra.Command
// PersistentFlags:
//   --config-dir       override CALIBER_AGENT_HOME
//   --api-base-url     override CALIBER_API_BASE_URL / config api_base_url
//   -v / --verbose     extra error context (errors.Unwrap chain)
```

**Resolution order for API base URL** (highest priority first):
1. `--api-base-url` flag
2. `CALIBER_API_BASE_URL` environment variable
3. `api_base_url` in `~/.caliber-agent/config.toml` (only meaningful after enrollment)
4. None — `enroll` fails with «Caliber API base URL not configured. Pass --api-base-url or set CALIBER_API_BASE_URL.»

There is no compiled-in default URL. PR1 deliberately requires explicit configuration so the daemon never silently targets a wrong host.

**Resolution order for `CALIBER_AGENT_HOME`**: `--config-dir` flag > `CALIBER_AGENT_HOME` env > `$HOME/.caliber-agent`.

Each sub-command has its own file. In PR1, only `enroll` and `version` are wired. The rest print:
```
caliber-agent <cmd>: not yet implemented in this release
See https://github.com/hanfour/caliber for the daemon roadmap
```
…and exit 64 (`EX_USAGE`).

```go
// enroll.go
//
// caliber-agent enroll <token>
//   --force    re-enroll over an existing device
//
// Steps:
//   1. config.Load
//   2. if ErrNotEnrolled or --force: proceed
//      else: print "already enrolled as <id>", exit 1
//   3. wizard.RunEnrollWizard(ctx, deps, token)
//   4. on success: exit 0 with summary line
```

### 4.7 `cmd/caliber-agent/main.go`

```go
func main() {
    cmd := cli.New()
    if err := cmd.ExecuteContext(context.Background()); err != nil {
        os.Exit(1)
    }
}
```

Cobra prints the error to stderr itself; `main` only sets the exit code.

---

## 5. Data Flow

### Happy path

```
user terminal             caliber-agent                       caliber API           keychain          fs
   │                            │                                   │                  │              │
   │ enroll cde_xxx             │                                   │                  │              │
   ├───────────────────────────►│ config.Load() → ErrNotEnrolled    │                  │              │
   │                            │ hostname, os, agentVersion        │                  │              │
   │                            │ POST /v1/devices/enroll           │                  │              │
   │                            ├──────────────────────────────────►│                  │              │
   │                            │                                   │ 201 {deviceId,   │              │
   │                            │◄──────────────────────────────────┤      key:cda_..} │              │
   │                            │ keychain.Set(deviceId, cda_..)    │                  │              │
   │                            ├──────────────────────────────────────────────────────►│              │
   │                            │ config.Save (atomic, 0600)                                          │
   │                            ├──────────────────────────────────────────────────────────────────────►│
   │                            │ wizard.ScanClaudeProjects(~/.claude/projects)                       │
   │                            │◄──────────────────────────────────────────────────────────────────────┤
   │                            │ Prompt: Confirm / SelectMulti                                       │
   │◄───────────────────────────┤                                                                     │
   │ (user picks)               │                                                                     │
   ├───────────────────────────►│ config.Save(include_paths=[..])                                     │
   │                            ├──────────────────────────────────────────────────────────────────────►│
   │ ✓ Enrolled as <id>.        │                                                                     │
   │◄───────────────────────────┤ exit 0                                                              │
```

### Failure paths

| Failure | Trigger | Behaviour | Exit |
|---|---|---|---|
| A. Already enrolled | `config.Load` returns existing `device_id`, no `--force` | print «Device already enrolled as `<id>`. Use --force to re-enroll.», no network, no keychain | 1 |
| B. Token rejected | API 401/410 | print user-friendly cause + pointer to `/dashboard/devices`, no keychain, no config | 1 |
| C. API success but local IO fails | keychain or config write returns error after 201 | print raw `cda_*` to stderr + «Revoke this device in /dashboard/devices, no rollback attempted», no config written | 1 |
| D. Ctrl-C mid-wizard (after keychain) | `ctx.Done()` during SelectMulti | accept current state: keychain written, config saved with `include_paths=[]`, print «Cancelled. Device is enrolled with 0 paths. Run add-path later.» | 130 |
| E. Network error | dial / timeout | print «Cannot reach caliber API at `<base-url>`», no keychain, no config | 1 |
| F. Non-darwin platform | `keychain.ErrUnsupported` | print «caliber-agent currently only supports macOS» | 1 |
| G. API base URL not configured | none of flag/env/config provides a URL | print «Caliber API base URL not configured. Pass --api-base-url or set CALIBER_API_BASE_URL.», no network, no keychain | 1 |
| H. Internal panic | `recover()` in main | print «internal error» + version + commit, no further side effects | 70 |

### Idempotency notes

- Server side: `POST /v1/devices/enroll` runs in a transaction. Partial failure leaves no orphan device.
- Client side: `keychain.Set` happens **before** `config.Save`. If config write fails, the local view stays in `ErrNotEnrolled` and a re-run will surface Failure B (token 410 used). Manual cleanup is expected in this edge case.
- The order is deliberately not the reverse — a config file is the on-disk signal of "enrolled", and it must not exist without a matching keychain entry.

---

## 6. Error Handling Principles

1. **Typed errors over strings.** `api` returns `*APIError`. `cli` uses `errors.As` to switch on it. No `strings.Contains(err.Error(), ...)`.
2. **Three message layers.** `error.Error()` is for developers. `cli` translates to user-friendly text. `-v` flag exposes the unwrap chain.
3. **No silent error swallowing.** Every `_ = f()` requires a comment explaining why.
4. **No retry on enroll.** Token is single-use; retry has no safe semantic.
5. **stderr vs stdout.** Success summary → stdout. Errors → stderr. Prompts → stderr (pipe-friendly).
6. **Secret redaction in logs.** `api.Client` does not log request bodies. Response bodies are only logged on 4xx/5xx, with the `key` field rewritten to `cda_***`.
7. **Stable exit codes.** 0 success, 1 expected error, 64 not yet implemented, 70 internal panic, 130 SIGINT.

---

## 7. Testing

Target: 80%+ coverage on `agent/internal/...` (entry `main.go` and Cobra glue excluded).

### Layers

| Layer | Scope | Tools |
|---|---|---|
| Unit | per-package pure functions | stdlib `testing` + `testify/require` |
| Integration (hermetic) | end-to-end `enroll` against `httptest.NewServer` | stdlib + testify |
| Smoke (manual, not CI) | real call to local v0.7.0 stack | `agent/scripts/smoke.sh` |

### Per-package coverage

**`internal/version`** — 1 test: `String()` with default values returns `"dev (unknown, unknown)"`.

**`internal/keychain`** —
- `keychain_darwin_test.go` (`//go:build darwin`): `t.TempDir()` PATH-prepended with a `security` shell script that records args; assert correct args + exit code. Never touches the real user keychain.
- `keychain_other_test.go` (`//go:build !darwin`): asserts `Set/Get/Delete` all return `ErrUnsupported`.

**`internal/config`** —
- `t.TempDir()` as `CALIBER_AGENT_HOME`. Cases: Load missing → `ErrNotEnrolled`; Save creates file at 0600; tmp+rename atomicity (mid-write `Save` failure leaves prior file intact); TOML round-trip with empty `include_paths`; State JSON round-trip with empty `Files` map.

**`internal/api`** —
- `httptest.NewServer` mocking caliber API. Cases:
  - 201 happy → correct `EnrollResponse` shape
  - 400 invalid_body → `*APIError{StatusCode:400}`
  - 401 invalid_token → `errors.Is(err, ErrInvalidToken)`
  - 410 token_already_used → `ErrTokenUsed`
  - 410 token_expired → `ErrTokenExpired`
  - 500 internal_error → `*APIError` with body trimmed to 200 chars
  - Connection refused after `server.Close()` → `*url.Error` wrap
- Assert `User-Agent: caliber-agent/<version>` on the outgoing request.
- Assert 30s timeout fires (server `Hang` handler).

**`internal/wizard`** —
- `projects_test.go`: `testdata/claude-projects/` with 4 fixture sessions (2 share a `cwd`, 1 invalid JSON, 1 missing `cwd`); assert `ScanClaudeProjects` returns 1 dedupe-by-cwd entry, bad fixtures skipped silently.
- `prompt_test.go`: fake Prompter implementations exercise default values for Confirm / SelectMulti. The huh library's own UI is not tested.
- `enroll_test.go`: fake Prompter feeds pre-recorded answers. Spy-wrap `Enroll`/`SetSecret` to verify call order, final config content, and `include_paths=[]` when user picks `None`.

**`internal/cli`** —
- `enroll_test.go` (integration): httptest server + tmp `CALIBER_AGENT_HOME` + fake `security` subprocess + scripted stdin → run `caliber-agent enroll <token>`, assert exit 0, config.toml content, fake-security recorded args, stdout contains `Enrolled as device`.
- Failure A (already enrolled): pre-create config.toml → run enroll → exit 1, server hit 0 times, keychain not invoked.
- Failure B (token 401): exit 1, no config, no keychain.
- Failure C (API ok, keychain fails): fake `security` exits nonzero → stderr contains raw key and `Revoke this device`, exit 1, no config.
- Failure D (Ctrl-C): cancel context during wizard `SelectMulti` → exit 130, keychain populated, config saved with `include_paths=[]`.

**`cmd/caliber-agent/main.go`** — not directly tested; coverage comes from `internal/cli`.

### Coverage gate

```sh
go test ./agent/internal/... -race -coverprofile=cover.out
go tool cover -func=cover.out | tail -1
# parse the "total:" line; fail CI if < 80.0%
```

`./cmd/...` deliberately excluded — gaming a 3-line main for coverage is anti-value.

### CI workflow (`.github/workflows/agent-ci.yml`)

Triggers: paths `agent/**`, `.github/workflows/agent-*.yml`.

Steps:
1. `actions/checkout`
2. `actions/setup-go@v5` with `go.mod` version
3. `go vet ./agent/...`
4. `staticcheck ./agent/...`
5. `gofmt -l agent/` — any diff = fail
6. Unit + integration tests with `-race -cover`
7. Coverage gate (above)

### Release workflow (`.github/workflows/agent-release.yml`)

Trigger: tag matching `agent/v*` (avoids the main caliber `v*` tag pattern).

Matrix: `darwin/arm64`, `darwin/amd64`.

Per target:
1. Cross-compile with ldflags injecting version metadata.
2. Tar + gzip the binary.
3. Generate `.sha256` companion.
4. Upload to a GitHub Release created via `softprops/action-gh-release`, attaching all artefacts.

The release body lists each artefact's sha256 inline.

### Homebrew formula stub

`agent/dist/Formula/caliber-agent.rb` ships with placeholder URL and `sha256` values. The release workflow does **not** auto-edit this file — the workflow's job is to produce the binary tarballs plus their `.sha256` sidecars on the GitHub Release. Promoting a release to brew is a manual three-step process performed outside this PR:

1. Copy `agent/dist/Formula/caliber-agent.rb` to `hanfour/homebrew-caliber`.
2. Update `version`, `url`, and `sha256` from the GH Release artefacts.
3. Commit + push the tap repo.

This deferred-automation choice is documented again in §10 (Out of Scope).

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

### Smoke script (`agent/scripts/smoke.sh`)

```sh
#!/usr/bin/env bash
# Manual smoke against running local v0.7.0 stack.
# Not in CI. Run before merging PR1.
set -euo pipefail

TOKEN="${1:?usage: $0 <enrollment-token>}"
WORKDIR=$(mktemp -d)
trap 'rm -rf "$WORKDIR"' EXIT

go build -o "$WORKDIR/caliber-agent" ./agent/cmd/caliber-agent

CALIBER_API_BASE_URL=http://localhost:3001 \
CALIBER_AGENT_HOME="$WORKDIR/home" \
  "$WORKDIR/caliber-agent" enroll "$TOKEN"

security find-generic-password -s tw.caliber.agent >/dev/null && echo "PASS: keychain entry exists"
test -f "$WORKDIR/home/config.toml" && echo "PASS: config.toml exists"
grep -q 'include_paths = \[\]' "$WORKDIR/home/config.toml" && echo "PASS: include_paths defaults empty"
```

---

## 8. Public Contract (frozen at PR1)

These surfaces are locked once PR1 merges. Future PRs adapt, not break.

- **Environment variables**
  - `CALIBER_AGENT_HOME` — overrides `~/.caliber-agent` (optional; defaults to that path)
  - `CALIBER_API_BASE_URL` — sets the caliber API base URL (no compiled-in default; either this env var, the `--api-base-url` flag, or `api_base_url` in an existing `config.toml` must be set, or `enroll` fails)
- **Exit codes**
  - `0` success
  - `1` expected error (user-actionable)
  - `64` not yet implemented (`EX_USAGE`)
  - `70` internal error (`EX_SOFTWARE`, panic recover)
  - `130` SIGINT
- **Config file path** `~/.caliber-agent/config.toml`
- **State file path** `~/.caliber-agent/state.json`
- **Keychain service name** `tw.caliber.agent`
- **Keychain account** = `device_id`
- **CLI surface** — all command names from spec §"Commands" exist in Cobra tree; non-PR1 commands print a stable `not yet implemented` message and exit 64
- **Module path** `github.com/hanfour/ai-dev-eval/agent`
- **Release tag pattern** `agent/v*`

---

## 9. Risks + Mitigations

| Risk | Mitigation |
|---|---|
| huh adds significant binary size | Acceptable for PR1 (binary still well under 20MB target); revisit in Phase 3 polish if needed |
| `/usr/bin/security` flakiness on macOS Sonoma+ | Smoke script runs on both h4 + mac-mini before merge; if regression appears, swap to `99designs/keyring` |
| Coverage gate flakiness from `httptest` timing | Use `t.Parallel()` sparingly; mark timeout-sensitive tests `t.Skip("slow")` in non-CI runs |
| Release tag pattern `agent/v*` collides with future tag conventions | Document in `agent/README.md`; main caliber releases keep `v*` |
| Cobra version drift vs the rest of caliber | This is a standalone go module — no version drift across the monorepo boundary |
| User runs enroll on non-darwin and sees confusing keychain error | `internal/keychain` non-darwin stub returns explicit `ErrUnsupported`; cli surfaces friendly message |

---

## 10. Out of Scope (with pointers to future PRs)

| Item | Future PR |
|---|---|
| claude-code transcript watcher | PR2 — watchers + state.json watermark population |
| codex sessions watcher | PR2 |
| `POST /v1/ingest` client + gzip + retry/backoff | PR3 — ingest client |
| Redaction layer (3 modes + regex set) | PR3 (alongside ingest) |
| launchd plist + `install-launchd` | PR4 — daemonization |
| `status`/`pause`/`resume`/`add-path`/`remove-path`/`set-mode`/`uninstall` real implementations | PR4 + PR5 |
| Homebrew tap push automation | PR4 |
| Linux build target | Phase 5+ |
| Per-org redaction set override fetch | Phase 3 |
| `agent.log` rotation | Phase 3 |

---

## 11. References

- Parent spec: `docs/superpowers/specs/2026-05-18-multi-source-ingest-design.md` §"Phase 2 — Daemon MVP" (lines 549–562)
- Server `POST /v1/devices/enroll` implementation: `apps/api/src/rest/devicesEnroll.ts`
- Brainstorming session: 2026-05-21 (this document)
- Phase 1 release: caliber v0.7.0 (commit 34a7d0e)

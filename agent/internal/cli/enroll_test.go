package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/hanfour/ai-dev-eval/agent/internal/config"
	"github.com/hanfour/ai-dev-eval/agent/internal/keychain"
	"github.com/hanfour/ai-dev-eval/agent/internal/wizard"
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

func TestTranslateEnrollErr_LostKey_EmitsRawKeyToStderr(t *testing.T) {
	// Redirect os.Stderr to a pipe so we can capture the Failure-C output.
	origStderr := os.Stderr
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Stderr = w
	t.Cleanup(func() { os.Stderr = origStderr })

	lk := &wizard.LostKeyError{DeviceID: "d-XYZ", RawKey: "cda_visible_secret", Cause: errors.New("permission denied")}
	out := translateEnrollErr(lk)
	if out != lk {
		t.Errorf("translateEnrollErr should pass the error through, got %v", out)
	}

	w.Close()
	captured, _ := io.ReadAll(r)
	got := string(captured)
	for _, want := range []string{"cda_visible_secret", "d-XYZ", "revoke", "CANNOT be retrieved"} {
		if !strings.Contains(got, want) {
			t.Errorf("stderr missing %q in %q", want, got)
		}
	}
}

func TestTranslateEnrollErr_NonLostKey_PassesThrough(t *testing.T) {
	plain := errors.New("some other error")
	out := translateEnrollErr(plain)
	if out != plain {
		t.Errorf("non-LostKeyError should pass through unchanged, got %v", out)
	}
}

func TestClaudeProjectsRoot_HonoursOverride(t *testing.T) {
	t.Setenv("CALIBER_CLAUDE_PROJECTS", "/custom/claude")
	if got := claudeProjectsRoot(); got != "/custom/claude" {
		t.Errorf("claudeProjectsRoot = %q, want /custom/claude", got)
	}
}

func TestClaudeProjectsRoot_DefaultsToHomeClaudeProjects(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("CALIBER_CLAUDE_PROJECTS", "")
	t.Setenv("HOME", tmp)
	want := tmp + "/.claude/projects"
	if got := claudeProjectsRoot(); got != want {
		t.Errorf("claudeProjectsRoot = %q, want %q", got, want)
	}
}

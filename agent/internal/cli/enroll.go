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

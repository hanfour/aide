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

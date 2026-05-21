package cli

import (
	"testing"

	"github.com/hanfour/ai-dev-eval/agent/internal/wizard"
)

// useFakePrompter is the test-only seam for injecting a FakePrompter into
// the enroll command. testPrompterHook is declared in enroll.go (without
// pulling in the "testing" package); this file provides the test-side
// setter, restricted to _test.go consumers so neither the "testing" package
// nor this helper is linked into the production caliber-agent binary.
func useFakePrompter(t *testing.T, confirms []bool, selections [][]int) {
	t.Helper()
	fp := wizard.NewFakePrompter()
	fp.Answers.Confirms = confirms
	fp.Answers.Selections = selections
	testPrompterHook = fp
	t.Cleanup(func() { testPrompterHook = nil })
}

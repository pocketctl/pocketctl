package main

import (
	"errors"
	"fmt"
	"testing"

	"github.com/pocketctl/pocketctl/internal/session"
)

func TestCodexInvocationErrorPreservesRecoveryRetry(t *testing.T) {
	for _, tc := range []struct {
		err  error
		code string
	}{
		{fmt.Errorf("recover: %w", session.ErrCodexRuntimeRecovering), "runtime_recovering"},
		{session.ErrCodexInvocationsUnsupported, "invocations_unsupported"},
		{errors.New("runtime disconnected"), ""},
		{nil, ""},
	} {
		if got := codexInvocationErrorCode(tc.err); got != tc.code {
			t.Fatalf("%v: code=%q, want %q", tc.err, got, tc.code)
		}
	}
}

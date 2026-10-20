package main

import (
	"errors"

	"github.com/pocketctl/pocketctl/internal/session"
)

// Only a permanent capability failure may suppress the clients' retry action.
func codexInvocationErrorCode(err error) string {
	switch {
	case errors.Is(err, session.ErrCodexRuntimeRecovering):
		return "runtime_recovering"
	case errors.Is(err, session.ErrCodexInvocationsUnsupported):
		return "invocations_unsupported"
	default:
		return ""
	}
}

package session

import (
	"context"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

// SessionBackend drives sessions multiplexed through a shared agent service.
// OpenCode selects it statically through BackendServer; Codex selects it
// dynamically after its app-server capability gate and retains the subprocess
// exec-json path as a compatibility fallback. Claude remains PTY/subprocess.
type SessionBackend interface {
	// Start creates/launches a session and returns its real session id.
	Start(ctx context.Context, config protocol.SessionConfig) (sessionID string, err error)
	// Send delivers a user message / prompt to an existing session.
	Send(ctx context.Context, sessionID, content string) error
	// Interrupt aborts the current turn of a session.
	Interrupt(sessionID string) error
	// Close releases backend resources held for a session.
	Close(sessionID string) error
}

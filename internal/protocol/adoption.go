package protocol

import (
	"errors"
	"time"
)

var ErrAdoptionOperationNotFound = errors.New("adoption operation not found")

const CodexSessionAdoptionCapability = "codex_session_adoption_v1"

// AdoptionRequest deliberately carries no runtime, account, path or permission overrides.
type AdoptionRequest struct {
	SessionID   string `json:"session_id"`
	RequestID   string `json:"request_id,omitempty"`
	OperationID string `json:"operation_id,omitempty"`
	WaitMS      int64  `json:"wait_ms,omitempty"`
	Unarchive   bool   `json:"unarchive,omitempty"`
}

type AdoptionReceipt struct {
	Version        int        `json:"version"`
	SessionID      string     `json:"session_id"`
	OperationID    string     `json:"operation_id,omitempty"`
	Revision       int64      `json:"revision"`
	Phase          string     `json:"phase"`
	Reason         string     `json:"reason"`
	Retryable      bool       `json:"retryable"`
	Deadline       *time.Time `json:"deadline,omitempty"`
	LocalManaged   bool       `json:"local_managed"`
	RemoteReady    bool       `json:"remote_ready"`
	ArchiveChanged bool       `json:"archive_changed"`
	AllowedActions []string   `json:"allowed_actions"`
	RetryAfterMS   int64      `json:"retry_after_ms,omitempty"`
}

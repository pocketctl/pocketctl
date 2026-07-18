package agentcontrol

import (
	"encoding/json"
	"fmt"
	"strings"
)

const (
	ProtocolVersion    = 1
	MaxFrameSize       = 64 << 10
	MaxCWDLength       = 4096
	MaxSessionIDLength = 512
	maxIDLength        = 512
)

const (
	AgentOpenCode = "opencode"
	AgentCodex    = "codex"

	MethodRuntimeAcquire   = "agent.runtime.acquire"
	MethodRuntimeLeaseBind = "agent.runtime.lease_bind"
	MethodRuntimeStatus    = "agent.runtime.status"
	MethodRuntimeRelease   = "agent.runtime.release"
)

const (
	IntentNew      = "new"
	IntentContinue = "continue"
	IntentResume   = "resume"
	IntentRun      = "run"
)

const (
	ErrUnsupportedVersion = "unsupported_version"
	ErrAgentDisabled      = "agent_disabled"
	ErrRuntimeUnavailable = "runtime_unavailable"
	ErrSessionBusy        = "session_busy"
	ErrInvalidRequest     = "invalid_request"
)

type ProtocolError struct {
	Code    string `json:"code"`
	Message string `json:"message,omitempty"`
}

func (e *ProtocolError) Error() string {
	if e.Message == "" {
		return e.Code
	}
	return e.Code + ": " + e.Message
}

type Request struct {
	Version   int             `json:"version"`
	ID        string          `json:"id"`
	Method    string          `json:"method"`
	Agent     string          `json:"agent"`
	ClientPID int             `json:"client_pid"`
	Payload   json.RawMessage `json:"payload,omitempty"`
}

type Response struct {
	Version int             `json:"version"`
	ID      string          `json:"id"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *ProtocolError  `json:"error,omitempty"`
}

type AcquirePayload struct {
	CWD         string `json:"cwd"`
	Intent      string `json:"intent"`
	SessionID   string `json:"session_id,omitempty"`
	Fork        bool   `json:"fork,omitempty"`
	OperationID string `json:"operation_id"`
}

type AcquireResult struct {
	Mode              string `json:"mode"`
	RemoteURI         string `json:"remote_uri,omitempty"`
	BaseURL           string `json:"base_url,omitempty"`
	Password          string `json:"password,omitempty"`
	Username          string `json:"username,omitempty"`
	RealBinary        string `json:"real_binary"`
	ResolvedSessionID string `json:"resolved_session_id,omitempty"`
	LeaseID           string `json:"lease_id,omitempty"`
	Generation        uint64 `json:"generation,omitempty"`
	Reason            string `json:"reason,omitempty"`
}

type LeaseBindPayload struct {
	LeaseID string `json:"lease_id"`
	PID     int    `json:"pid"`
}

type ReleasePayload struct {
	LeaseID string `json:"lease_id"`
}

type StatusPayload struct{}

type AcquireRequest struct {
	Agent     string
	ClientPID int
	Payload   AcquirePayload
}

type LeaseBindRequest struct {
	Agent     string
	ClientPID int
	Payload   LeaseBindPayload
}

type ReleaseRequest struct {
	Agent     string
	ClientPID int
	Payload   ReleasePayload
}

type RuntimeStatusRequest struct {
	Agent     string
	ClientPID int
	Payload   StatusPayload
}

type RuntimeStatusResult struct {
	Mode       string `json:"mode"`
	BaseURL    string `json:"base_url,omitempty"`
	Generation uint64 `json:"generation,omitempty"`
	Reason     string `json:"reason,omitempty"`
}

func ValidateFrameSize(frame []byte) error {
	if len(frame) > MaxFrameSize {
		return invalid("frame exceeds %d bytes", MaxFrameSize)
	}
	return nil
}

func ValidateRequest(req Request) error {
	if req.Version != ProtocolVersion {
		return &ProtocolError{Code: ErrUnsupportedVersion, Message: fmt.Sprintf("version %d is not supported", req.Version)}
	}
	if strings.TrimSpace(req.ID) == "" || len(req.ID) > maxIDLength {
		return invalid("request id is required and must be at most %d bytes", maxIDLength)
	}
	switch req.Method {
	case MethodRuntimeAcquire, MethodRuntimeLeaseBind, MethodRuntimeStatus, MethodRuntimeRelease:
	default:
		return invalid("unknown method %q", req.Method)
	}
	if req.Agent != AgentOpenCode && req.Agent != AgentCodex {
		return invalid("unknown agent %q", req.Agent)
	}
	return nil
}

func ValidateAcquire(payload AcquirePayload) error {
	if strings.TrimSpace(payload.CWD) == "" || len(payload.CWD) > MaxCWDLength {
		return invalid("cwd is required and must be at most %d bytes", MaxCWDLength)
	}
	if strings.TrimSpace(payload.OperationID) == "" || len(payload.OperationID) > maxIDLength {
		return invalid("operation id is required and must be at most %d bytes", maxIDLength)
	}
	switch payload.Intent {
	case IntentNew, IntentContinue, IntentRun:
	case IntentResume:
		if strings.TrimSpace(payload.SessionID) == "" {
			return invalid("resume requires a session id")
		}
	default:
		return invalid("unknown acquire intent %q", payload.Intent)
	}
	if len(payload.SessionID) > MaxSessionIDLength {
		return invalid("session id must be at most %d bytes", MaxSessionIDLength)
	}
	return nil
}

func invalid(format string, args ...any) error {
	return &ProtocolError{Code: ErrInvalidRequest, Message: fmt.Sprintf(format, args...)}
}

package protocol

import (
	"encoding/json"
	"fmt"
	"strings"
)

const (
	ControlManaged               = "managed"
	ControlUnmanagedActive       = "unmanaged_active"
	ControlLegacyReadOnly        = "legacy_read_only"
	InteractionResolvedElsewhere = "resolved_elsewhere"
)

// Client → Daemon commands
type ClientMessage struct {
	Type       string      `json:"type"`
	SessionID  string      `json:"session_id,omitempty"`
	Content    string      `json:"content,omitempty"`
	Agent      string      `json:"agent,omitempty"`
	Cwd        string      `json:"cwd,omitempty"`
	Prompt     string      `json:"prompt,omitempty"`
	RequestID  string      `json:"request_id,omitempty"`
	QuotaGrant *QuotaGrant `json:"quota_grant,omitempty"`
	Approved   bool        `json:"approved,omitempty"`
	// Action upgrades OpenCode permission replies to once/always/reject. Empty
	// keeps the legacy Approved boolean contract for older clients.
	Action string `json:"action,omitempty"`
	// Answers is ordered exactly like an OpenCode question request's questions.
	Answers [][]string `json:"answers,omitempty"`
	// ElicitationAction and ElicitationContent answer a Codex MCP elicitation.
	// Content remains opaque JSON on the wire and is never copied into a
	// durable daemon event after the native app-server accepts it.
	ElicitationAction  string          `json:"elicitation_action,omitempty"`
	ElicitationContent json.RawMessage `json:"elicitation_content,omitempty"`
	// AgentName is an OpenCode session profile name, distinct from Agent (the
	// CLI type: claude-code/codex/opencode).
	AgentName string `json:"agent_name,omitempty"`
	// Choice carries the selected option index (e.g. "1") for an
	// interactive_response — the user's answer to a PTY selection prompt
	// surfaced as an interactive_prompt card.
	Choice     string            `json:"choice,omitempty"`
	Permission *PermissionConfig `json:"permission,omitempty"`
	// Model for session_create: opus/sonnet/haiku alias (or concrete model name).
	// Empty = follow the host's ~/.claude/settings.json default.
	Model string `json:"model,omitempty"`
	// Worktree enables git worktree isolation for session_create: the session
	// runs inside a fresh worktree at <cwd>/.pocketctl/wt-<sid> instead of cwd.
	Worktree bool `json:"worktree,omitempty"`
	// AutoCreateDir creates cwd with os.MkdirAll when it doesn't exist.
	AutoCreateDir bool `json:"auto_create_dir,omitempty"`
	// Force overrides a cwd_in_use warning — create the session even though the
	// cwd already has other active sessions. (Scheme A: informed consent.)
	Force bool `json:"force,omitempty"`
}

// Daemon → Client events
type DaemonEvent struct {
	Type string `json:"type"`
	// Seq is a monotonically increasing per-connection sequence number stamped
	// by the ws.Client just before the event is sent to the relay. It enables
	// at-least-once delivery: the relay dedups by (daemon_id, seq) and acks the
	// highest contiguous seq it has persisted so the daemon can trim its
	// outbound replay buffer. Zero/omitted means a legacy event (no dedup).
	Seq                    int64                `json:"seq,omitempty"`
	EventID                string               `json:"event_id,omitempty"`          // stable JSONL record identity across daemon restarts
	PreviousEventID        string               `json:"previous_event_id,omitempty"` // causal predecessor for mutable native snapshots
	SessionID              string               `json:"session_id"`
	OldSessionID           string               `json:"old_session_id,omitempty"`
	Text                   string               `json:"text,omitempty"`
	Snapshot               string               `json:"snapshot,omitempty"` // full native text snapshot; Text may remain an append delta
	Streaming              bool                 `json:"streaming,omitempty"`
	MessageID              string               `json:"message_id,omitempty"` // source message identity (OpenCode revisioned Parts)
	PartID                 string               `json:"part_id,omitempty"`    // source Part identity for client-side upsert
	Revision               int                  `json:"revision,omitempty"`   // monotonically increasing per Part
	Replace                bool                 `json:"replace,omitempty"`    // replace the Part's accumulated text instead of appending
	CallID                 string               `json:"call_id,omitempty"`
	Tool                   string               `json:"tool,omitempty"`
	Input                  json.RawMessage      `json:"input,omitempty"`
	Output                 string               `json:"output,omitempty"`
	Status                 string               `json:"status,omitempty"`
	Error                  string               `json:"error,omitempty"`
	Attempt                int                  `json:"attempt,omitempty"`  // retry attempt number (OpenCode retry Part)
	RetryAt                int64                `json:"retry_at,omitempty"` // retry creation time in source milliseconds
	Auto                   bool                 `json:"auto,omitempty"`     // compaction was automatically triggered
	Overflow               bool                 `json:"overflow,omitempty"` // compaction followed a context overflow
	Mime                   string               `json:"mime,omitempty"`
	Filename               string               `json:"filename,omitempty"`
	URL                    string               `json:"url,omitempty"`
	PartSource             json.RawMessage      `json:"part_source,omitempty"`
	Hash                   string               `json:"hash,omitempty"`
	Files                  []string             `json:"files,omitempty"`
	Prompt                 string               `json:"prompt,omitempty"`
	Description            string               `json:"description,omitempty"`
	ProfileName            string               `json:"profile_name,omitempty"`
	Todos                  []TodoItem           `json:"todos,omitempty"`
	CostUSD                float64              `json:"cost_usd,omitempty"`
	Turns                  int                  `json:"turns,omitempty"`
	RiskLevel              string               `json:"risk_level,omitempty"`
	RequestID              string               `json:"request_id,omitempty"`
	ReservationID          string               `json:"reservation_id,omitempty"`
	Approved               bool                 `json:"approved,omitempty"` // for approval_resolved: how it was answered (terminal-side)
	Title                  string               `json:"title,omitempty"`
	Cwd                    string               `json:"cwd,omitempty"`
	Source                 string               `json:"source,omitempty"`
	Resync                 bool                 `json:"resync,omitempty"` // reconnect replay, not a newly discovered session
	ExitReason             string               `json:"exit_reason,omitempty"`
	LastActivityAt         string               `json:"last_activity_at,omitempty"`
	TurnStartedAt          string               `json:"turn_started_at,omitempty"` // authoritative start of the currently active turn
	AgentID                string               `json:"agent_id,omitempty"`          // sub-agent identifier (e.g. "afa8314e6e3f6e552)
	ParentSessionID        string               `json:"parent_session_id,omitempty"` // subagent's parent session (P0 subagent relation)
	IsSubagent             bool                 `json:"is_subagent,omitempty"`       // true for subagent-scoped events
	RootSessionID          string               `json:"root_session_id,omitempty"`   // root session for multi-level aggregation
	Agent                  string               `json:"agent,omitempty"`             // agent type for upgrade_result (claude-code, codex)
	SubAgentDesc           string               `json:"subagent_desc,omitempty"`     // sub-agent task description
	SubAgentType           string               `json:"subagent_type,omitempty"`     // sub-agent type (Explore, general-purpose, etc.)
	UserMessage            string               `json:"user_message,omitempty"`      // for generate_title_request
	AssistantMessage       string               `json:"assistant_message,omitempty"` // for generate_title_request
	Reason                 string               `json:"reason,omitempty"`            // failure reason code (no_cli, bad_cwd, start_fail, timeout, daemon_offline)
	Commands               []CommandItem        `json:"commands,omitempty"`          // for command_list
	Command                string               `json:"command,omitempty"`           // for command_receipt (e.g. "/compact")
	ReceiptStatus          string               `json:"receipt_status,omitempty"`    // for command_receipt: success/failed/unavailable
	Message                string               `json:"message,omitempty"`           // for command_receipt message
	Operation              string               `json:"operation,omitempty"`         // failing interaction operation, for correlated UI rollback
	Usage                  *ContextUsage        `json:"usage,omitempty"`             // token usage for agent_text events
	Permission             *PermissionConfig    `json:"permission,omitempty"`
	PermissionEffective    string               `json:"permission_effective,omitempty"`
	PermissionMutable      bool                 `json:"permission_mutable,omitempty"`
	PermissionMutableModes []string             `json:"permission_mutable_modes,omitempty"`
	Model                  string               `json:"model,omitempty"`           // resolved model name (session_meta event)
	Effort                 string               `json:"effort,omitempty"`          // current thinking-effort level (session_meta event)
	Models                 []ModelOption        `json:"models,omitempty"`          // available models (model_list event)
	CwdSessions            int                  `json:"cwd_sessions,omitempty"`    // active session count on the same cwd (cwd_in_use/session_created)
	WorktreePath           string               `json:"worktree_path,omitempty"`   // worktree absolute path when the session is isolated (Scheme D)
	WorktreeBranch         string               `json:"worktree_branch,omitempty"` // git branch backing the worktree (Scheme D)
	CurrentAgent           string               `json:"current_agent,omitempty"`   // selected OpenCode profile; Agent remains the CLI type
	Agents                 []SessionAgentOption `json:"agents,omitempty"`
	Capabilities           []string             `json:"capabilities,omitempty"`
	ControlMode            string               `json:"control_mode,omitempty"`
	PermissionName         string               `json:"permission_name,omitempty"`
	Patterns               []string             `json:"patterns,omitempty"`
	Always                 []string             `json:"always,omitempty"`
	Metadata               json.RawMessage      `json:"metadata,omitempty"`
	ToolMessageID          string               `json:"tool_message_id,omitempty"`
	ToolCallID             string               `json:"tool_call_id,omitempty"`
	PermissionVersion      string               `json:"permission_version,omitempty"`
	Action                 string               `json:"action,omitempty"`
	ApprovalKind           string               `json:"approval_kind,omitempty"`
	AvailableDecisions     []string             `json:"available_decisions,omitempty"`
	Questions              []QuestionInfo       `json:"questions,omitempty"`
	Answers                [][]string           `json:"answers,omitempty"`
	Rejected               bool                 `json:"rejected,omitempty"`
	AutoResolutionMs       uint64               `json:"auto_resolution_ms,omitempty"`
	Redacted               bool                 `json:"redacted,omitempty"`
	MCPServer              string               `json:"mcp_server,omitempty"`
	ElicitationMode        string               `json:"elicitation_mode,omitempty"`
	ElicitationID          string               `json:"elicitation_id,omitempty"`
	ElicitationSchema      json.RawMessage      `json:"elicitation_schema,omitempty"`
	ElicitationContent     json.RawMessage      `json:"elicitation_content,omitempty"`
}

// ModelOption is one selectable model surfaced by a daemon for session creation.
type ModelOption struct {
	Alias string `json:"alias"` // claude alias (opus/sonnet/haiku) — passed to --model
	Name  string `json:"name"`  // concrete display name (e.g. glm-5.2) — shown in the picker
}

// ContextUsage carries token consumption for a single assistant turn.
type ContextUsage struct {
	InputTokens  int `json:"input_tokens,omitempty"`
	OutputTokens int `json:"output_tokens,omitempty"`
	CacheRead    int `json:"cache_read_tokens,omitempty"`
	CacheCreate  int `json:"cache_create_tokens,omitempty"`
}

type PermissionConfig struct {
	Agent           string `json:"agent"`
	Mode            string `json:"mode,omitempty"`
	Preset          string `json:"preset,omitempty"`
	ApprovalPolicy  string `json:"approval_policy,omitempty"`
	SandboxMode     string `json:"sandbox_mode,omitempty"`
	DangerousBypass bool   `json:"dangerously_bypass,omitempty"`
}

// CommandItem represents a slash command or skill available in a session,
// surfaced to the web client for input autocompletion.
type CommandItem struct {
	Name        string   `json:"name"`   // trigger name, e.g. "clear", "pocket-release", "codex:rescue"
	Source      string   `json:"source"` // builtin | project | user | plugin
	Kind        string   `json:"kind"`   // command | skill
	Description string   `json:"description,omitempty"`
	ArgHint     string   `json:"arg_hint,omitempty"`  // frontmatter argument-hint (mostly commands)
	Namespace   string   `json:"namespace,omitempty"` // plugin name, only for source=plugin
	Template    string   `json:"template,omitempty"`
	Hints       []string `json:"hints,omitempty"`
	Subtask     bool     `json:"subtask,omitempty"`
	Agent       string   `json:"agent,omitempty"`
	Model       string   `json:"model,omitempty"`
}

// SessionAgentOption is a user-selectable OpenCode Agent profile. The session
// layer filters hidden and subagent-only profiles before emitting this type.
type SessionAgentOption struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	Mode        string `json:"mode"`
	Color       string `json:"color,omitempty"`
	Model       string `json:"model,omitempty"`
	Variant     string `json:"variant,omitempty"`
}

type QuestionOption struct {
	Label       string `json:"label"`
	Description string `json:"description,omitempty"`
}

type QuestionInfo struct {
	ID       string           `json:"id,omitempty"`
	Header   string           `json:"header,omitempty"`
	Question string           `json:"question"`
	Options  []QuestionOption `json:"options,omitempty"`
	Multiple bool             `json:"multiple,omitempty"`
	Custom   bool             `json:"custom,omitempty"`
	Secret   bool             `json:"secret,omitempty"`
}

// TodoItem is OpenCode's session-level task snapshot. Status and priority stay
// as source strings so newer OpenCode values remain forward-compatible.
type TodoItem struct {
	Content  string `json:"content"`
	Status   string `json:"status"`
	Priority string `json:"priority"`
}

const (
	MaxQuestionCount       = 16
	MaxQuestionOptionCount = 64
	MaxQuestionAnswerCount = 64
	MaxQuestionAnswerBytes = 4096
)

func ValidApprovalAction(action string) bool {
	switch action {
	case "once", "always", "reject":
		return true
	default:
		return false
	}
}

// ValidateQuestionAnswers validates the ordered OpenCode string[][] reply
// without altering labels or custom text. It rejects malformed/oversized
// client payloads before any request reaches the host OpenCode service.
func ValidateQuestionAnswers(questions []QuestionInfo, answers [][]string) error {
	if len(questions) == 0 || len(questions) > MaxQuestionCount {
		return fmt.Errorf("invalid question count: %d", len(questions))
	}
	if len(answers) != len(questions) {
		return fmt.Errorf("answer count %d does not match question count %d", len(answers), len(questions))
	}
	for i, q := range questions {
		if len(q.Options) > MaxQuestionOptionCount {
			return fmt.Errorf("question %d has too many options", i)
		}
		selected := answers[i]
		if len(selected) == 0 || len(selected) > MaxQuestionAnswerCount {
			return fmt.Errorf("question %d has invalid selection count", i)
		}
		if !q.Multiple && len(selected) != 1 {
			return fmt.Errorf("question %d requires exactly one answer", i)
		}
		options := make(map[string]struct{}, len(q.Options))
		for _, option := range q.Options {
			options[option.Label] = struct{}{}
		}
		for _, answer := range selected {
			if strings.TrimSpace(answer) == "" {
				return fmt.Errorf("question %d contains an empty answer", i)
			}
			if len(answer) > MaxQuestionAnswerBytes {
				return fmt.Errorf("question %d answer exceeds %d bytes", i, MaxQuestionAnswerBytes)
			}
			if _, ok := options[answer]; !ok && !q.Custom {
				return fmt.Errorf("question %d answer is not an option", i)
			}
		}
	}
	return nil
}

// Control messages
type RegisterMessage struct {
	Type            string            `json:"type"`
	DaemonID        string            `json:"daemon_id"`
	Hostname        string            `json:"hostname"`
	Agents          []string          `json:"agents"`
	AgentVersions   map[string]string `json:"agent_versions,omitempty"`
	AgentLatests    map[string]string `json:"agent_latests,omitempty"`
	AgentManageable map[string]bool   `json:"agent_manageable,omitempty"`
	OS              string            `json:"os"`
	IP              string            `json:"ip"`
	Arch            string            `json:"arch,omitempty"`
	Version         string            `json:"version,omitempty"`
	StartedAt       int64             `json:"started_at,omitempty"`
	// AckedSeq is the highest event seq the daemon considers durably delivered
	// (acked + trimmed). On a fresh daemonSeq entry the relay seeds its persisted
	// water-mark from this, so a daemon that reconnects/restarts and replays only
	// its *unacked* tail (e.g. seq 51+) doesn't leave a phantom 1..50 gap that
	// would stall the contiguous ack mark. 0 for a fresh daemon.
	AckedSeq int64 `json:"acked_seq,omitempty"`
	// Always emitted (no omitempty): an explicit empty list lets the relay
	// distinguish "daemon has zero live sessions" (reconcile/close all its
	// lingering running/busy rows) from a legacy daemon that never reports it.
	ActiveSessionIDs   []string `json:"active_session_ids"`
	SupportsQuotaGrant bool     `json:"supports_quota_grant,omitempty"`
}

type QuotaGrant struct {
	ReservationID string `json:"reservation_id"`
	ExpiresAt     int64  `json:"expires_at"`
	Operation     string `json:"operation"`
}

type RegisterAckMessage struct {
	Type         string `json:"type"`
	Status       string `json:"status"`
	ConnectionID string `json:"connection_id"`
	// SupportsEventAck advertises that this relay dedups (daemon_id, seq) events
	// and emits event_ack. When false/absent the daemon falls back to trimming
	// its outbound buffer on successful write (best-effort, legacy behavior).
	SupportsEventAck bool `json:"supports_event_ack,omitempty"`
}

// EventAckMessage is sent by the relay to acknowledge durable receipt of daemon
// events up to and including UpToSeq (highest contiguous persisted seq). The
// daemon trims acknowledged events from its outbound replay buffer.
type EventAckMessage struct {
	Type    string `json:"type"`
	UpToSeq int64  `json:"up_to_seq"`
}

// RelayRestartingMessage hints daemons that the relay is shutting down for a
// restart, so the imminent disconnect is expected (reconnect promptly, do not
// surface an error).
type RelayRestartingMessage struct {
	Type string `json:"type"`
}

type PingMessage struct {
	Type            string                    `json:"type"`
	CpuPct          float64                   `json:"cpu_pct,omitempty"`
	MemPct          float64                   `json:"mem_pct,omitempty"`
	DiskPct         float64                   `json:"disk_pct,omitempty"`
	OpenCodeRuntime *OpenCodeRuntimeTelemetry `json:"opencode_runtime,omitempty"`
}

type OpenCodeRuntimeTelemetry struct {
	FallbackReasons map[string]uint64 `json:"fallback_reasons,omitempty"`
	HealthOK        uint64            `json:"health_ok,omitempty"`
	HealthFailed    uint64            `json:"health_failed,omitempty"`
}

type PongMessage struct {
	Type string `json:"type"`
}

type DaemonStatusMessage struct {
	Type     string `json:"type"`
	DaemonID string `json:"daemon_id"`
	Status   string `json:"status"`
}

type ReplayMessage struct {
	Type      string `json:"type"`
	SessionID string `json:"session_id"`
	LastSeq   int64  `json:"last_seq"`
}

// Session config
type SessionConfig struct {
	Agent         string            `json:"agent"`
	Cwd           string            `json:"cwd"`
	Prompt        string            `json:"prompt"`
	AllowedTools  []string          `json:"allowed_tools,omitempty"`
	Permission    *PermissionConfig `json:"permission,omitempty"`
	Model         string            `json:"model,omitempty"` // resolved clean model name (no [...] suffix)
	Worktree      bool              `json:"worktree,omitempty"`
	AutoCreateDir bool              `json:"auto_create_dir,omitempty"`
	Force         bool              `json:"force,omitempty"`
}

// Session states
const (
	StatusRunning         = "running"
	StatusBusy            = "busy"
	StatusRetry           = "retry"
	StatusWaitingApproval = "waiting_approval"
	StatusWaitingQuestion = "waiting_question"
	StatusIdle            = "idle"
	StatusExited          = "exited"
	StatusDisconnected    = "disconnected"
	StatusCompleted       = "completed"
	StatusError           = "error"
	StatusKilled          = "killed"
)

// Exit reasons for terminal session exits
const (
	ExitReasonUserInterrupt = "user_interrupt"
	ExitReasonNormalExit    = "normal_exit"
	ExitReasonProcessCrash  = "process_crash"
	ExitReasonSignalKill    = "signal_kill"
	ExitReasonUnknown       = "unknown"
)

// Failure reason codes for upgrade_result (status="failed"). Sent alongside
// `error` so clients can render actionable hints (e.g. permission_denied →
// instruct the user to switch claude to a sudo-free native install).
const (
	ReasonPermissionDenied = "permission_denied"
)

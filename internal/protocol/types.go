package protocol

import "encoding/json"

// Client → Daemon commands
type ClientMessage struct {
	Type      string `json:"type"`
	SessionID string `json:"session_id,omitempty"`
	Content   string `json:"content,omitempty"`
	Agent     string `json:"agent,omitempty"`
	Cwd       string `json:"cwd,omitempty"`
	Prompt    string `json:"prompt,omitempty"`
	RequestID string `json:"request_id,omitempty"`
	Approved  bool   `json:"approved,omitempty"`
}

// Daemon → Client events
type DaemonEvent struct {
	Type             string          `json:"type"`
	SessionID        string          `json:"session_id"`
	OldSessionID     string          `json:"old_session_id,omitempty"`
	Text             string          `json:"text,omitempty"`
	Streaming        bool            `json:"streaming,omitempty"`
	CallID           string          `json:"call_id,omitempty"`
	Tool             string          `json:"tool,omitempty"`
	Input            json.RawMessage `json:"input,omitempty"`
	Output           string          `json:"output,omitempty"`
	Status           string          `json:"status,omitempty"`
	Error            string          `json:"error,omitempty"`
	CostUSD          float64         `json:"cost_usd,omitempty"`
	Turns            int             `json:"turns,omitempty"`
	RiskLevel        string          `json:"risk_level,omitempty"`
	RequestID        string          `json:"request_id,omitempty"`
	Title            string          `json:"title,omitempty"`
	Cwd              string          `json:"cwd,omitempty"`
	Source           string          `json:"source,omitempty"`
	ExitReason       string          `json:"exit_reason,omitempty"`
	LastActivityAt   string          `json:"last_activity_at,omitempty"`
	AgentID          string          `json:"agent_id,omitempty"`        // sub-agent identifier (e.g. "afa8314e6e3f6e552)
	SubAgentDesc     string          `json:"subagent_desc,omitempty"`   // sub-agent task description
	SubAgentType     string          `json:"subagent_type,omitempty"`   // sub-agent type (Explore, general-purpose, etc.)
	UserMessage      string          `json:"user_message,omitempty"`   // for generate_title_request
	AssistantMessage string          `json:"assistant_message,omitempty"` // for generate_title_request
	Reason           string          `json:"reason,omitempty"`          // failure reason code (no_cli, bad_cwd, start_fail, timeout, daemon_offline)
	Commands         []CommandItem   `json:"commands,omitempty"`        // for command_list
}

// CommandItem represents a slash command or skill available in a session,
// surfaced to the web client for input autocompletion.
type CommandItem struct {
	Name        string `json:"name"`                  // trigger name, e.g. "clear", "pocket-release", "codex:rescue"
	Source      string `json:"source"`                // builtin | project | user | plugin
	Kind        string `json:"kind"`                  // command | skill
	Description string `json:"description,omitempty"`
	ArgHint     string `json:"arg_hint,omitempty"`    // frontmatter argument-hint (mostly commands)
	Namespace   string `json:"namespace,omitempty"`   // plugin name, only for source=plugin
}

// Control messages
type RegisterMessage struct {
	Type      string   `json:"type"`
	DaemonID  string   `json:"daemon_id"`
	Hostname  string   `json:"hostname"`
	Agents    []string `json:"agents"`
	OS        string   `json:"os"`
	IP        string   `json:"ip"`
	Arch      string   `json:"arch,omitempty"`
	Version   string   `json:"version,omitempty"`
	StartedAt int64    `json:"started_at,omitempty"`
}

type RegisterAckMessage struct {
	Type         string `json:"type"`
	Status       string `json:"status"`
	ConnectionID string `json:"connection_id"`
}

type PingMessage struct {
	Type    string  `json:"type"`
	CpuPct  float64 `json:"cpu_pct,omitempty"`
	MemPct  float64 `json:"mem_pct,omitempty"`
	DiskPct float64 `json:"disk_pct,omitempty"`
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
	Agent          string   `json:"agent"`
	Cwd            string   `json:"cwd"`
	Prompt         string   `json:"prompt"`
	AllowedTools   []string `json:"allowed_tools,omitempty"`
	PermissionMode string   `json:"permission_mode,omitempty"`
	Model          string   `json:"model,omitempty"` // resolved clean model name (no [...] suffix)
}

// Session states
const (
	StatusRunning         = "running"
	StatusWaitingApproval = "waiting_approval"
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

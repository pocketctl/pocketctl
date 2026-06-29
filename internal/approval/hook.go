package approval

import (
	"bufio"
	"encoding/json"
	"fmt"
	"log/slog"
	"net"
	"os"
	"time"

	"github.com/pocketctl/pocketctl/internal/config"
)

// RunHook is the entry point for the `pocketctl __hook` subcommand invoked by
// Claude's PreToolUse hook machinery. It decides whether a tool-use needs
// human approval, and if so, forwards the request to the approval Unix socket,
// blocks for the client's decision, and prints Claude's hookSpecificOutput JSON
// to stdout (permissionDecision allow/deny).
//
// Scheme C — file locking: for ALL permission modes (including bypass), if the
// tool writes a file (Edit/Write/MultiEdit/NotebookEdit) we ask the server
// whether the target file is locked by another session. The server:
//   - denies with a human/agent-readable reason when the file is held by another
//     session (we print permissionDecision:"deny" so Claude backs off);
//   - for bypass mode with no conflict, returns allow and we writeContinue();
//   - for non-bypass with no conflict, runs the normal client-approval flow and
//     we print the client's allow/deny decision.
//
// Session routing: Claude's hook payload includes `session_id` as a common
// field on every event, so we read it from stdin FIRST. This lets a `claude`
// process the user launched in their own terminal reach the daemon — no env
// var injection required. The POCKETCTL_SESSION_ID env var is still honored as
// a fallback for daemon-spawned sessions (and keeps older tests working).
//
// The socket path defaults to the user-global ~/.pocketctl/approval.sock (see
// config.ApprovalSocketPath) so any terminal's hook connects to the single
// running daemon; POCKETCTL_APPROVAL_SOCK overrides it if set.
//
// Failure policy: if the daemon isn't running (socket unreachable / missing),
// we writeContinue() so Claude falls back to its OWN permission UI rather than
// silently denying every tool — the user's terminal stays usable without the
// daemon. Only when we successfully reach the daemon do we honor its decision.
func RunHook(logger *slog.Logger) error {
	if logger == nil {
		logger = slog.Default()
	}

	// Claude's PreToolUse hook payload. `session_id` and `transcript_path` are
	// common fields present on every hook event (see Claude Code hook docs);
	// unknown fields are ignored.
	var payload struct {
		SessionID string          `json:"session_id"`
		ToolName  string          `json:"tool_name"`
		ToolInput json.RawMessage `json:"tool_input"`
		Cwd       string          `json:"cwd"`
	}
	dec := json.NewDecoder(bufio.NewReader(os.Stdin))
	if err := dec.Decode(&payload); err != nil {
		// On any parse error, fail closed (deny) so a malformed hook never
		// silently approves a tool — but exit 0 so Claude renders our reason.
		writeDecision(false, "approval hook could not parse stdin")
		return err
	}

	permMode := os.Getenv("POCKETCTL_PERM_MODE")

	// Resolve session id: prefer the payload (external terminal sessions),
	// fall back to the env var (daemon-spawned sessions, older tests).
	sessionID := payload.SessionID
	if sessionID == "" {
		sessionID = os.Getenv("POCKETCTL_SESSION_ID")
	}

	// Resolve socket path: env override > user-global default. The user-global
	// default is what lets an external terminal's hook find the daemon.
	sockPath := os.Getenv("POCKETCTL_APPROVAL_SOCK")
	if sockPath == "" {
		sockPath = config.ApprovalSocketPath()
	}

	// External `claude` invocations don't carry POCKETCTL_PERM_MODE; treat the
	// absence of explicit env as "default", which routes through client approval
	// (i.e. surfaces an ApprovalCard). Daemon-spawned sessions still pass their
	// real mode (bypassPermissions / acceptEdits / plan).
	effectivePermMode := permMode
	if effectivePermMode == "" {
		effectivePermMode = "default"
	}

	// If we still can't determine a socket path or session id, fall back to
	// Claude's own permission logic. writeContinue (vs deny) keeps the terminal
	// usable when the daemon couldn't wire the socket.
	if sockPath == "" || sessionID == "" {
		writeContinue()
		return nil
	}

	// Ask the server. It performs the Scheme C file-lock check and, depending on
	// perm mode, either short-circuits (bypass) or brokers client approval.
	resp, err := askSocket(sockPath, sessionID, payload.ToolName, payload.ToolInput, payload.Cwd, effectivePermMode)
	if err != nil {
		// Daemon unreachable (not running, socket gone, etc.). Fall back to
		// Claude's native permission UI so the terminal stays usable without the
		// daemon — do NOT silently deny. We log but otherwise no-op.
		logger.Debug("approval server unreachable, falling back to native UI", "error", err)
		writeContinue()
		return nil
	}

	if !resp.Allow {
		writeDecision(false, orDefault(resp.Reason, "denied by user"))
		return nil
	}

	// Allowed. In bypass mode the server's allow means "no lock conflict" — we
	// have no opinion so Claude proceeds under its own permission logic (and any
	// host hooks). In non-bypass mode the allow is the client's explicit approval.
	if effectivePermMode == "bypassPermissions" {
		writeContinue()
	} else {
		writeDecision(true, orDefault(resp.Reason, "approved by user"))
	}
	return nil
}

// askSocket connects to the approval server, sends one JSON request, and blocks
// for the decision line.
func askSocket(sockPath, sessionID, tool string, input json.RawMessage, cwd, permMode string) (hookResponse, error) {
	conn, err := net.DialTimeout("unix", sockPath, 5*time.Second)
	if err != nil {
		return hookResponse{}, fmt.Errorf("dial: %w", err)
	}
	defer conn.Close()

	req := hookRequest{
		SessionID: sessionID,
		Tool:      tool,
		Input:     input,
		Cwd:       cwd,
		PermMode:  permMode,
	}
	// Always include the input field key so the server sees consistent JSON.
	body, err := json.Marshal(req)
	if err != nil {
		return hookResponse{}, fmt.Errorf("marshal: %w", err)
	}
	body = append(body, '\n')
	_ = conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	if _, err := conn.Write(body); err != nil {
		return hookResponse{}, fmt.Errorf("write: %w", err)
	}

	_ = conn.SetReadDeadline(time.Now().Add(approvalTimeout + time.Minute))
	reader := bufio.NewReader(conn)
	line, err := reader.ReadBytes('\n')
	if err != nil {
		return hookResponse{}, fmt.Errorf("read: %w", err)
	}
	var resp hookResponse
	if err := json.Unmarshal(line, &resp); err != nil {
		return hookResponse{}, fmt.Errorf("parse: %w", err)
	}
	return resp, nil
}

// writeDecision prints Claude's PreToolUse hook output JSON to stdout. Claude
// reads permissionDecision: "allow" lets the tool run; "deny" blocks it and
// shows permissionDecisionReason to the user.
func writeDecision(allow bool, reason string) {
	decision := "allow"
	if !allow {
		decision = "deny"
	}
	out := map[string]any{
		"hookSpecificOutput": map[string]any{
			"hookEventName":            "PreToolUse",
			"permissionDecision":       decision,
			"permissionDecisionReason": reason,
		},
	}
	b, _ := json.Marshal(out)
	fmt.Println(string(b))
}

// writeContinue prints the "no opinion" hook output so Claude proceeds with its
// own permission logic (and any other hooks). Used in bypassPermissions mode.
func writeContinue() {
	b, _ := json.Marshal(map[string]any{"continue": true})
	fmt.Println(string(b))
}

func orDefault(s, def string) string {
	if s == "" {
		return def
	}
	return s
}

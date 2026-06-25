package approval

import (
	"bufio"
	"encoding/json"
	"fmt"
	"log/slog"
	"net"
	"os"
	"time"
)

// RunHook is the entry point for the `pocketctl __hook` subcommand invoked by
// Claude's PreToolUse hook machinery. It reads Claude's hook payload from
// stdin, forwards the tool-use details to the approval Unix socket, blocks for
// the client's decision, and prints Claude's hookSpecificOutput JSON to stdout
// (permissionDecision allow/deny).
//
// The session id and socket path are passed via the POCKETCTL_SESSION_ID and
// POCKETCTL_APPROVAL_SOCK env vars (set by the daemon when launching the PTY).
func RunHook(logger *slog.Logger) error {
	if logger == nil {
		logger = slog.Default()
	}

	// Claude's PreToolUse hook payload (simplified — we only need the tool name
	// and input). Unknown fields are ignored.
	var payload struct {
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

	sessionID := os.Getenv("POCKETCTL_SESSION_ID")
	sockPath := os.Getenv("POCKETCTL_APPROVAL_SOCK")
	if sessionID == "" || sockPath == "" {
		// Not wired (e.g. a bypassPermissions session shouldn't reach here, or
		// the daemon didn't set env). Deny rather than silently allow.
		writeDecision(false, "approval hook not configured (missing env)")
		return nil
	}

	resp, err := askSocket(sockPath, sessionID, payload.ToolName, payload.ToolInput, payload.Cwd)
	if err != nil {
		logger.Error("approval hook socket", "error", err)
		writeDecision(false, fmt.Sprintf("approval server unreachable: %v", err))
		return nil
	}

	if resp.Allow {
		writeDecision(true, "approved by user")
	} else {
		writeDecision(false, orDefault(resp.Reason, "denied by user"))
	}
	return nil
}

// askSocket connects to the approval server, sends one JSON request, and blocks
// for the decision line.
func askSocket(sockPath, sessionID, tool string, input json.RawMessage, cwd string) (hookResponse, error) {
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

func orDefault(s, def string) string {
	if s == "" {
		return def
	}
	return s
}

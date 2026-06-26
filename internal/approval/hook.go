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
// The session id, socket path, and effective permission mode are passed via
// env vars (POCKETCTL_SESSION_ID, POCKETCTL_APPROVAL_SOCK,
// POCKETCTL_PERM_MODE) set by the daemon when launching the PTY.
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

	permMode := os.Getenv("POCKETCTL_PERM_MODE")
	sessionID := os.Getenv("POCKETCTL_SESSION_ID")
	sockPath := os.Getenv("POCKETCTL_APPROVAL_SOCK")

	// If the approval socket isn't wired (e.g. the daemon couldn't install
	// hooks), fall back to Claude's own permission logic. In bypass this means
	// writeContinue; in non-bypass we must deny (the user expected a prompt we
	// can't surface) — but that's pre-existing behavior.
	if sessionID == "" || sockPath == "" {
		if permMode == "bypassPermissions" {
			writeContinue()
		} else {
			writeDecision(false, "approval hook not configured (missing env)")
		}
		return nil
	}

	// Ask the server. It performs the Scheme C file-lock check and, depending on
	// perm mode, either short-circuits (bypass) or brokers client approval.
	resp, err := askSocket(sockPath, sessionID, payload.ToolName, payload.ToolInput, payload.Cwd, permMode)
	if err != nil {
		logger.Error("approval hook socket", "error", err)
		// Unreachable server: fail safe per mode.
		if permMode == "bypassPermissions" {
			writeContinue()
		} else {
			writeDecision(false, fmt.Sprintf("approval server unreachable: %v", err))
		}
		return nil
	}

	if !resp.Allow {
		writeDecision(false, orDefault(resp.Reason, "denied by user"))
		return nil
	}

	// Allowed. In bypass mode the server's allow means "no lock conflict" — we
	// have no opinion so Claude proceeds under its own permission logic (and any
	// host hooks). In non-bypass mode the allow is the client's explicit approval.
	if permMode == "bypassPermissions" {
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

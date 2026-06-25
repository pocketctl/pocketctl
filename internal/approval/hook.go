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
// Mode handling (the crux of supporting bypassPermissions):
//   - bypassPermissions: Claude auto-approves everything, so we return
//     "continue" (no opinion) and never touch the socket. Our hook is only
//     there to catch the exception — a host-side PreToolUse hook that returns
//     permissionDecision:"ask", which overrides bypass. We CANNOT detect that
//     here (our hook runs before the host hook), so for bypass we defer entirely
//     to Claude and the host hooks. If a host hook forces "ask", Claude will
//     render the prompt in the PTY; the daemon's watchdog + the user's Stop
//     button are the escape hatches.
//   - non-bypass (default/acceptEdits/plan): we ask the client via the socket.
//     This surfaces the would-be PTY prompt as an inline card instead of
//     stalling on discarded stdout.
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

	// In bypassPermissions, defer entirely to Claude + any host hooks. We never
	// block: most tools auto-run. (If a host hook overrides bypass with "ask",
	// that prompt is a separate problem — see the daemon's PTY-handling notes;
	// it is not something this hook can intercept.)
	if permMode == "bypassPermissions" {
		writeContinue()
		return nil
	}

	sessionID := os.Getenv("POCKETCTL_SESSION_ID")
	sockPath := os.Getenv("POCKETCTL_APPROVAL_SOCK")
	if sessionID == "" || sockPath == "" {
		// Non-bypass session but the approval socket isn't wired (e.g. daemon
		// couldn't install hooks). Deny rather than silently allow a tool the
		// user expected to approve.
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

// writeContinue prints the "no opinion" hook output so Claude proceeds with its
// own permission logic (and any other hooks). Used in bypassPermissions mode.
func writeContinue() {
	b, _ := json.Marshal(map[string]any{"continue": true})
	fmt.Println(string(b))
}

func orDefault(s, def string) string {
	if s == "" {
		return s
	}
	return s
}

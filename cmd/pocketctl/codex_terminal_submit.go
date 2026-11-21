package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"slices"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"github.com/mattn/go-isatty"

	"github.com/pocketctl/pocketctl/internal/config"
	"github.com/pocketctl/pocketctl/internal/protocol"
	"github.com/pocketctl/pocketctl/internal/session"
)

func runCodexTerminalSubmit(args []string, stdin *os.File, stdout, stderr io.Writer) error {
	const usage = "pocketctl agent codex submit <session-id>"
	if len(args) == 1 && (args[0] == "-h" || args[0] == "--help") {
		fmt.Fprintln(stdout, usage)
		fmt.Fprintln(stdout, "Enter one line for a managed Codex terminal. The command prints the accepting native turn ID. Concurrent native inputs can share a turn on runtimes without atomic idle admission.")
		return nil
	}
	if len(args) != 1 || strings.TrimSpace(args[0]) == "" || strings.HasPrefix(args[0], "-") {
		return errors.New(usage)
	}
	if !isatty.IsTerminal(stdin.Fd()) && !isatty.IsCygwinTerminal(stdin.Fd()) {
		return errors.New("enter your message from an interactive terminal")
	}
	relay, token, _, err := config.LoadAuth()
	if err != nil || token == "" || relay == "" {
		return errors.New("sign in with pocketctl login before submitting")
	}
	fmt.Fprint(stderr, "Message (one line, Enter to submit): ")
	scanner := bufio.NewScanner(stdin)
	if !scanner.Scan() {
		if err := scanner.Err(); err != nil {
			return err
		}
		return errors.New("input cancelled")
	}
	content := scanner.Text()
	if strings.TrimSpace(content) == "" {
		return errors.New("empty message")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	requestID := "terminal-" + uuid.NewString()
	fmt.Fprintf(stderr, "Request %s\n", requestID)
	turnID, err := submitCodexTerminalMessage(ctx, relay, token, args[0], content, requestID)
	if err != nil {
		return err
	}
	fmt.Fprintf(stdout, "Accepted input for turn %s\n", turnID)
	return nil
}

func submitCodexTerminalMessage(ctx context.Context, relay, token, sessionID, content, requestID string) (string, error) {
	endpoint, err := url.Parse(relay)
	if err != nil || endpoint.Host == "" || (endpoint.Scheme != "ws" && endpoint.Scheme != "wss") || endpoint.User != nil {
		return "", errors.New("invalid Relay WebSocket URL")
	}
	if !strings.HasSuffix(endpoint.Path, "/ws") {
		endpoint.Path = strings.TrimRight(endpoint.Path, "/") + "/ws"
	}
	endpoint.RawQuery = "type=client"
	conn, _, err := websocket.DefaultDialer.DialContext(ctx, endpoint.String(), http.Header{"Authorization": {"Bearer " + token}})
	if err != nil {
		return "", fmt.Errorf("connect to Relay: %w", err)
	}
	defer conn.Close()
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stop()
	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetWriteDeadline(deadline)
		_ = conn.SetReadDeadline(deadline)
	}
	metaID := uuid.NewString()
	if err := conn.WriteJSON(protocol.ClientMessage{Type: "get_session_meta", RequestID: metaID, SessionID: sessionID}); err != nil {
		return "", err
	}
	messageID := uuid.NewString()
	sent := false
	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			if sent {
				return "", errors.New("submission outcome unknown. Check the session before submitting again")
			}
			return "", fmt.Errorf("read managed session capability: %w", err)
		}
		// Non-daemon broadcasts can reuse fields with incompatible types, e.g.
		// quota_status.plan is a string. Decode only our reply types as events.
		var frame struct {
			Type string `json:"type"`
		}
		if json.Unmarshal(data, &frame) != nil {
			continue
		}
		switch frame.Type {
		case "session_meta", "error", "user_message_nack", "user_message_receipt", "user_text":
		default:
			continue
		}
		var event protocol.DaemonEvent
		if json.Unmarshal(data, &event) != nil {
			continue
		}
		if !sent {
			if event.Type == "error" && (event.RequestID == metaID || event.SessionID == sessionID) {
				return "", errors.New("Relay could not access the requested session")
			}
			if event.Type != "session_meta" || event.SessionID != sessionID || event.RequestID != metaID {
				continue
			}
			if event.ControlMode != protocol.ControlManaged || !slices.Contains(event.Capabilities, session.CodexTerminalSubmitCapability) {
				return "", errors.New("session must be a managed Codex terminal on a daemon supporting terminal submission")
			}
			command := protocol.ClientMessage{Type: "user_message", SessionID: sessionID, TerminalSubmit: true, RequestID: requestID, MsgID: messageID, Content: content}
			if err := conn.WriteJSON(command); err != nil {
				return "", errors.New("submission outcome unknown. Check the session before submitting again")
			}
			sent = true
			continue
		}
		if event.Type == "user_message_nack" && (event.MsgID == messageID || event.RequestID == requestID) {
			return "", fmt.Errorf("Relay declined the submission (%s)", event.Reason)
		}
		if event.SessionID != sessionID || event.RequestID != requestID || event.MsgID != messageID {
			continue
		}
		if event.Type == "user_message_receipt" && event.Status == "rejected" {
			return "", fmt.Errorf("no confirmed input (%s). Check the session before submitting again", event.Reason)
		}
		p := event.MemorySource
		if event.Type == "user_text" && event.EventID == "native-input:"+messageID && event.TurnID != "" && event.SourceTurnID != "" && p != nil &&
			p.Version == 1 && p.Producer == "codex" && p.SourceRole == "user" && p.SessionID == sessionID && p.TurnID == event.TurnID &&
			p.LineageComplete && p.SkillState == "non_skill" && p.EventID == protocol.MemoryInputEventID(sessionID, requestID, messageID) && p.InvocationID == p.EventID && p.ParentInvocationID == "" && len(p.DerivedFromEventIDs) == 0 {
			return event.SourceTurnID, nil
		}
	}
}

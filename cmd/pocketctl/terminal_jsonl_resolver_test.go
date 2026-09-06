package main

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/protocol"
	"github.com/pocketctl/pocketctl/internal/session"
	"github.com/pocketctl/pocketctl/internal/watcher"
)

func TestResolveTerminalJSONLRecoversAfterFastWindow(t *testing.T) {
	const sessionID = "late-session"
	outputCh := make(chan protocol.DaemonEvent, 8)
	sm := session.NewSessionManager(outputCh)
	sm.RegisterTerminalSession(sessionID, "/repo", 4242, "", "busy", adapter.AgentClaude)

	attempts := 0
	policy := terminalJSONLResolvePolicy{
		fastAttempts: 2,
		fastDelay:    time.Millisecond,
		maxLateDelay: 4 * time.Millisecond,
		resolve: func(_, _, _ string) (string, error) {
			attempts++
			if attempts < 4 {
				return "", errors.New("jsonl not created yet")
			}
			return "/repo/late-session.jsonl", nil
		},
		readMetadata: func(string) (watcher.DiscoveredSession, error) {
			return watcher.DiscoveredSession{
				Pid: 4242, SessionID: sessionID, Cwd: "/repo", Status: "idle",
			}, nil
		},
		isProcessAlive: func(int) bool { return true },
		wait:           noDelayTerminalJSONLWait,
	}

	got, err := resolveTerminalJSONLForSession(
		context.Background(), sm, watcher.SessionEvent{
			Session: watcher.DiscoveredSession{
				Pid: 4242, SessionID: sessionID, Cwd: "/repo", Status: "busy",
			},
			Filepath: "/sessions/4242.json",
		}, adapter.AgentClaude, policy, nil,
	)
	if err != nil {
		t.Fatalf("resolveTerminalJSONLForSession() error = %v", err)
	}
	if got.path != "/repo/late-session.jsonl" || !got.recoveredLate {
		t.Fatalf("resolution = %+v, want late JSONL recovery", got)
	}
	if attempts != 4 {
		t.Fatalf("resolve attempts = %d, want 4 (past fast window)", attempts)
	}

	sessions := sm.ListSessions()
	if len(sessions) != 1 || sessions[0].SessionID != sessionID || sessions[0].Status != "idle" {
		t.Fatalf("sessions after late recovery = %+v, want re-registered idle session", sessions)
	}
}

func TestResolveTerminalJSONLRetiresReassignedGhost(t *testing.T) {
	const sessionID = "transient-session"
	outputCh := make(chan protocol.DaemonEvent, 8)
	sm := session.NewSessionManager(outputCh)
	sm.RegisterTerminalSession(sessionID, "/repo", 5252, "", "busy", adapter.AgentClaude)

	policy := terminalJSONLResolvePolicy{
		fastAttempts: 1,
		fastDelay:    time.Millisecond,
		maxLateDelay: 4 * time.Millisecond,
		resolve: func(_, _, _ string) (string, error) {
			return "", errors.New("jsonl does not exist")
		},
		readMetadata: func(string) (watcher.DiscoveredSession, error) {
			return watcher.DiscoveredSession{
				Pid: 5252, SessionID: "resumed-session", Cwd: "/repo", Status: "busy",
			}, nil
		},
		isProcessAlive: func(int) bool { return true },
		wait:           noDelayTerminalJSONLWait,
	}

	_, err := resolveTerminalJSONLForSession(
		context.Background(), sm, watcher.SessionEvent{
			Session: watcher.DiscoveredSession{
				Pid: 5252, SessionID: sessionID, Cwd: "/repo", Status: "busy",
			},
			Filepath: "/sessions/5252.json",
		}, adapter.AgentClaude, policy, nil,
	)
	if !errors.Is(err, errTerminalJSONLSessionRetired) {
		t.Fatalf("resolveTerminalJSONLForSession() error = %v, want retired ghost", err)
	}
	if sessions := sm.ListSessions(); len(sessions) != 0 {
		t.Fatalf("retired ghost remained registered: %+v", sessions)
	}
}

func TestResolveTerminalJSONLMarksLateRecoveryExitedWhenProcessDied(t *testing.T) {
	const sessionID = "late-exited-session"
	outputCh := make(chan protocol.DaemonEvent, 8)
	sm := session.NewSessionManager(outputCh)
	sm.RegisterTerminalSession(sessionID, "/repo", 6262, "", "busy", adapter.AgentClaude)

	attempts := 0
	livenessChecks := 0
	policy := terminalJSONLResolvePolicy{
		fastAttempts: 1,
		fastDelay:    time.Millisecond,
		maxLateDelay: 4 * time.Millisecond,
		resolve: func(_, _, _ string) (string, error) {
			attempts++
			if attempts < 3 {
				return "", errors.New("jsonl not created yet")
			}
			return "/repo/late-exited-session.jsonl", nil
		},
		readMetadata: func(string) (watcher.DiscoveredSession, error) {
			return watcher.DiscoveredSession{
				Pid: 6262, SessionID: sessionID, Cwd: "/repo", Status: "busy",
			}, nil
		},
		isProcessAlive: func(int) bool {
			livenessChecks++
			return livenessChecks == 1
		},
		wait: noDelayTerminalJSONLWait,
	}

	got, err := resolveTerminalJSONLForSession(
		context.Background(), sm, watcher.SessionEvent{
			Session: watcher.DiscoveredSession{
				Pid: 6262, SessionID: sessionID, Cwd: "/repo", Status: "busy",
			},
			Filepath: "/sessions/6262.json",
		}, adapter.AgentClaude, policy, nil,
	)
	if err != nil {
		t.Fatalf("resolveTerminalJSONLForSession() error = %v", err)
	}
	if got.session.Status != protocol.StatusExited {
		t.Fatalf("late recovered status = %q, want %q", got.session.Status, protocol.StatusExited)
	}

	sessions := sm.ListSessions()
	if len(sessions) != 1 || sessions[0].Status != protocol.StatusExited {
		t.Fatalf("sessions after late exited recovery = %+v, want one exited session", sessions)
	}
}

func TestResolveTerminalJSONLIgnoresMetadataWithoutSessionID(t *testing.T) {
	const sessionID = "late-session"
	outputCh := make(chan protocol.DaemonEvent, 8)
	sm := session.NewSessionManager(outputCh)
	sm.RegisterTerminalSession(sessionID, "/repo", 7272, "", "busy", adapter.AgentClaude)

	attempts := 0
	policy := terminalJSONLResolvePolicy{
		fastAttempts: 1,
		fastDelay:    time.Millisecond,
		maxLateDelay: 4 * time.Millisecond,
		resolve: func(_, _, _ string) (string, error) {
			attempts++
			if attempts < 3 {
				return "", errors.New("jsonl not created yet")
			}
			return "/repo/late-session.jsonl", nil
		},
		readMetadata: func(string) (watcher.DiscoveredSession, error) {
			return watcher.DiscoveredSession{
				Pid: 7272, Cwd: "/repo", Status: "busy",
			}, nil
		},
		isProcessAlive: func(int) bool { return true },
		wait:           noDelayTerminalJSONLWait,
	}

	got, err := resolveTerminalJSONLForSession(
		context.Background(), sm, watcher.SessionEvent{
			Session: watcher.DiscoveredSession{
				Pid: 7272, SessionID: sessionID, Cwd: "/repo", Status: "busy",
			},
			Filepath: "/sessions/7272.json",
		}, adapter.AgentClaude, policy, nil,
	)
	if err != nil {
		t.Fatalf("resolveTerminalJSONLForSession() error = %v", err)
	}
	if got.session.SessionID != sessionID || !got.recoveredLate {
		t.Fatalf("resolution = %+v, want original session recovered late", got)
	}
}

func noDelayTerminalJSONLWait(ctx context.Context, _ time.Duration) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
		return nil
	}
}

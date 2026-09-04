package main

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"time"

	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/protocol"
	"github.com/pocketctl/pocketctl/internal/session"
	"github.com/pocketctl/pocketctl/internal/watcher"
)

var errTerminalJSONLSessionRetired = errors.New("terminal session metadata no longer references unresolved JSONL")

type terminalJSONLResolvePolicy struct {
	fastAttempts   int
	fastDelay      time.Duration
	maxLateDelay   time.Duration
	resolve        func(agentType, sessionID, cwd string) (string, error)
	readMetadata   func(path string) (watcher.DiscoveredSession, error)
	isProcessAlive func(pid int) bool
	wait           func(context.Context, time.Duration) error
}

type terminalJSONLResolution struct {
	path          string
	session       watcher.DiscoveredSession
	recoveredLate bool
}

func defaultTerminalJSONLResolvePolicy() terminalJSONLResolvePolicy {
	return terminalJSONLResolvePolicy{
		fastAttempts:   30,
		fastDelay:      2 * time.Second,
		maxLateDelay:   30 * time.Second,
		resolve:        adapter.ResolveJSONLPathFor,
		readMetadata:   watcher.ReadSessionMetadata,
		isProcessAlive: watcher.IsProcessAlive,
		wait:           waitForTerminalJSONLRetry,
	}
}

// resolveTerminalJSONLForSession keeps the original short, eager lookup window
// but does not treat its expiry as proof that the session is a ghost. Once the
// fast window expires the provisional SessionManager entry is detached (so it
// cannot emit status-only phantom sessions) and this same supervised goroutine
// continues condition-based lookup with a capped backoff. A late success is
// re-registered before the caller attaches and announces the tailer.
func resolveTerminalJSONLForSession(
	ctx context.Context,
	sm *session.SessionManager,
	evt watcher.SessionEvent,
	agentType string,
	policy terminalJSONLResolvePolicy,
	logger *slog.Logger,
) (terminalJSONLResolution, error) {
	current := evt.Session
	fastAttempts := policy.fastAttempts
	if fastAttempts < 1 {
		fastAttempts = 1
	}
	fastDelay := policy.fastDelay
	if fastDelay <= 0 {
		fastDelay = 2 * time.Second
	}
	maxLateDelay := policy.maxLateDelay
	if maxLateDelay < fastDelay {
		maxLateDelay = fastDelay
	}

	late := false
	detached := false
	lateFailures := 0
	for attempts := 1; ; attempts++ {
		path, err := policy.resolve(agentType, current.SessionID, current.Cwd)
		if err == nil {
			if late && current.Pid > 0 && policy.isProcessAlive != nil && !policy.isProcessAlive(current.Pid) {
				switch current.Status {
				case protocol.StatusExited, protocol.StatusCompleted, protocol.StatusError, protocol.StatusKilled:
				default:
					current.Status = protocol.StatusExited
				}
			}
			if late && detached {
				sm.RegisterTerminalSession(
					current.SessionID,
					current.Cwd,
					current.Pid,
					"",
					current.Status,
					agentType,
				)
			}
			return terminalJSONLResolution{
				path:          path,
				session:       current,
				recoveredLate: late,
			}, nil
		}

		if !late {
			if err := policy.wait(ctx, fastDelay); err != nil {
				return terminalJSONLResolution{}, err
			}
			if attempts < fastAttempts {
				continue
			}
			late = true
			detached = sm.DetachUnresolvedTerminalSession(current.SessionID)
			if logger != nil {
				logger.Info("session jsonl unresolved; entering late recovery",
					"session", current.SessionID, "detached", detached)
			}
			continue
		}

		if agentType == adapter.AgentClaude && policy.readMetadata != nil && evt.Filepath != "" {
			latest, metadataErr := policy.readMetadata(evt.Filepath)
			switch {
			case metadataErr == nil && latest.SessionID != "" && latest.SessionID != current.SessionID:
				return terminalJSONLResolution{}, errTerminalJSONLSessionRetired
			case metadataErr == nil && latest.SessionID == current.SessionID:
				current = latest
			case os.IsNotExist(metadataErr) && (current.Pid <= 0 || !policy.isProcessAlive(current.Pid)):
				return terminalJSONLResolution{}, errTerminalJSONLSessionRetired
			}
		}
		if current.Pid > 0 && policy.isProcessAlive != nil && !policy.isProcessAlive(current.Pid) {
			return terminalJSONLResolution{}, errTerminalJSONLSessionRetired
		}

		lateFailures++
		if err := policy.wait(ctx, terminalJSONLLateDelay(fastDelay, maxLateDelay, lateFailures)); err != nil {
			return terminalJSONLResolution{}, err
		}
	}
}

func terminalJSONLLateDelay(base, maximum time.Duration, failures int) time.Duration {
	delay := base
	for i := 0; i < failures && delay < maximum; i++ {
		if delay > maximum/2 {
			return maximum
		}
		delay *= 2
	}
	if delay > maximum {
		return maximum
	}
	return delay
}

func waitForTerminalJSONLRetry(ctx context.Context, delay time.Duration) error {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

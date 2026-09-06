package main

import (
	"bufio"
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"strings"
	"time"

	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/daemon"
	"github.com/pocketctl/pocketctl/internal/protocol"
	"github.com/pocketctl/pocketctl/internal/session"
	"github.com/pocketctl/pocketctl/internal/watcher"
)

// sdkSessionSubagentKind marks children relations that point at a headless
// Claude Code session spawned by an SDK runtime (e.g. the security-guidance
// plugin reviewing a commit) rather than at an in-conversation subagent.
const sdkSessionSubagentKind = "sdk_session"

// sdkSessionAgentType labels the SDK child inside subagent-scoped events.
const sdkSessionAgentType = "sdk"

// The per-PID session file appears before the projects JSONL: at discovery
// the SDK runtime may not have flushed its jsonl yet, so resolution retries
// briefly instead of dropping the session on a cold-start race.
var (
	resolveSDKJSONLPath = func(sessionID, cwd string) (string, error) {
		return adapter.ResolveJSONLPathFor(adapter.AgentClaude, sessionID, cwd)
	}
	sdkJSONLRetryInterval = 500 * time.Millisecond
	sdkJSONLRetryAttempts = 30
)

// isSDKSpawnedSession reports whether a discovered Claude Code session was
// spawned by an Agent SDK runtime (entrypoint prefix "sdk", e.g. sdk-py).
func isSDKSpawnedSession(s watcher.DiscoveredSession) bool {
	return strings.HasPrefix(s.Entrypoint, "sdk")
}

// handleSDKSpawnedSession attaches an SDK-spawned session to its inferred
// host session instead of registering it as a top-level terminal session:
// emit one subagent_discovered (kind sdk_session) and tail the SDK session's
// JSONL through the regular SubAgentTailer so title/status/usage flow through
// the existing children pipeline. Attachment runs on its own goroutine —
// jsonl resolution may wait out the cold-start race and must not stall the
// serial discovery loop. With no live host in the same cwd the session is
// dropped: there is no mount point a user could make sense of.
func handleSDKSpawnedSession(
	ctx context.Context,
	sm *session.SessionManager,
	evt watcher.SessionEvent,
	logger *slog.Logger,
	outputCh chan<- protocol.DaemonEvent,
) {
	sid := evt.Session.SessionID
	host, ok := sm.InferSDKHostSession(evt.Session.Cwd)
	if !ok {
		logger.Warn("sdk session has no active host session, dropped",
			"session", sid, "cwd", evt.Session.Cwd)
		return
	}

	daemon.RunLoop(ctx, "sdk-attach:"+sid, logger, func() {
		jsonlPath := resolveSDKJSONLPathWithRetry(ctx, sid, evt.Session.Cwd)
		if jsonlPath == "" {
			logger.Warn("sdk session jsonl resolution failed, dropped",
				"session", sid, "cwd", evt.Session.Cwd)
			return
		}
		title := sdkSessionTitle(jsonlPath)

		select {
		case outputCh <- protocol.DaemonEvent{
			Type:            "subagent_discovered",
			SessionID:       host,
			AgentID:         sid,
			SubAgentType:    sdkSessionAgentType,
			SubAgentDesc:    title,
			SubagentKind:    sdkSessionSubagentKind,
			ParentSessionID: host,
			IsSubagent:      true,
			RootSessionID:   host,
		}:
		case <-ctx.Done():
			return
		}

		tailer, err := watcher.NewSubAgentTailerForAgent(jsonlPath, sid, host, sdkSessionAgentType, adapter.AgentClaude)
		if err != nil {
			logger.Warn("sdk session tailer start failed; relation kept without content tail",
				"session", sid, "error", err)
			return
		}
		tailer.Run(ctx, outputCh)
	})
}

// resolveSDKJSONLPathWithRetry waits out the cold-start window between the
// per-PID metadata file and the projects JSONL. Returns "" when the jsonl
// never appears within the retry budget or the daemon shuts down.
func resolveSDKJSONLPathWithRetry(ctx context.Context, sessionID, cwd string) string {
	for attempt := 0; ; attempt++ {
		path, err := resolveSDKJSONLPath(sessionID, cwd)
		if err == nil && path != "" {
			return path
		}
		if attempt >= sdkJSONLRetryAttempts {
			return ""
		}
		select {
		case <-ctx.Done():
			return ""
		case <-time.After(sdkJSONLRetryInterval):
		}
	}
}

// sdkSessionTitle truncates the first user message of an SDK session's jsonl.
// It deliberately skips ExtractTitleFromJSONL's isUserMessage heuristics: the
// interactive-session rule that drops >2000-char messages classifies plugin
// review prompts (which embed the changed-file list) as tool instructions.
func sdkSessionTitle(filePath string) string {
	f, err := os.Open(filePath)
	if err != nil {
		return ""
	}
	defer f.Close()
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 1024*1024), 1024*1024)
	for i := 0; i < 500 && scanner.Scan(); i++ {
		var entry adapter.JSONLEntry
		if json.Unmarshal(scanner.Bytes(), &entry) != nil ||
			entry.Type != "user" || entry.Message == nil || entry.Message.Role != "user" {
			continue
		}
		text := firstUserText(entry.Message.Content)
		if text = strings.TrimSpace(text); text != "" {
			return truncateSDKTitle(text)
		}
	}
	return ""
}

// firstUserText accepts both string and block-array content shapes used by
// Claude Code jsonl records.
func firstUserText(raw json.RawMessage) string {
	var textStr string
	if json.Unmarshal(raw, &textStr) == nil && textStr != "" {
		return textStr
	}
	var blocks []adapter.JSONLContentBlock
	if json.Unmarshal(raw, &blocks) == nil {
		for _, b := range blocks {
			if b.Type == "text" && b.Text != "" {
				return b.Text
			}
		}
	}
	return ""
}

func truncateSDKTitle(text string) string {
	const max = 60
	runes := []rune(text)
	if len(runes) > max {
		runes = runes[:max]
	}
	return string(runes)
}

package watcher

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/pocketctl/pocketctl/internal/adapter"
)

// Codex stores every session as a persistent append-only rollout file under
// $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<session-id>.jsonl. Unlike Claude's
// ephemeral ~/.claude/sessions/*.json (one live PID file per active session,
// removed on exit), codex rollouts accumulate forever — so we must NOT surface
// the whole history. CodexSessionWatcher discovers only *fresh* rollouts (file
// modified within codexFreshWindow), which captures sessions started while the
// daemon runs (mtime ≈ now) and ones active around daemon startup, while
// ignoring stale historical files.
//
// It emits the same SessionEvent type as SessionWatcher so the shared discovery
// handler can register it (with agentType "codex").
const (
	codexScanInterval          = 5 * time.Second
	codexFreshWindow           = 5 * time.Minute
	defaultCodexReplayLookback = 24 * time.Hour
)

type CodexSessionWatcher struct {
	sessionsDir     string
	eventsCh        chan SessionEvent
	seen            map[string]bool // rollout path → already processed
	replayCursor    *CodexReplayCursorStore
	replayNotBefore time.Time
}

// NewCodexSessionWatcher creates a watcher over the CODEX_HOME-aware sessions dir.
func NewCodexSessionWatcher() *CodexSessionWatcher {
	return NewCodexSessionWatcherWithReplayCursor(nil)
}

func NewCodexSessionWatcherWithReplayCursor(cursor *CodexReplayCursorStore) *CodexSessionWatcher {
	return &CodexSessionWatcher{
		sessionsDir:  adapter.CodexSessionsDir(),
		eventsCh:     make(chan SessionEvent, 32),
		seen:         make(map[string]bool),
		replayCursor: cursor,
	}
}

// Events returns the channel for session discovery events.
func (cw *CodexSessionWatcher) Events() <-chan SessionEvent { return cw.eventsCh }

// Start performs an initial scan (seeding the seen-set so a restart doesn't
// re-discover historical sessions) and then polls periodically. The sessions
// dir need not exist yet — scans tolerate a missing directory and pick sessions
// up once codex creates it.
func (cw *CodexSessionWatcher) Start(ctx context.Context) error {
	if cw.sessionsDir == "" {
		return fmt.Errorf("codex sessions dir not resolved")
	}
	go func() {
		cw.scanHistoricalSubagents()
		cw.scan(time.Now())
		cw.loop(ctx)
	}()
	return nil
}

func (cw *CodexSessionWatcher) loop(ctx context.Context) {
	ticker := time.NewTicker(codexScanInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			cw.scan(time.Now())
		}
	}
}

// scan checks today's and yesterday's date directories (where any active rollout
// lives) for new fresh rollout files and emits a "discovered" event for each.
func (cw *CodexSessionWatcher) scan(now time.Time) {
	for _, day := range []time.Time{now, now.AddDate(0, 0, -1)} {
		dir := filepath.Join(cw.sessionsDir, day.Format("2006"), day.Format("01"), day.Format("02"))
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue // dir doesn't exist yet (no codex sessions that day)
		}
		for _, e := range entries {
			name := e.Name()
			if e.IsDir() || !strings.HasPrefix(name, "rollout-") || !strings.HasSuffix(name, ".jsonl") {
				continue
			}
			path := filepath.Join(dir, name)
			if cw.seen[path] {
				continue
			}

			info, err := e.Info()
			if err != nil {
				continue
			}
			if now.Sub(info.ModTime()) > codexFreshWindow {
				continue // historical rollout — not an active terminal session
			}
			cw.inspectRollout(path, true)
		}
	}
}

// scanHistoricalSubagents walks persisted Codex history once at daemon start.
// Ordinary historical sessions remain invisible; only explicit subagent
// relations are emitted so legacy top-level child rows can be reconciled.
func (cw *CodexSessionWatcher) scanHistoricalSubagents() {
	lookback := codexReplayLookback()
	if lookback == 0 {
		return
	}
	now := time.Now()
	firstDay := now.Add(-lookback)
	cw.replayNotBefore = firstDay
	for day := firstDay; !day.After(now); day = day.AddDate(0, 0, 1) {
		dir := filepath.Join(cw.sessionsDir, day.Format("2006"), day.Format("01"), day.Format("02"))
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			name := entry.Name()
			if entry.IsDir() || !strings.HasPrefix(name, "rollout-") || !strings.HasSuffix(name, ".jsonl") {
				continue
			}
			cw.inspectRollout(filepath.Join(dir, name), false)
		}
	}
}

func codexReplayLookback() time.Duration {
	raw := strings.TrimSpace(os.Getenv("POCKETCTL_CODEX_REPLAY_LOOKBACK"))
	if raw == "" {
		return defaultCodexReplayLookback
	}
	if raw == "0" {
		return 0
	}
	lookback, err := time.ParseDuration(raw)
	if err != nil || lookback <= 0 {
		return defaultCodexReplayLookback
	}
	return lookback
}

// inspectRollout classifies one rollout. A path is marked seen only after an
// event is emitted. This lets partial files retry and prevents historical main
// sessions from suppressing a later fresh discovery.
func (cw *CodexSessionWatcher) inspectRollout(path string, fresh bool) {
	if cw.seen[path] {
		return
	}
	meta, ok := adapter.ReadCodexRolloutMetadata(path)
	if !ok || meta.ID == "" {
		return
	}
	if meta.IsSubagent {
		replayStartLine := int64(0)
		replayNotBefore := time.Time{}
		if !fresh {
			replayStartLine = cw.replayCursor.StartLine(path)
			replayNotBefore = cw.replayNotBefore
		}
		cw.eventsCh <- SessionEvent{
			Action: "subagent_discovered",
			Session: DiscoveredSession{
				SessionID:       meta.ID,
				Cwd:             meta.Cwd,
				Status:          "busy",
				ParentSessionID: meta.ParentThreadID,
				RootSessionID:   meta.RootSessionID,
				IsSubagent:      true,
				AgentNickname:   meta.AgentNickname,
				AgentPath:       meta.AgentPath,
			},
			Filepath:        path,
			Replay:          !fresh,
			ReplayNotBefore: replayNotBefore,
			ReplayStartLine: replayStartLine,
		}
		cw.seen[path] = true
		return
	}
	if !fresh {
		return
	}
	cw.eventsCh <- SessionEvent{
		Action: "discovered",
		Session: DiscoveredSession{
			SessionID: meta.ID,
			Cwd:       meta.Cwd,
			Status:    "busy",
		},
		Filepath: path,
	}
	cw.seen[path] = true
}

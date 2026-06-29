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
	codexScanInterval = 5 * time.Second
	codexFreshWindow  = 5 * time.Minute
)

type CodexSessionWatcher struct {
	sessionsDir string
	eventsCh    chan SessionEvent
	seen        map[string]bool // rollout path → already processed
}

// NewCodexSessionWatcher creates a watcher over the CODEX_HOME-aware sessions dir.
func NewCodexSessionWatcher() *CodexSessionWatcher {
	return &CodexSessionWatcher{
		sessionsDir: adapter.CodexSessionsDir(),
		eventsCh:    make(chan SessionEvent, 32),
		seen:        make(map[string]bool),
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
	cw.scan(time.Now())
	go cw.loop(ctx)
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
			cw.seen[path] = true

			info, err := e.Info()
			if err != nil {
				continue
			}
			if now.Sub(info.ModTime()) > codexFreshWindow {
				continue // historical rollout — not an active terminal session
			}
			sid, cwd, ok := adapter.CodexRolloutMeta(path)
			if !ok || sid == "" {
				// Brand-new file whose session_meta hasn't been flushed yet —
				// un-mark so the next scan retries.
				delete(cw.seen, path)
				continue
			}
			cw.eventsCh <- SessionEvent{
				Action: "discovered",
				Session: DiscoveredSession{
					SessionID: sid,
					Cwd:       cwd,
					Status:    "busy",
				},
				Filepath: path,
			}
		}
	}
}

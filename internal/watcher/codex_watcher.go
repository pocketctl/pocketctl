package watcher

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/platform"
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
	readMetadata    func(string) (adapter.CodexRolloutMetadata, bool)
	listProcesses   func() ([]platform.ProcessSnapshot, error)
}

// NewCodexSessionWatcher creates a watcher over the CODEX_HOME-aware sessions dir.
func NewCodexSessionWatcher() *CodexSessionWatcher {
	return NewCodexSessionWatcherWithReplayCursor(nil)
}

func NewCodexSessionWatcherWithReplayCursor(cursor *CodexReplayCursorStore) *CodexSessionWatcher {
	return &CodexSessionWatcher{
		sessionsDir:   adapter.CodexSessionsDir(),
		eventsCh:      make(chan SessionEvent, 32),
		seen:          make(map[string]bool),
		replayCursor:  cursor,
		readMetadata:  adapter.ReadCodexRolloutMetadata,
		listProcesses: platform.NewProcessInspector().List,
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

// scan traverses all valid YYYY/MM/DD leaves. The directory date records when
// Codex created a rollout, not whether it is still active, so freshness comes
// exclusively from the rollout file's mtime.
func (cw *CodexSessionWatcher) scan(now time.Time) {
	cutoff := now.Add(-codexFreshWindow)
	cw.forEachRollout(func(path string) {
		info, err := os.Stat(path)
		if err != nil || info.IsDir() || info.ModTime().Before(cutoff) {
			return
		}
		cw.inspectRollout(path, true)
	})
}

// forEachRollout enumerates only valid Codex date leaves. It intentionally
// does not use a session index: a fresh rollout can remain under an older
// directory after midnight or after its original creation date.
func (cw *CodexSessionWatcher) forEachRollout(fn func(string)) {
	years, err := os.ReadDir(cw.sessionsDir)
	if err != nil {
		return
	}
	for _, year := range years {
		if !year.IsDir() || len(year.Name()) != len("2006") {
			continue
		}
		months, err := os.ReadDir(filepath.Join(cw.sessionsDir, year.Name()))
		if err != nil {
			continue
		}
		for _, month := range months {
			if !month.IsDir() || len(month.Name()) != len("01") {
				continue
			}
			days, err := os.ReadDir(filepath.Join(cw.sessionsDir, year.Name(), month.Name()))
			if err != nil {
				continue
			}
			for _, day := range days {
				if !day.IsDir() || len(day.Name()) != len("02") {
					continue
				}
				if _, err := time.Parse("2006/01/02", year.Name()+"/"+month.Name()+"/"+day.Name()); err != nil {
					continue
				}
				dir := filepath.Join(cw.sessionsDir, year.Name(), month.Name(), day.Name())
				entries, err := os.ReadDir(dir)
				if err != nil {
					continue
				}
				for _, entry := range entries {
					if entry.IsDir() || !strings.HasPrefix(entry.Name(), "rollout-") || !strings.HasSuffix(entry.Name(), ".jsonl") {
						continue
					}
					fn(filepath.Join(dir, entry.Name()))
				}
			}
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
	readMetadata := cw.readMetadata
	if readMetadata == nil {
		readMetadata = adapter.ReadCodexRolloutMetadata
	}
	meta, ok := readMetadata(path)
	if !ok || meta.ID == "" {
		return
	}
	if meta.IsSubagent {
		session := cw.projectSession(path, meta)
		replayStartLine := int64(0)
		replayNotBefore := time.Time{}
		if !fresh {
			replayStartLine = cw.replayCursor.StartLine(path)
			replayNotBefore = cw.replayNotBefore
		}
		cw.eventsCh <- SessionEvent{
			Action:          "subagent_discovered",
			Session:         session,
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
	session := cw.projectSession(path, meta)
	cw.eventsCh <- SessionEvent{
		Action:   "discovered",
		Session:  session,
		Filepath: path,
	}
	cw.seen[path] = true
}

func (cw *CodexSessionWatcher) projectSession(path string, meta adapter.CodexRolloutMetadata) DiscoveredSession {
	classification := adapter.ClassifyCodexOrigin(meta)
	if !classification.Classified {
		slog.Warn("codex rollout origin unclassified; using terminal projection",
			"rollout", path,
			"session_id", meta.ID,
			"originator", meta.Originator,
			"native_source", string(meta.NativeSource))
	}

	agentType := classification.AgentType
	source := "terminal"
	if agentType == adapter.AgentCodexDesktop {
		source = "observer"
	}
	// Child rollout history is always parsed through Codex's subagent parser,
	// including children emitted by Desktop-owned parent rollouts.
	if meta.IsSubagent {
		agentType = adapter.AgentCodex
	}
	pid := 0
	if agentType == adapter.AgentCodex && source == "terminal" && !meta.IsSubagent && cw.listProcesses != nil {
		if processes, err := cw.listProcesses(); err == nil {
			pid = NativeCodexTerminalPID(processes, meta.Cwd)
		}
	}
	return DiscoveredSession{
		SessionID:       meta.ID,
		Cwd:             meta.Cwd,
		Pid:             pid,
		Status:          "busy",
		ParentSessionID: meta.ParentThreadID,
		RootSessionID:   meta.RootSessionID,
		IsSubagent:      meta.IsSubagent,
		AgentNickname:   meta.AgentNickname,
		AgentPath:       meta.AgentPath,
		AgentType:       agentType,
		Source:          source,
		ControlMode:     "legacy_read_only",
		Capabilities:    []string{"history_sync"},
	}
}

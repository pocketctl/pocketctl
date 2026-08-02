package watcher

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/config"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

// SubAgentMeta holds metadata parsed from a sub-agent's .meta.json file.
type SubAgentMeta struct {
	AgentID     string // extracted from filename: agent-<id>.meta.json
	AgentType   string `json:"agentType"`
	Description string `json:"description"`
	ToolUseID   string `json:"toolUseId"`
}

// DiscoverSubAgents scans the subagents/ directory adjacent to a parent JSONL file.
// parentJSONLPath is the full path to the parent session's .jsonl file.
func DiscoverSubAgents(parentJSONLPath string) ([]SubAgentMeta, error) {
	// Derive subagents directory: /path/<session-id>.jsonl → /path/<session-id>/subagents/
	dir := filepath.Dir(parentJSONLPath)
	sessionDir := strings.TrimSuffix(filepath.Base(parentJSONLPath), ".jsonl")
	subagentsDir := filepath.Join(dir, sessionDir, "subagents")

	entries, err := os.ReadDir(subagentsDir)
	if err != nil {
		return nil, nil // directory doesn't exist yet — not an error
	}

	var metas []SubAgentMeta
	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasPrefix(name, "agent-") || !strings.HasSuffix(name, ".meta.json") {
			continue
		}
		// Extract agent ID from filename: agent-<id>.meta.json
		agentID := strings.TrimPrefix(name, "agent-")
		agentID = strings.TrimSuffix(agentID, ".meta.json")

		data, err := os.ReadFile(filepath.Join(subagentsDir, name))
		if err != nil {
			continue
		}

		var meta SubAgentMeta
		if err := json.Unmarshal(data, &meta); err != nil {
			continue
		}
		meta.AgentID = agentID
		metas = append(metas, meta)
	}
	return metas, nil
}

// SubAgentJSONLPath returns the JSONL file path for a sub-agent.
func SubAgentJSONLPath(parentJSONLPath string, agentID string) string {
	dir := filepath.Dir(parentJSONLPath)
	sessionDir := strings.TrimSuffix(filepath.Base(parentJSONLPath), ".jsonl")
	return filepath.Join(dir, sessionDir, "subagents", "agent-"+agentID+".jsonl")
}

// JSONLTailer tracks and reads new lines from an agent's JSONL session file.
// The file handle and scanner buffer are reused across calls to minimize
// allocations. The parser is agent-specific (Claude vs Codex schema).
type JSONLTailer struct {
	mu             sync.Mutex
	filePath       string
	offset         int64
	file           *os.File
	scanBuf        []byte              // reusable 1MB scanner buffer
	paused         atomic.Bool         // D2: paused during sendToIdleTerminal to avoid double-forward
	parser         adapter.JSONLParser // agent-specific stateful parser
	stableEventIDs bool
	eventSourceID  string
	lineIndex      int64
	notBefore      time.Time
	replayUntil    int64
	claudeV2       bool
	maxRecordBytes int
}

// Pause stops the tailer from forwarding new lines (used during sendToIdleTerminal
// to avoid double-forwarding stdout-captured events via adapter).
func (t *JSONLTailer) Pause() { t.paused.Store(true) }

// Resume re-enables line forwarding after a Pause.
func (t *JSONLTailer) Resume() { t.paused.Store(false) }

// IsPaused reports whether the tailer is currently paused.
func (t *JSONLTailer) IsPaused() bool { return t.paused.Load() }

func (t *JSONLTailer) StableEventIDs() bool { return t.stableEventIDs }

// SetPendingCmd records the slash command from a user message so the parser
// can attach it (e.g. "/compact") to the next command_receipt event.
func (t *JSONLTailer) SetPendingCmd(content string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.parser != nil {
		t.parser.SetPendingCmd(content)
	}
}

// NewJSONLTailer creates a tailer for the given JSONL file path.
// It starts from the end of the file (no historical replay). agentType selects
// the JSONL schema parser ("claude-code" / "codex").
func NewJSONLTailer(filePath, agentType string) (*JSONLTailer, error) {
	info, err := os.Stat(filePath)
	if err != nil {
		return nil, fmt.Errorf("stat jsonl file: %w", err)
	}
	f, err := os.Open(filePath)
	if err != nil {
		return nil, fmt.Errorf("open jsonl file: %w", err)
	}
	return &JSONLTailer{
		filePath: filePath,
		offset:   info.Size(), // Start from end
		file:     f,
		scanBuf:  make([]byte, 1024*1024),
		parser:   adapter.NewJSONLParser(agentType),
	}, nil
}

// NewJSONLTailerFromStart creates a tailer that reads from the beginning.
// agentType selects the JSONL schema parser ("claude-code" / "codex").
func NewJSONLTailerFromStart(filePath, agentType string) (*JSONLTailer, error) {
	return newJSONLTailerFromStart(filePath, agentType, false)
}

// NewClaudeJSONLTailerFromStart enables the Claude-only loss-aware reader and
// deterministic record identities. Codex callers continue using
// NewJSONLTailerFromStart and retain their existing behavior.
func NewClaudeJSONLTailerFromStart(filePath, sessionID string) (*JSONLTailer, error) {
	tailer, err := newJSONLTailerFromStart(filePath, adapter.AgentClaude, true)
	if err != nil {
		return nil, err
	}
	tailer.claudeV2 = true
	tailer.maxRecordBytes = 8 * 1024 * 1024
	source := sessionID + "|" + filepath.Clean(filePath)
	tailer.eventSourceID = fmt.Sprintf("%x", sha256.Sum256([]byte(source)))[:24]
	return tailer, nil
}

func ClaudeJSONLV2Enabled() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("POCKETCTL_CLAUDE_JSONL_V2"))) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}

// newJSONLTailerFromStart optionally assigns stable record identities. The
// option is intentionally private and used only for Codex child migration;
// ordinary Codex/Claude and Claude child replay keep their legacy hashes.
func newJSONLTailerFromStart(filePath, agentType string, stableEventIDs bool) (*JSONLTailer, error) {
	return newJSONLTailerFromLine(filePath, agentType, stableEventIDs, 0)
}

func newJSONLTailerFromLine(filePath, agentType string, stableEventIDs bool, startLine int64) (*JSONLTailer, error) {
	if _, err := os.Stat(filePath); err != nil {
		return nil, fmt.Errorf("stat jsonl file: %w", err)
	}
	f, err := os.Open(filePath)
	if err != nil {
		return nil, fmt.Errorf("open jsonl file: %w", err)
	}
	offset, lineIndex, err := seekJSONLLine(f, startLine)
	if err != nil {
		f.Close()
		return nil, fmt.Errorf("seek jsonl replay cursor: %w", err)
	}
	return &JSONLTailer{
		filePath:       filePath,
		offset:         offset,
		file:           f,
		scanBuf:        make([]byte, 1024*1024),
		parser:         adapter.NewJSONLParser(agentType),
		stableEventIDs: stableEventIDs,
		eventSourceID:  CodexReplaySourceID(filePath),
		lineIndex:      lineIndex,
	}, nil
}

func seekJSONLLine(f *os.File, startLine int64) (int64, int64, error) {
	if startLine <= 0 {
		return 0, 0, nil
	}
	reader := bufio.NewReader(f)
	var offset int64
	var line int64
	for line < startLine {
		record, err := reader.ReadBytes('\n')
		offset += int64(len(record))
		if err == io.EOF {
			return offset, line, nil
		}
		if err != nil {
			return 0, 0, err
		}
		line++
	}
	return offset, line, nil
}

// Close releases the file handle.
func (t *JSONLTailer) Close() {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.file != nil {
		t.file.Close()
		t.file = nil
	}
}

// reopenFile reopens the file handle. Must be called with mu held.
func (t *JSONLTailer) reopenFile() error {
	if t.file != nil {
		t.file.Close()
	}
	f, err := os.Open(t.filePath)
	if err != nil {
		return err
	}
	t.file = f
	return nil
}

// TailNewLines reads any new lines appended since last call.
// Returns parsed DaemonEvents and any new lines (raw) for title extraction.
func (t *JSONLTailer) TailNewLines() ([]protocol.DaemonEvent, []string, error) {
	t.mu.Lock()
	defer t.mu.Unlock()

	// Reopen if file handle was lost (e.g. after error)
	if t.file == nil {
		if err := t.reopenFile(); err != nil {
			return nil, nil, err
		}
	}

	info, err := t.file.Stat()
	if err != nil {
		t.file.Close()
		t.file = nil
		return nil, nil, err
	}

	if t.claudeV2 {
		return t.tailClaudeNewLinesLocked(info)
	}

	if info.Size() <= t.offset {
		return nil, nil, nil // No new data
	}

	// File was truncated (rotated) — reset to beginning
	if info.Size() < t.offset {
		t.offset = 0
		t.lineIndex = 0
	}

	if _, err := t.file.Seek(t.offset, 0); err != nil {
		return nil, nil, err
	}

	var allEvents []protocol.DaemonEvent
	var rawLines []string
	// Reuse the pre-allocated 1MB buffer instead of allocating a new one each call
	scanner := bufio.NewScanner(t.file)
	scanner.Buffer(t.scanBuf, cap(t.scanBuf))
	replaying := t.replayUntil > 0 && t.offset < t.replayUntil

	for scanner.Scan() {
		line := scanner.Text()
		rawLines = append(rawLines, line)
		if !t.notBefore.IsZero() && codexRecordBefore(line, t.notBefore) {
			t.lineIndex++
			continue
		}

		events, err := t.parser.Parse(line)
		if err != nil {
			t.lineIndex++
			continue // Skip unparseable lines
		}
		if t.stableEventIDs {
			for i := range events {
				if events[i].EventID == "" {
					events[i].EventID = fmt.Sprintf("jsonl:%s:%d:%d", t.eventSourceID, t.lineIndex, i)
				}
				if replaying {
					events[i].Resync = true
				}
			}
		}
		allEvents = append(allEvents, events...)
		t.lineIndex++
	}

	// Update offset to current file position
	newOffset, _ := t.file.Seek(0, 1)
	t.offset = newOffset

	return allEvents, rawLines, nil
}

func codexRecordBefore(line string, cutoff time.Time) bool {
	var envelope struct {
		Timestamp string `json:"timestamp"`
	}
	if json.Unmarshal([]byte(line), &envelope) != nil || envelope.Timestamp == "" {
		return false
	}
	recordedAt, err := time.Parse(time.RFC3339Nano, envelope.Timestamp)
	return err == nil && recordedAt.Before(cutoff)
}

func (t *JSONLTailer) tailClaudeNewLinesLocked(info os.FileInfo) ([]protocol.DaemonEvent, []string, error) {
	pathInfo, err := os.Stat(t.filePath)
	if err != nil {
		return nil, nil, err
	}
	if !os.SameFile(info, pathInfo) {
		if err := t.reopenFile(); err != nil {
			return nil, nil, err
		}
		info = pathInfo
		t.offset = 0
		t.lineIndex = 0
	}
	if info.Size() < t.offset {
		t.offset = 0
		t.lineIndex = 0
	}
	if info.Size() == t.offset {
		return nil, nil, nil
	}
	if _, err := t.file.Seek(t.offset, io.SeekStart); err != nil {
		return nil, nil, err
	}

	reader := bufio.NewReaderSize(t.file, 64*1024)
	recordStart := t.offset
	var allEvents []protocol.DaemonEvent
	var rawLines []string
	for {
		var record []byte
		var consumed int64
		oversized := false
		complete := false
		for {
			fragment, readErr := reader.ReadSlice('\n')
			consumed += int64(len(fragment))
			if !oversized {
				if len(record)+len(fragment) > t.maxRecordBytes {
					oversized = true
					record = nil
				} else {
					record = append(record, fragment...)
				}
			}
			switch readErr {
			case nil:
				complete = true
			case bufio.ErrBufferFull:
				continue
			case io.EOF:
				// Do not commit a partial final record. The next poll seeks back
				// to recordStart and parses it after the writer adds '\n'.
				return allEvents, rawLines, nil
			default:
				return allEvents, rawLines, readErr
			}
			break
		}
		if !complete {
			return allEvents, rawLines, nil
		}

		t.offset = recordStart + consumed
		t.lineIndex++
		if oversized {
			allEvents = append(allEvents, protocol.DaemonEvent{
				Type:   "sync_warning",
				Reason: "jsonl_record_too_large",
			})
			recordStart = t.offset
			continue
		}

		line := strings.TrimSuffix(string(record), "\n")
		line = strings.TrimSuffix(line, "\r")
		rawLines = append(rawLines, line)
		events, parseErr := t.parser.Parse(line)
		if parseErr != nil {
			allEvents = append(allEvents, protocol.DaemonEvent{
				Type:   "sync_warning",
				Reason: "jsonl_parse_error",
			})
			recordStart = t.offset
			continue
		}
		recordHash := sha256.Sum256(record)
		for i := range events {
			if events[i].EventID == "" {
				identity := fmt.Sprintf("%s|%d|%x|%d", t.eventSourceID, recordStart, recordHash, i)
				eventHash := sha256.Sum256([]byte(identity))
				events[i].EventID = fmt.Sprintf("claude-jsonl:v1:%x", eventHash[:16])
			}
		}
		allEvents = append(allEvents, events...)
		recordStart = t.offset
		if t.offset >= info.Size() {
			return allEvents, rawLines, nil
		}
	}
}

// Run starts a periodic tail loop, sending events to outputCh.
// It also checks for the first user message to generate a title.
// Closes the file handle on exit.
func (t *JSONLTailer) Run(ctx context.Context, outputCh chan<- protocol.DaemonEvent, titleCb func(title string)) {
	defer t.Close()

	ticker := time.NewTicker(1 * time.Second)
	defer ticker.Stop()

	titleSent := false

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			events, rawLines, err := t.TailNewLines()
			if err != nil {
				continue
			}

			// Send events. Stamp sessionID from the file name if the record didn't
			// carry one (e.g. sidechain turn_duration records emitted at turn end).
			sid := strings.TrimSuffix(filepath.Base(t.filePath), ".jsonl")
			for _, evt := range events {
				if evt.SessionID == "" {
					evt.SessionID = sid
				}
				protocol.FinalizeAgentPlanEvent(&evt)
				outputCh <- evt
			}

			// Check for title from first user message
			if !titleSent && titleCb != nil && len(rawLines) > 0 {
				title := adapter.ExtractFirstUserMessage(rawLines, 60)
				if title != "" {
					titleCb(title)
					titleSent = true
				}
			}
		}
	}
}

// ResolveJSONLPath returns the JSONL file path for a given session and cwd.
// Claude Code stores sessions at ~/.claude/projects/<encoded-path>/<session-id>.jsonl
func ResolveJSONLPath(sessionID string, cwd string) (string, error) {
	home, err := config.HomeDir()
	if err != nil {
		return "", err
	}

	// Encode cwd: replace / with -
	encoded := "-" + strings.ReplaceAll(strings.TrimPrefix(cwd, "/"), "/", "-")
	dir := filepath.Join(home, ".claude", "projects", encoded)
	filePath := filepath.Join(dir, sessionID+".jsonl")

	if _, err := os.Stat(filePath); err != nil {
		// Try finding the file by searching for session ID across all project dirs
		return findJSONLBySessionID(home, sessionID)
	}

	return filePath, nil
}

// ExtractTitleFromJSONL reads the beginning of a JSONL file to extract a title
// from the first user message. Returns "Terminal Session" if no user message found.
func ExtractTitleFromJSONL(filePath string) string {
	f, err := os.Open(filePath)
	if err != nil {
		return "Terminal Session"
	}
	defer f.Close()

	var lines []string
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 1024*1024), 1024*1024)
	// Read up to 500 lines looking for the first user message
	for i := 0; i < 500 && scanner.Scan(); i++ {
		lines = append(lines, scanner.Text())
	}

	title := adapter.ExtractFirstUserMessage(lines, 60)
	if title == "" {
		return "Terminal Session"
	}
	return title
}

func findJSONLBySessionID(home string, sessionID string) (string, error) {
	projectsDir := filepath.Join(home, ".claude", "projects")
	entries, err := os.ReadDir(projectsDir)
	if err != nil {
		return "", fmt.Errorf("read projects dir: %w", err)
	}

	target := sessionID + ".jsonl"
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		candidate := filepath.Join(projectsDir, entry.Name(), target)
		if _, err := os.Stat(candidate); err == nil {
			return candidate, nil
		}
	}

	return "", fmt.Errorf("jsonl file not found for session %s", sessionID)
}

// SubAgentTailer wraps a JSONLTailer for a sub-agent, stamping events with AgentID.
type SubAgentTailer struct {
	tailer          *JSONLTailer
	agentID         string
	parentSessionID string
	agentType       string
	dropChildStatus bool
	titleSent       bool // first user_text triggers title generation once
}

// NewSubAgentTailer creates a tailer for a sub-agent JSONL file that reads from the start.
func NewSubAgentTailer(filePath string, agentID string, parentSessionID string, agentType string) (*SubAgentTailer, error) {
	return NewSubAgentTailerForAgent(filePath, agentID, parentSessionID, agentType, adapter.AgentClaude)
}

// NewSubAgentTailerForAgent creates a relationship-aware child tailer using
// the requested JSONL parser while preserving the shared subagent protocol.
func NewSubAgentTailerForAgent(filePath string, agentID string, parentSessionID string, agentType string, parserAgent string) (*SubAgentTailer, error) {
	tailer, err := newJSONLTailerFromStart(filePath, parserAgent, parserAgent == adapter.AgentCodex)
	if err != nil {
		return nil, fmt.Errorf("create sub-agent tailer: %w", err)
	}
	return &SubAgentTailer{
		tailer: tailer, agentID: agentID, parentSessionID: parentSessionID,
		agentType: agentType, dropChildStatus: parserAgent == adapter.AgentCodex,
	}, nil
}

// NewCodexReplaySubAgentTailer creates the startup-history reader. It is
// intentionally Codex-only: Claude child replay retains its existing contract.
func NewCodexReplaySubAgentTailer(filePath, agentID, parentSessionID, agentType string, notBefore time.Time, startLine int64) (*SubAgentTailer, error) {
	tailer, err := newJSONLTailerFromLine(filePath, adapter.AgentCodex, true, startLine)
	if err != nil {
		return nil, fmt.Errorf("create Codex replay tailer: %w", err)
	}
	info, err := os.Stat(filePath)
	if err != nil {
		tailer.Close()
		return nil, fmt.Errorf("stat Codex replay file: %w", err)
	}
	tailer.notBefore = notBefore
	tailer.replayUntil = info.Size()
	return &SubAgentTailer{
		tailer: tailer, agentID: agentID, parentSessionID: parentSessionID,
		agentType: agentType, dropChildStatus: true,
	}, nil
}

// TailNewLines reads new lines and stamps each event with the sub-agent's AgentID.
func (t *SubAgentTailer) TailNewLines() ([]protocol.DaemonEvent, error) {
	events, _, err := t.tailer.TailNewLines()
	if err != nil {
		return nil, err
	}
	stamped := events[:0]
	for i := range events {
		// Codex task_complete describes the child turn, not the root session.
		// Forwarding it as session_status would incorrectly complete the parent.
		if t.dropChildStatus && events[i].Type == "session_status" {
			continue
		}
		// A child rollout has no independent client Plan surface in phase one.
		// Never stamp its snapshot with the parent session id.
		if events[i].Type == "agent_plan" {
			continue
		}
		events[i].SessionID = t.parentSessionID
		events[i].ParentSessionID = t.parentSessionID
		events[i].RootSessionID = t.parentSessionID
		events[i].AgentID = t.agentID
		events[i].IsSubagent = true
		stamped = append(stamped, events[i])
	}
	return stamped, nil
}

// Run starts a periodic tail loop for a sub-agent, sending stamped events to outputCh.
// For events carrying Usage, an additional subagent_usage event is emitted so the
// relay can accumulate the sub-agent's token columns.
// On the first user_text event, a generate_subagent_title_request is emitted once.
// Closes the inner tailer on exit.
func (t *SubAgentTailer) Run(ctx context.Context, outputCh chan<- protocol.DaemonEvent) {
	defer t.tailer.Close()

	ticker := time.NewTicker(1 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			events, err := t.TailNewLines()
			if err != nil {
				continue
			}
			for _, evt := range events {
				outputCh <- evt // original event (already stamped with AgentID)
				// Sub-agent output with usage: emit extra subagent_usage for relay token accumulation.
				if evt.Usage != nil && evt.AgentID != "" {
					usageEventID := ""
					if evt.EventID != "" {
						usageEventID = evt.EventID + ":usage"
					}
					outputCh <- protocol.DaemonEvent{
						Type:            "subagent_usage",
						EventID:         usageEventID,
						Resync:          evt.Resync,
						SessionID:       t.parentSessionID,
						AgentID:         evt.AgentID,
						ParentSessionID: t.parentSessionID,
						RootSessionID:   t.parentSessionID,
						IsSubagent:      true,
						Usage:           evt.Usage,
					}
				}
				// First user_text → generate_subagent_title_request (once).
				if !t.titleSent && evt.Type == "user_text" && evt.Text != "" {
					t.titleSent = true
					titleEventID := ""
					if evt.EventID != "" {
						titleEventID = evt.EventID + ":title"
					}
					outputCh <- protocol.DaemonEvent{
						Type:            "generate_subagent_title_request",
						EventID:         titleEventID,
						Resync:          evt.Resync,
						SessionID:       t.parentSessionID,
						AgentID:         t.agentID,
						ParentSessionID: t.parentSessionID,
						RootSessionID:   t.parentSessionID,
						IsSubagent:      true,
						SubAgentType:    t.agentType,
						UserMessage:     evt.Text,
					}
				}
			}
		}
	}
}

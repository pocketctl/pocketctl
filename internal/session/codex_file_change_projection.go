package session

import (
	"encoding/json"
	"path"
	"strconv"
	"strings"

	"github.com/pocketctl/pocketctl/internal/config"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

const (
	maxManagedTurnDiffBytes = 4 << 20
	maxManagedTurnDiffFiles = 256
)

type codexFileChangeKind struct {
	Type     string
	MovePath string
}

// UnmarshalJSON accepts the current app-server tagged union while retaining
// the legacy string shape used by older Codex versions. Unknown shapes are
// kept non-fatal so the existing legacy fileChange result is never discarded
// merely because the additive structured projector cannot classify a kind.
func (k *codexFileChangeKind) UnmarshalJSON(raw []byte) error {
	*k = codexFileChangeKind{}
	var legacy string
	if json.Unmarshal(raw, &legacy) == nil {
		k.Type = legacy
		return nil
	}
	var tagged struct {
		Type     string  `json:"type"`
		MovePath *string `json:"move_path"`
	}
	if json.Unmarshal(raw, &tagged) == nil {
		k.Type = tagged.Type
		if tagged.MovePath != nil {
			k.MovePath = *tagged.MovePath
		}
	}
	return nil
}

type projectedManagedFileChange struct {
	path      string
	kind      string
	movePath  string
	diff      string
	additions int
	deletions int
}

func (p *codexProjection) projectTurnDiff(raw json.RawMessage, historical bool) []protocol.DaemonEvent {
	if historical || !config.CodexEditedFilesEnabled() {
		return nil
	}
	var params struct {
		ThreadID string `json:"threadId"`
		TurnID   string `json:"turnId"`
		Diff     string `json:"diff"`
	}
	if json.Unmarshal(raw, &params) != nil || strings.TrimSpace(params.ThreadID) == "" ||
		strings.TrimSpace(params.TurnID) == "" {
		return nil
	}
	turnKey := managedTurnDiffKey(params.ThreadID, params.TurnID)
	if params.Diff == "" {
		delete(p.turnDiff, turnKey)
		return nil
	}
	if len(params.Diff) > maxManagedTurnDiffBytes {
		delete(p.turnDiff, turnKey)
		return nil
	}
	if active := p.activeTurn[params.ThreadID]; active != "" && active != params.TurnID {
		return nil
	}
	p.turnDiff[turnKey] = params.Diff
	return nil
}

func (p *codexProjection) projectManagedTurnDiff(threadID, turnID string) []protocol.DaemonEvent {
	if !config.CodexEditedFilesEnabled() {
		return nil
	}
	diff := p.turnDiff[managedTurnDiffKey(threadID, turnID)]
	changes := parseManagedTurnDiff(diff)
	if len(changes) == 0 {
		return nil
	}
	alreadyEmitted := p.fileChangePath[managedTurnDiffKey(threadID, turnID)]
	filtered := changes[:0]
	for _, change := range changes {
		candidatePath := change.path
		if change.kind == protocol.FileChangeMove {
			candidatePath = change.movePath
		}
		if _, duplicate := alreadyEmitted[candidatePath]; duplicate {
			continue
		}
		filtered = append(filtered, change)
	}
	changes = filtered
	if len(changes) == 0 {
		return nil
	}

	changeSetID := "managed-turn-diff:" + turnID
	callID := "turn-diff:" + turnID
	events := make([]protocol.DaemonEvent, 0, len(changes))
	for index, change := range changes {
		event := protocol.DaemonEvent{
			Type: "agent_file_change", SessionID: threadID,
			TurnID:      logicalCodexTurnID(threadID, turnID),
			ChangeSetID: changeSetID, CallID: callID,
			ChangeIndex: index, ChangeTotal: len(changes),
			Path: change.path, ChangeKind: change.kind, MovePath: change.movePath,
			Diff: change.diff, Additions: change.additions, Deletions: change.deletions,
			Status: "completed",
			EventID: p.key(
				"turn-diff-file-change", threadID, turnID, change.path,
				change.movePath, digest([]byte(change.diff)),
			),
		}
		stampTurnIdentity(&event, threadID, turnID, "")
		events = append(events, event)
	}
	return events
}

func parseManagedTurnDiff(diff string) []projectedManagedFileChange {
	if diff == "" || len(diff) > maxManagedTurnDiffBytes {
		return nil
	}
	var segments []string
	var current strings.Builder
	for _, line := range strings.SplitAfter(diff, "\n") {
		if strings.HasPrefix(line, "diff --git ") {
			if current.Len() > 0 {
				segments = append(segments, current.String())
				current.Reset()
			}
		}
		if current.Len() == 0 && !strings.HasPrefix(line, "diff --git ") {
			if strings.TrimSpace(line) != "" {
				return nil
			}
			continue
		}
		current.WriteString(line)
	}
	if current.Len() > 0 {
		segments = append(segments, current.String())
	}
	if len(segments) == 0 || len(segments) > maxManagedTurnDiffFiles {
		return nil
	}

	changes := make([]projectedManagedFileChange, 0, len(segments))
	for _, segment := range segments {
		change, ok := parseManagedTurnDiffSegment(segment)
		if ok {
			changes = append(changes, change)
		}
	}
	return changes
}

func parseManagedTurnDiffSegment(segment string) (projectedManagedFileChange, bool) {
	var oldHeader, newHeader string
	lines := strings.Split(segment, "\n")
	for index, line := range lines {
		line = strings.TrimSuffix(line, "\r")
		if strings.HasPrefix(line, "@@ ") {
			break
		}
		if strings.HasPrefix(line, "--- ") {
			if index+1 >= len(lines) {
				return projectedManagedFileChange{}, false
			}
			next := strings.TrimSuffix(lines[index+1], "\r")
			if !strings.HasPrefix(next, "+++ ") {
				return projectedManagedFileChange{}, false
			}
			oldHeader = strings.TrimPrefix(line, "--- ")
			newHeader = strings.TrimPrefix(next, "+++ ")
			break
		}
	}
	if oldHeader == "" || newHeader == "" {
		return projectedManagedFileChange{}, false
	}
	oldPath, oldNull, oldOK := managedDiffHeaderPath(oldHeader, "a/")
	newPath, newNull, newOK := managedDiffHeaderPath(newHeader, "b/")
	if !oldOK || !newOK || (oldNull && newNull) {
		return projectedManagedFileChange{}, false
	}

	change := projectedManagedFileChange{diff: segment}
	switch {
	case oldNull:
		change.path, change.kind = newPath, protocol.FileChangeCreate
	case newNull:
		change.path, change.kind = oldPath, protocol.FileChangeDelete
	case oldPath != newPath:
		change.path, change.movePath, change.kind = oldPath, newPath, protocol.FileChangeMove
	default:
		change.path, change.kind = newPath, protocol.FileChangeUpdate
	}
	change.additions, change.deletions = protocol.CountUnifiedDiffChanges(segment)
	return change, true
}

func managedDiffHeaderPath(value, prefix string) (relative string, isNull, ok bool) {
	if value == "/dev/null" {
		return "", true, true
	}
	if strings.ContainsRune(value, '\t') || strings.HasPrefix(value, `"`) ||
		!strings.HasPrefix(value, prefix) {
		return "", false, false
	}
	relative, ok = normalizeManagedDiffPath(strings.TrimPrefix(value, prefix))
	return relative, false, ok
}

func normalizeManagedDiffPath(value string) (string, bool) {
	if value == "" || len(value) > 4096 || strings.ContainsRune(value, '\x00') ||
		value != strings.TrimSpace(value) {
		return "", false
	}
	value = strings.ReplaceAll(value, `\`, "/")
	if strings.HasPrefix(value, "/") || strings.HasPrefix(value, "//") ||
		(len(value) >= 2 && value[1] == ':' && ((value[0] >= 'A' && value[0] <= 'Z') ||
			(value[0] >= 'a' && value[0] <= 'z'))) {
		return "", false
	}
	normalized := path.Clean(value)
	if normalized == "." || normalized == ".." || strings.HasPrefix(normalized, "../") {
		return "", false
	}
	return normalized, true
}

func (p *codexProjection) rememberManagedFileChangePaths(threadID, turnID string, events []protocol.DaemonEvent) {
	if len(events) == 0 {
		return
	}
	turnKey := managedTurnDiffKey(threadID, turnID)
	paths := p.fileChangePath[turnKey]
	if paths == nil {
		paths = make(map[string]struct{})
		p.fileChangePath[turnKey] = paths
	}
	for _, event := range events {
		if event.Type != "agent_file_change" {
			continue
		}
		if normalized, ok := normalizeManagedDiffPath(event.Path); ok {
			paths[normalized] = struct{}{}
		}
		if normalized, ok := normalizeManagedDiffPath(event.MovePath); ok {
			paths[normalized] = struct{}{}
		}
	}
}

func (p *codexProjection) clearManagedTurnDiff(threadID, turnID string) {
	turnKey := managedTurnDiffKey(threadID, turnID)
	delete(p.turnDiff, turnKey)
	delete(p.fileChangePath, turnKey)
}

func managedTurnDiffKey(threadID, turnID string) string {
	return threadID + "\x00" + turnID
}

func managedTurnCompletedSuccessfully(status string) bool {
	status = strings.ToLower(strings.TrimSpace(status))
	return status == "" || status == "completed"
}

func (p *codexProjection) projectManagedFileChanges(
	threadID, turnID string,
	item codexThreadItem,
) []protocol.DaemonEvent {
	if !config.CodexEditedFilesEnabled() || strings.TrimSpace(threadID) == "" ||
		strings.TrimSpace(turnID) == "" || strings.TrimSpace(item.ID) == "" ||
		!managedFileChangeStatusCompleted(item.Status) {
		return nil
	}

	changes := make([]projectedManagedFileChange, 0, len(item.Changes))
	for _, source := range item.Changes {
		if strings.TrimSpace(source.Path) == "" {
			continue
		}
		movePath := source.Kind.MovePath
		if movePath == "" {
			movePath = source.MovePath
		}
		kind, ok := normalizeManagedFileChangeKind(source.Kind.Type, movePath)
		if !ok {
			continue
		}
		diff := normalizeManagedFileChangeDiff(source.Path, kind, source.Diff)
		additions, deletions := protocol.CountUnifiedDiffChanges(diff)
		changes = append(changes, projectedManagedFileChange{
			path: source.Path, kind: kind, movePath: movePath, diff: diff,
			additions: additions, deletions: deletions,
		})
	}
	if len(changes) == 0 {
		return nil
	}

	changeSetID := "managed:" + item.ID
	events := make([]protocol.DaemonEvent, 0, len(changes))
	for index, change := range changes {
		fileChangeEvent := protocol.DaemonEvent{
			Type: "agent_file_change", SessionID: threadID,
			// Logical id is the single cross-wire turn identity; the native id
			// rides on source_turn_id (plan stage 3: one turn id contract).
			TurnID:      logicalCodexTurnID(threadID, turnID),
			ChangeSetID: changeSetID, CallID: item.ID,
			ChangeIndex: index, ChangeTotal: len(changes),
			Path: change.path, ChangeKind: change.kind, MovePath: change.movePath,
			Diff: change.diff, Additions: change.additions, Deletions: change.deletions,
			Status: item.Status,
			EventID: p.key(
				"file-change", threadID, turnID, item.ID, strconv.Itoa(index),
				change.path, digest([]byte(change.diff)),
			),
		}
		stampTurnIdentity(&fileChangeEvent, threadID, turnID, "")
		events = append(events, fileChangeEvent)
	}
	return events
}

func normalizeManagedFileChangeDiff(path, kind, diff string) string {
	if kind != protocol.FileChangeCreate && kind != protocol.FileChangeDelete {
		return diff
	}
	return managedWholeFileDiff(path, kind, diff)
}

func managedWholeFileDiff(path, kind, content string) string {
	lines := strings.Split(content, "\n")
	endsWithNewline := strings.HasSuffix(content, "\n")
	if endsWithNewline {
		lines = lines[:len(lines)-1]
	}
	if content == "" {
		lines = nil
	}

	var diff strings.Builder
	linePrefix := byte('+')
	if kind == protocol.FileChangeCreate {
		diff.WriteString("--- /dev/null\n+++ b/")
		diff.WriteString(path)
		diff.WriteByte('\n')
		if len(lines) > 0 {
			diff.WriteString("@@ -0,0 +")
			diff.WriteString(managedUnifiedRange(1, len(lines)))
			diff.WriteString(" @@\n")
		}
	} else {
		linePrefix = '-'
		diff.WriteString("--- a/")
		diff.WriteString(path)
		diff.WriteString("\n+++ /dev/null\n")
		if len(lines) > 0 {
			diff.WriteString("@@ -")
			diff.WriteString(managedUnifiedRange(1, len(lines)))
			diff.WriteString(" +0,0 @@\n")
		}
	}
	for _, line := range lines {
		diff.WriteByte(linePrefix)
		diff.WriteString(line)
		diff.WriteByte('\n')
	}
	if len(lines) > 0 && !endsWithNewline {
		diff.WriteString("\\ No newline at end of file\n")
	}
	return diff.String()
}

func managedUnifiedRange(start, count int) string {
	if count == 1 {
		return strconv.Itoa(start)
	}
	return strconv.Itoa(start) + "," + strconv.Itoa(count)
}

func normalizeManagedFileChangeKind(kind, movePath string) (string, bool) {
	if strings.TrimSpace(movePath) != "" {
		return protocol.FileChangeMove, true
	}
	switch strings.ToLower(strings.TrimSpace(kind)) {
	case "add", protocol.FileChangeCreate:
		kind = protocol.FileChangeCreate
	case protocol.FileChangeUpdate, "modify":
		kind = protocol.FileChangeUpdate
	case protocol.FileChangeDelete, "remove":
		kind = protocol.FileChangeDelete
	case protocol.FileChangeMove, "rename":
		kind = protocol.FileChangeMove
	default:
		return "", false
	}
	return kind, protocol.ValidFileChangeKind(kind)
}

func managedFileChangeStatusCompleted(status string) bool {
	return strings.EqualFold(strings.TrimSpace(status), "completed")
}

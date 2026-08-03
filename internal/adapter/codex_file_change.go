package adapter

import (
	"crypto/sha256"
	"encoding/hex"
	"sort"
	"strconv"
	"strings"

	"github.com/pocketctl/pocketctl/internal/config"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

type codexPatchChange struct {
	Type        string  `json:"type,omitempty"`
	UnifiedDiff *string `json:"unified_diff,omitempty"`
	Content     *string `json:"content,omitempty"`
	MovePath    string  `json:"move_path,omitempty"`
}

type projectedCodexPatchChange struct {
	path      string
	kind      string
	movePath  string
	diff      string
	additions int
	deletions int
}

func projectCodexPatchApplyEnd(p codexPayload) []protocol.DaemonEvent {
	if !config.CodexEditedFilesEnabled() || !p.Success ||
		strings.TrimSpace(p.TurnID) == "" || strings.TrimSpace(p.CallID) == "" ||
		!codexPatchStatusCompleted(p.Status) || len(p.Changes) == 0 {
		return nil
	}

	paths := make([]string, 0, len(p.Changes))
	for path := range p.Changes {
		paths = append(paths, path)
	}
	sort.Strings(paths)

	changes := make([]projectedCodexPatchChange, 0, len(paths))
	for _, path := range paths {
		if strings.TrimSpace(path) == "" {
			continue
		}
		source := p.Changes[path]
		kind, ok := normalizeCodexFileChangeKind(source.Type, source.MovePath)
		if !ok {
			continue
		}
		diff, ok := codexPatchChangeDiff(path, kind, source)
		if !ok {
			continue
		}
		additions, deletions := protocol.CountUnifiedDiffChanges(diff)
		changes = append(changes, projectedCodexPatchChange{
			path: path, kind: kind, movePath: source.MovePath, diff: diff,
			additions: additions, deletions: deletions,
		})
	}
	if len(changes) == 0 {
		return nil
	}

	changeSetID := "native:" + p.CallID
	events := make([]protocol.DaemonEvent, 0, len(changes))
	for index, change := range changes {
		events = append(events, protocol.DaemonEvent{
			Type: "agent_file_change", TurnID: p.TurnID, ChangeSetID: changeSetID,
			CallID: p.CallID, ChangeIndex: index, ChangeTotal: len(changes),
			Path: change.path, ChangeKind: change.kind, MovePath: change.movePath,
			Diff: change.diff, Additions: change.additions, Deletions: change.deletions,
			Status: p.Status,
			EventID: codexFileChangeEventID(
				p.TurnID, p.CallID, index, change.path, change.diff,
			),
		})
	}
	return events
}

func codexPatchChangeDiff(path, kind string, source codexPatchChange) (string, bool) {
	if source.UnifiedDiff != nil {
		return *source.UnifiedDiff, true
	}
	if source.Content == nil {
		return "", false
	}
	switch kind {
	case protocol.FileChangeCreate, protocol.FileChangeDelete:
		return codexWholeFileDiff(path, kind, *source.Content), true
	default:
		return "", false
	}
}

func codexWholeFileDiff(path, kind, content string) string {
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
			diff.WriteString(codexUnifiedRange(1, len(lines)))
			diff.WriteString(" @@\n")
		}
	} else {
		linePrefix = '-'
		diff.WriteString("--- a/")
		diff.WriteString(path)
		diff.WriteString("\n+++ /dev/null\n")
		if len(lines) > 0 {
			diff.WriteString("@@ -")
			diff.WriteString(codexUnifiedRange(1, len(lines)))
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

func codexUnifiedRange(start, count int) string {
	if count == 1 {
		return strconv.Itoa(start)
	}
	return strconv.Itoa(start) + "," + strconv.Itoa(count)
}

func normalizeCodexFileChangeKind(kind, movePath string) (string, bool) {
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

func codexPatchStatusCompleted(status string) bool {
	return strings.EqualFold(strings.TrimSpace(status), "completed")
}

func codexFileChangeEventID(turnID, callID string, index int, path, diff string) string {
	diffDigest := codexFileChangeDigest(diff)
	identity := strings.Join([]string{turnID, callID, strconv.Itoa(index), path, diffDigest}, "\x00")
	return "codex:file-change:" + codexFileChangeDigest(identity)
}

func codexFileChangeDigest(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:8])
}

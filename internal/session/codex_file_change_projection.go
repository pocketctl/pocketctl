package session

import (
	"encoding/json"
	"strconv"
	"strings"

	"github.com/pocketctl/pocketctl/internal/config"
	"github.com/pocketctl/pocketctl/internal/protocol"
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
		events = append(events, protocol.DaemonEvent{
			Type: "agent_file_change", SessionID: threadID, TurnID: turnID,
			ChangeSetID: changeSetID, CallID: item.ID,
			ChangeIndex: index, ChangeTotal: len(changes),
			Path: change.path, ChangeKind: change.kind, MovePath: change.movePath,
			Diff: change.diff, Additions: change.additions, Deletions: change.deletions,
			Status: item.Status,
			EventID: p.key(
				"file-change", threadID, turnID, item.ID, strconv.Itoa(index),
				change.path, digest([]byte(change.diff)),
			),
		})
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

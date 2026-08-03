package protocol

import "strings"

const (
	FileChangeCreate = "create"
	FileChangeUpdate = "update"
	FileChangeDelete = "delete"
	FileChangeMove   = "move"
)

// ValidFileChangeKind reports whether kind is part of the stable
// agent_file_change wire contract.
func ValidFileChangeKind(kind string) bool {
	switch kind {
	case FileChangeCreate, FileChangeUpdate, FileChangeDelete, FileChangeMove:
		return true
	default:
		return false
	}
}

// CountUnifiedDiffChanges counts changed body lines while excluding unified
// diff file headers. It reports patch activity, not a final net file delta.
func CountUnifiedDiffChanges(diff string) (additions, deletions int) {
	for _, line := range strings.Split(diff, "\n") {
		line = strings.TrimSuffix(line, "\r")
		switch {
		case isUnifiedDiffFileHeader(line):
			continue
		case strings.HasPrefix(line, "+"):
			additions++
		case strings.HasPrefix(line, "-"):
			deletions++
		}
	}
	return additions, deletions
}

func isUnifiedDiffFileHeader(line string) bool {
	return strings.HasPrefix(line, "+++ ") || strings.HasPrefix(line, "+++\t") ||
		strings.HasPrefix(line, "--- ") || strings.HasPrefix(line, "---\t")
}

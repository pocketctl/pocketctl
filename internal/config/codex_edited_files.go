package config

import (
	"os"
	"strings"
)

// CodexEditedFilesEnabled reports whether Codex file-change projection is
// enabled. The feature defaults on and can be disabled independently from
// existing managed/native capability checks.
func CodexEditedFilesEnabled() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("POCKETCTL_CODEX_EDITED_FILES"))) {
	case "0", "false", "no", "off":
		return false
	default:
		return true
	}
}

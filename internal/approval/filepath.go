package approval

import (
	"encoding/json"
	"path/filepath"
)

// fileTools is the set of Claude tools whose tool_input carries a writable file
// path and that therefore participate in the Scheme C file-lock check.
var fileTools = map[string]string{
	"Edit":        "file_path",
	"Write":       "file_path",
	"MultiEdit":   "file_path",
	"NotebookEdit": "notebook_path",
}

// extractFilePath pulls the target file path out of a PreToolUse tool_input
// for the given tool. Returns ("", false) for tools that don't write files
// (Read/Bash/Grep/etc.) or when the field is missing.
func extractFilePath(tool string, input json.RawMessage) (string, bool) {
	field, ok := fileTools[tool]
	if !ok {
		return "", false
	}
	var obj map[string]any
	if err := json.Unmarshal(input, &obj); err != nil {
		return "", false
	}
	raw, ok := obj[field]
	if !ok {
		return "", false
	}
	s, ok := raw.(string)
	if !ok || s == "" {
		return "", false
	}
	return s, true
}

// normalizePath resolves p (which may be relative) against cwd into a
// canonical absolute key. Symlinks are resolved when possible; on any error we
// fall back to filepath.Clean so the key is at least stable.
func normalizePath(cwd, p string) string {
	if !filepath.IsAbs(p) && cwd != "" {
		p = filepath.Join(cwd, p)
	}
	if abs, err := filepath.Abs(p); err == nil {
		if resolved, err := filepath.EvalSymlinks(abs); err == nil {
			return resolved
		}
		return filepath.Clean(abs)
	}
	return filepath.Clean(p)
}

package approval

import (
	"encoding/json"
	"path/filepath"
	"testing"
)

func TestExtractFilePath(t *testing.T) {
	cases := []struct {
		name    string
		tool    string
		input   string
		want    string
		wantOk  bool
	}{
		{"Edit", "Edit", `{"file_path":"/repo/main.go"}`, "/repo/main.go", true},
		{"Write", "Write", `{"file_path":"/repo/new.go"}`, "/repo/new.go", true},
		{"MultiEdit", "MultiEdit", `{"file_path":"/repo/edit.go"}`, "/repo/edit.go", true},
		{"NotebookEdit", "NotebookEdit", `{"notebook_path":"/repo/nb.ipynb"}`, "/repo/nb.ipynb", true},
		{"Read skipped", "Read", `{"file_path":"/repo/main.go"}`, "", false},
		{"Bash skipped", "Bash", `{"command":"echo hi"}`, "", false},
		{"missing field", "Edit", `{"content":"hi"}`, "", false},
		{"empty path", "Edit", `{"file_path":""}`, "", false},
		{"malformed json", "Edit", `{not json}`, "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := extractFilePath(tc.tool, json.RawMessage(tc.input))
			if ok != tc.wantOk || got != tc.want {
				t.Errorf("extractFilePath(%q, %q) = (%q, %v), want (%q, %v)",
					tc.tool, tc.input, got, ok, tc.want, tc.wantOk)
			}
		})
	}
}

func TestNormalizePath(t *testing.T) {
	// Relative path resolved against cwd.
	got := normalizePath("/repo", "src/main.go")
	want := filepath.Clean("/repo/src/main.go")
	if got != want {
		t.Errorf("normalizePath relative: got %q, want %q", got, want)
	}

	// Absolute path stays absolute (cleaned).
	got = normalizePath("/repo", "/abs/file.go")
	if got != "/abs/file.go" {
		t.Errorf("normalizePath absolute: got %q, want /abs/file.go", got)
	}

	// Empty cwd: relative path becomes absolute against process cwd, so just
	// check it ends with the basename (platform-independent).
	got = normalizePath("", "rel.go")
	if filepath.Base(got) != "rel.go" {
		t.Errorf("normalizePath empty cwd: got %q, want basename rel.go", got)
	}
}

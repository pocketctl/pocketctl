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
	// normalizePath 返回 canonical absolute key(走 filepath.Abs + Clean,
	// EvalSymlinks 失败时 fallback Clean(abs))。期望用同样 Abs 构造,
	// 跨平台一致(Unix /repo 绝对;Windows /repo 当前盘相对 → Abs 加盘符)。
	expect := func(cwd, p string) string {
		if !filepath.IsAbs(p) && cwd != "" {
			p = filepath.Join(cwd, p)
		}
		abs, err := filepath.Abs(p)
		if err != nil {
			return filepath.Clean(p)
		}
		return filepath.Clean(abs)
	}

	got := normalizePath("/repo", "src/main.go")
	if want := expect("/repo", "src/main.go"); got != want {
		t.Errorf("normalizePath relative: got %q, want %q", got, want)
	}

	got = normalizePath("/repo", "/abs/file.go")
	if want := expect("/repo", "/abs/file.go"); got != want {
		t.Errorf("normalizePath absolute: got %q, want %q", got, want)
	}

	// Empty cwd: 相对路径变绝对(进程 cwd),只验 basename(平台无关)
	got = normalizePath("", "rel.go")
	if filepath.Base(got) != "rel.go" {
		t.Errorf("normalizePath empty cwd: got %q, want basename rel.go", got)
	}
}

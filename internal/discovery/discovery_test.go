package discovery

import (
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"testing"
)

func TestCandidatePaths_UserLocalFirstAndDedup(t *testing.T) {
	home := "/home/u"
	// PATH 用平台分隔符(Unix ':' Windows ';'),否则 filepath.SplitList 在 Windows
	// 不切割 → 整个 PATH 当一个目录。
	pathEnv := filepath.Join("/usr", "bin") + string(os.PathListSeparator) + filepath.Join(home, ".local", "bin")
	got := candidatePaths("claude", home, pathEnv, "")

	var want []string
	want = append(want, testExecutablePaths(filepath.Join(home, ".local", "bin"), "claude")...)
	want = append(want, testExecutablePaths(filepath.Join(home, ".claude", "local"), "claude")...)
	want = append(want, testExecutablePaths(filepath.Join(home, ".opencode", "bin"), "claude")...)
	want = append(want, testExecutablePaths(filepath.Join("/usr", "bin"), "claude")...)

	if !reflect.DeepEqual(got, want) {
		t.Fatalf("candidatePaths = %v, want %v", got, want)
	}
}

func TestCandidatePaths_NpmPrefixIncluded(t *testing.T) {
	home := "/home/u"
	got := candidatePaths("codex", home, "/usr/bin", filepath.Join(home, ".npm-global"))
	// npm 用户 prefix 的 bin 应排在 PATH 之前

	var want []string
	want = append(want, testExecutablePaths(filepath.Join(home, ".local", "bin"), "codex")...)
	want = append(want, testExecutablePaths(filepath.Join(home, ".claude", "local"), "codex")...)
	want = append(want, testExecutablePaths(filepath.Join(home, ".opencode", "bin"), "codex")...)
	want = append(want, testExecutablePaths(filepath.Join(home, ".npm-global", "bin"), "codex")...)
	want = append(want, testExecutablePaths("/usr/bin", "codex")...)

	if !reflect.DeepEqual(got, want) {
		t.Fatalf("candidatePaths = %v, want %v", got, want)
	}
}

func testExecutablePaths(dir, cliName string) []string {
	names := []string{cliName}
	if runtime.GOOS == "windows" {
		names = []string{cliName, cliName + ".exe", cliName + ".cmd", cliName + ".bat"}
	}

	paths := make([]string, 0, len(names))
	for _, name := range names {
		paths = append(paths, filepath.Join(dir, name))
	}
	return paths
}

func TestResolveFrom(t *testing.T) {
	existsAll := func(p string) (string, bool) { return p, true } // 全部存在,real==p
	cases := []struct {
		name       string
		cands      []string
		owned      map[string]bool
		wantPath   string
		wantManage bool
		wantFound  bool
	}{
		{
			name:     "only root-owned: 仍可用但不可管理",
			cands:    []string{"/usr/bin/claude"},
			owned:    map[string]bool{},
			wantPath: "/usr/bin/claude", wantManage: false, wantFound: true,
		},
		{
			name:     "only user-local: 可管理",
			cands:    []string{"/home/u/.local/bin/claude"},
			owned:    map[string]bool{"/home/u/.local/bin/claude": true},
			wantPath: "/home/u/.local/bin/claude", wantManage: true, wantFound: true,
		},
		{
			name:     "both exist: 选用户本地(manageable 优先)",
			cands:    []string{"/usr/bin/claude", "/home/u/.local/bin/claude"},
			owned:    map[string]bool{"/home/u/.local/bin/claude": true},
			wantPath: "/home/u/.local/bin/claude", wantManage: true, wantFound: true,
		},
		{
			name:     "无 manageable: 回退第一个存在的",
			cands:    []string{"/usr/bin/claude", "/opt/claude"},
			owned:    map[string]bool{},
			wantPath: "/usr/bin/claude", wantManage: false, wantFound: true,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			owned := func(p string) bool { return c.owned[p] }
			path, manage, found := resolveFrom(c.cands, existsAll, owned)
			if path != c.wantPath || manage != c.wantManage || found != c.wantFound {
				t.Fatalf("got (%q,%v,%v), want (%q,%v,%v)", path, manage, found, c.wantPath, c.wantManage, c.wantFound)
			}
		})
	}
}

func TestResolveFrom_None(t *testing.T) {
	none := func(p string) (string, bool) { return "", false }
	path, manage, found := resolveFrom([]string{"/usr/bin/claude"}, none, func(string) bool { return false })
	if found || manage || path != "" {
		t.Fatalf("got (%q,%v,%v), want empty/not found", path, manage, found)
	}
}

func TestResolveAgentExcludingSkipsSameRealFile(t *testing.T) {
	dir := t.TempDir()
	real := filepath.Join(dir, "real-opencode")
	if err := os.WriteFile(real, []byte("binary"), 0o755); err != nil {
		t.Fatal(err)
	}
	shim := filepath.Join(dir, "opencode")
	if err := os.Symlink(real, shim); err != nil {
		t.Fatal(err)
	}
	fallback := filepath.Join(dir, "fallback-opencode")
	if err := os.WriteFile(fallback, []byte("binary"), 0o755); err != nil {
		t.Fatal(err)
	}

	path, _, found := resolveFromExcluding(
		[]string{shim, fallback},
		func(path string) (string, bool) {
			resolved, err := filepath.EvalSymlinks(path)
			return resolved, err == nil
		},
		func(string) bool { return true },
		[]string{real},
	)
	if !found || path != fallback {
		t.Fatalf("resolved (%q,%v), want fallback %q", path, found, fallback)
	}
}

func TestResolveAgentExcludingNormalizesRelativeExclusion(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "opencode")
	if err := os.WriteFile(bin, []byte("binary"), 0o755); err != nil {
		t.Fatal(err)
	}
	oldWD, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(dir); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chdir(oldWD) })

	_, _, found := resolveFromExcluding(
		[]string{bin},
		func(path string) (string, bool) { return path, true },
		func(string) bool { return true },
		[]string{"opencode"},
	)
	if found {
		t.Fatal("relative exclusion did not exclude the absolute candidate")
	}
}

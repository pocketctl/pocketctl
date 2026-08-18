package discovery

import (
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strconv"
	"syscall"
	"testing"
	"time"
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

func TestResolveFromFilteredRejectsFirstOwnedCandidate(t *testing.T) {
	candidates := []string{"/shim/claude", "/real/claude"}
	resolved := map[string]string{
		"/shim/claude": "/shim/claude",
		"/real/claude": "/real/claude",
	}
	got, _, found := resolveFromFiltered(
		candidates,
		func(path string) (string, bool) { return resolved[path], true },
		func(string) bool { return true },
		nil,
		func(candidate, _ string) bool { return candidate != "/shim/claude" },
	)
	if !found || got != "/real/claude" {
		t.Fatalf("resolved (%q,%v), want /real/claude", got, found)
	}
}

func TestResolveFromFilteredAllRejectedIsNotFound(t *testing.T) {
	got, manageable, found := resolveFromFiltered(
		[]string{"/shim/claude"},
		func(path string) (string, bool) { return path, true },
		func(string) bool { return true },
		nil,
		func(string, string) bool { return false },
	)
	if found || manageable || got != "" {
		t.Fatalf("resolved (%q,%v,%v), want not found", got, manageable, found)
	}
}

func TestResolveAgentFilteredRejectsShimCandidate(t *testing.T) {
	dir := t.TempDir()
	shimDir := filepath.Join(dir, "shimbin")
	realDir := filepath.Join(dir, "realbin")
	home := filepath.Join(dir, "home")
	for _, d := range []string{shimDir, realDir, home} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}

	cliFile := "claude"
	if runtime.GOOS == "windows" {
		cliFile = "claude.exe"
	}
	shim := filepath.Join(shimDir, cliFile)
	real := filepath.Join(realDir, cliFile)
	for _, p := range []string{shim, real} {
		if err := os.WriteFile(p, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
			t.Fatal(err)
		}
	}

	t.Setenv("HOME", home)
	t.Setenv("PATH", shimDir+string(os.PathListSeparator)+realDir)

	got, manageable, found := ResolveAgentFiltered(
		"claude",
		func(candidate, _ string) bool { return candidate != shim },
	)
	if !found || got != real {
		t.Fatalf("ResolveAgentFiltered = (%q,%v,%v), want real candidate %q", got, manageable, found, real)
	}
}

func TestDetectVersionTimesOut(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell fixture is Unix-only")
	}

	dir := t.TempDir()
	pidFile := filepath.Join(dir, "child.pid")
	bin := filepath.Join(dir, "stalled-agent")
	fixture := "#!/bin/sh\nsleep 30 &\necho $! > '" + pidFile + "'\nwait\n"
	if err := os.WriteFile(bin, []byte(fixture), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		data, err := os.ReadFile(pidFile)
		if err != nil {
			return
		}
		pid, err := strconv.Atoi(string(data[:len(data)-1]))
		if err == nil {
			_ = syscall.Kill(pid, syscall.SIGTERM)
		}
	})

	started := time.Now()
	if got := detectVersion(bin); got != "" {
		t.Fatalf("detectVersion(stalled binary) = %q, want empty", got)
	}
	if elapsed := time.Since(started); elapsed > versionProbeTimeout+2*time.Second {
		t.Fatalf("detectVersion took %s, want bounded probe", elapsed)
	}
}

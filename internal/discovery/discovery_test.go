package discovery

import (
	"path/filepath"
	"reflect"
	"testing"
)

func TestCandidatePaths_UserLocalFirstAndDedup(t *testing.T) {
	home := "/home/u"
	got := candidatePaths("claude", home, "/usr/bin:"+filepath.Join(home, ".local", "bin"), "")
	want := []string{
		filepath.Join(home, ".local", "bin", "claude"), // well-known 用户本地
		filepath.Join(home, ".claude", "local", "claude"),
		filepath.Join(home, ".opencode", "bin", "claude"),
		filepath.Join("/usr", "bin", "claude"), // 来自 PATH
		// PATH 里的 /home/u/.local/bin/claude 被去重(已在首位)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("candidatePaths = %v, want %v", got, want)
	}
}

func TestCandidatePaths_NpmPrefixIncluded(t *testing.T) {
	home := "/home/u"
	got := candidatePaths("codex", home, "/usr/bin", filepath.Join(home, ".npm-global"))
	// npm 用户 prefix 的 bin 应排在 PATH 之前
	want := []string{
		filepath.Join(home, ".local", "bin", "codex"),
		filepath.Join(home, ".claude", "local", "codex"),
		filepath.Join(home, ".opencode", "bin", "codex"),
		filepath.Join(home, ".npm-global", "bin", "codex"),
		filepath.Join("/usr", "bin", "codex"),
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("candidatePaths = %v, want %v", got, want)
	}
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
			name:      "only root-owned: 仍可用但不可管理",
			cands:     []string{"/usr/bin/claude"},
			owned:     map[string]bool{},
			wantPath:  "/usr/bin/claude", wantManage: false, wantFound: true,
		},
		{
			name:      "only user-local: 可管理",
			cands:     []string{"/home/u/.local/bin/claude"},
			owned:     map[string]bool{"/home/u/.local/bin/claude": true},
			wantPath:  "/home/u/.local/bin/claude", wantManage: true, wantFound: true,
		},
		{
			name:      "both exist: 选用户本地(manageable 优先)",
			cands:     []string{"/usr/bin/claude", "/home/u/.local/bin/claude"},
			owned:     map[string]bool{"/home/u/.local/bin/claude": true},
			wantPath:  "/home/u/.local/bin/claude", wantManage: true, wantFound: true,
		},
		{
			name:      "无 manageable: 回退第一个存在的",
			cands:     []string{"/usr/bin/claude", "/opt/claude"},
			owned:     map[string]bool{},
			wantPath:  "/usr/bin/claude", wantManage: false, wantFound: true,
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

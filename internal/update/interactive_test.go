package update

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestIsNewerVersion(t *testing.T) {
	for _, tc := range []struct {
		current, target string
		want            bool
	}{
		{"0.5.7", "v0.5.8", true}, {"v0.5.7", "v0.5.7", false}, {"0.5.10", "v0.5.9", false},
		{"0.5.9", "v0.5.10", true}, {"1.0.0-rc.2", "v1.0.0-rc.10", true}, {"1.0.0-rc.10", "v1.0.0", true},
		{"1.0.0", "v1.0.0-rc.1", false}, {"1.0.0+abc", "v1.0.0+def", false},
		{"dev", "v1.0.0", false}, {"", "v1.0.0", false}, {"1.0.0", "v01.1.0", false}, {"1.0.0", "v1.0.1-01", false},
	} {
		t.Run(tc.current+"_"+tc.target, func(t *testing.T) {
			if got := IsNewerVersion(tc.current, tc.target); got != tc.want {
				t.Fatalf("got %v want %v", got, tc.want)
			}
		})
	}
}

func TestCheckLatestContextDeadline(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { <-r.Context().Done() }))
	defer server.Close()
	old := githubAPIBase
	githubAPIBase = server.URL
	defer func() { githubAPIBase = old }()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	if _, err := CheckLatestContext(ctx); err == nil {
		t.Fatal("expected deadline failure")
	}
}

func TestInstallVerifiedPreservesOldBinaryOnMismatch(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "pocketctl")
	source := filepath.Join(t.TempDir(), "download")
	os.WriteFile(target, []byte("old"), 0755)
	os.WriteFile(source, []byte("new"), 0600)
	if err := InstallVerified(source, target, hexSHA([]byte("wrong"))); err == nil {
		t.Fatal("accepted invalid checksum")
	}
	data, _ := os.ReadFile(target)
	if string(data) != "old" {
		t.Fatalf("old binary lost: %q", data)
	}
	if err := InstallVerified(source, target, hexSHA([]byte("new"))); err != nil {
		t.Fatal(err)
	}
	data, _ = os.ReadFile(target)
	if string(data) != "new" {
		t.Fatalf("not installed: %q", data)
	}
	info, _ := os.Stat(target)
	if info.Mode().Perm() != 0755 {
		t.Fatalf("mode %v", info.Mode())
	}
	files, _ := os.ReadDir(dir)
	if len(files) != 1 {
		t.Fatal("staging files leaked")
	}
}

func TestCheckVersionRejectsNonVersionBeforeNetwork(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls++; w.WriteHeader(404) }))
	defer server.Close()
	old := githubAPIBase
	githubAPIBase = server.URL
	defer func() { githubAPIBase = old }()
	for _, tag := range []string{"v../../latest", "v1.0.0/anything", "v1.0.0?x=y", "v01.0.0"} {
		if _, err := CheckVersion(tag); err == nil {
			t.Fatalf("accepted %s", tag)
		}
	}
	if calls != 0 {
		t.Fatalf("invalid version made %d network requests", calls)
	}
}

func TestInstallVerifiedRejectsTargetSymlink(t *testing.T) {
	dir := t.TempDir()
	victim := filepath.Join(dir, "victim")
	target := filepath.Join(dir, "link")
	source := filepath.Join(dir, "download")
	os.WriteFile(victim, []byte("old"), 0755)
	os.WriteFile(source, []byte("new"), 0755)
	if err := os.Symlink(victim, target); err != nil {
		t.Skip(err)
	}
	if err := InstallVerified(source, target, hexSHA([]byte("new"))); err == nil {
		t.Fatal("accepted symlink target")
	}
	data, _ := os.ReadFile(victim)
	if string(data) != "old" {
		t.Fatal("overwrote symlink victim")
	}
}

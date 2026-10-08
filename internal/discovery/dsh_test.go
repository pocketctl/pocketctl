package discovery

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/pocketctl/pocketctl/internal/dshapp"
)

func TestDSHConfiguredHostWithoutCLI(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("PATH", "")
	t.Setenv("POCKETCTL_DSH_URL", "")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"result":{"ok":true,"value":{"groups":[]}}}`))
		}
	}))
	defer server.Close()
	if err := dshapp.SaveConfig(dshapp.Config{URL: server.URL}); err != nil {
		t.Fatal(err)
	}
	find := func() *AgentInfo {
		for _, a := range DiscoverLocalAgents() {
			if a.Type == "dsh" {
				return &a
			}
		}
		return nil
	}
	a := find()
	if a == nil || a.Manageable || !a.TeamCallable || a.Path != "" {
		t.Fatalf("configured Host missing or misclassified: %+v", a)
	}
	server.Close()
	a = find()
	if a == nil || a.TeamCallable {
		t.Fatalf("offline Host must stay visible but not callable: %+v", a)
	}
	if err := os.Remove(dshapp.ConfigPath()); err != nil {
		t.Fatal(err)
	}
	if a = find(); a != nil {
		t.Fatalf("disabled absent CLI retained: %+v", a)
	}
}

func TestDSHInvalidConfigurationIsNotInstallationEvidence(t *testing.T) {
	t.Setenv("POCKETCTL_DSH_URL", "https://example.com/?token=private")
	if configured, callable := discoverDSHHost(); configured || callable {
		t.Fatal("invalid remote config accepted")
	}
}

func TestDSHUserPackageBinsWithoutShellPATH(t *testing.T) {
	paths := candidatePaths("dsh", "/user", "", "")
	for _, want := range []string{filepath.Join("/user", ".bun", "bin", "dsh"), filepath.Join("/user", "Library", "pnpm", "dsh")} {
		found := false
		for _, p := range paths {
			if p == want {
				found = true
			}
		}
		if !found {
			t.Errorf("missing user-local package path %s", want)
		}
	}
}

func TestLocalVersionCacheReprobesChangedCLI(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell fixture")
	}
	dir := t.TempDir()
	cli := filepath.Join(dir, "dsh")
	count := filepath.Join(dir, "probes")
	write := func(version string) {
		t.Helper()
		if err := os.WriteFile(cli, []byte("#!/bin/sh\necho probe >> '"+count+"'\necho "+version+"\n"), 0700); err != nil {
			t.Fatal(err)
		}
	}
	write("1.0.0")
	if cachedVersion(cli, false) != "1.0.0" || cachedVersion(cli, false) != "1.0.0" {
		t.Fatal("version unavailable")
	}
	probes, _ := os.ReadFile(count)
	if strings.Count(string(probes), "probe") != 1 {
		t.Fatal("unchanged executable was re-launched")
	}
	write("11.0.0")
	if cachedVersion(cli, false) != "11.0.0" {
		t.Fatal("changed executable cache not invalidated")
	}
	_ = cachedVersion(cli, true)
	probes, _ = os.ReadFile(count)
	if strings.Count(string(probes), "probe") != 3 {
		t.Fatal("explicit scan did not reprobe")
	}
}

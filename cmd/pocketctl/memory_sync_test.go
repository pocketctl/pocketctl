package main

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/pocketctl/pocketctl/internal/memorysync"
)

func buildSyncRepo(t *testing.T) (string, string) {
	t.Helper()
	git, err := exec.LookPath("git")
	if err != nil {
		t.Skip("git not available")
	}
	dir := t.TempDir()
	run := func(args ...string) {
		cmd := exec.Command(git, args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	run("init", "-q", "--initial-branch=main", ".")
	run("config", "user.email", "test@example.test")
	run("config", "user.name", "Test")
	if err := os.MkdirAll(filepath.Join(dir, "src"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "src", "a.ts"), []byte("export const a = 1;\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "tool.py"), []byte("print(1)\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run("add", "-A")
	run("commit", "-q", "-m", "initial")
	return git, dir
}

func TestMemorySyncRepoDryRunPrintsCountsAndReasonsWithoutNetwork(t *testing.T) {
	_, dir := buildSyncRepo(t)

	var out bytes.Buffer
	code := runMemorySyncRepo(&out, &out, []string{"sync-repo", "--repo", dir, "--dry-run"})
	if code != 0 {
		t.Fatalf("dry-run failed: %s", out.String())
	}
	text := out.String()
	for _, want := range []string{"accepted: 1", "total_bytes: 20", "excluded: 1", "unsupported_language", "manifest_sha256"} {
		if !strings.Contains(text, want) {
			t.Fatalf("dry-run output missing %q:\n%s", want, text)
		}
	}
}

func TestMemorySyncRepoRejectsDirtyWorktreeBeforeAnyUpload(t *testing.T) {
	_, dir := buildSyncRepo(t)
	if err := os.WriteFile(filepath.Join(dir, "src", "a.ts"), []byte("export const a = 2;\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	var out bytes.Buffer
	code := runMemorySyncRepo(&out, &out, []string{"sync-repo", "--repo", dir, "--dry-run"})
	if code == 0 {
		t.Fatalf("dirty worktree accepted:\n%s", out.String())
	}
	if !strings.Contains(out.String(), "dirty") {
		t.Fatalf("bounded reason missing: %s", out.String())
	}
}

func TestMemorySyncRepoParsesFlags(t *testing.T) {
	options, err := parseMemorySyncRepoFlags([]string{
		"--repo", "/tmp/somewhere",
		"--scope-installation-id", "22222222-2222-4222-8222-222222222222",
		"--dry-run",
	})
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if options.RepoPath != "/tmp/somewhere" {
		t.Fatalf("repo path: %q", options.RepoPath)
	}
	if options.ScopeInstallationID != "22222222-2222-4222-8222-222222222222" {
		t.Fatalf("scope: %q", options.ScopeInstallationID)
	}
	if !options.DryRun {
		t.Fatal("dry run flag lost")
	}

	if _, err := parseMemorySyncRepoFlags([]string{}); err == nil {
		t.Fatal("missing --repo must fail")
	}
	if _, err := parseMemorySyncRepoFlags([]string{"--repo", "/x", "--scope-installation-id", "not-a-uuid"}); err == nil {
		t.Fatal("invalid scope uuid must fail")
	}
}

func TestMemorySyncRepoExplicitSyncCollectsAndUploads(t *testing.T) {
	_, dir := buildSyncRepo(t)

	// The upload client is injected so no network happens; the dry-run-off
	// path proves collection feeds the frozen upload contract.
	var uploaded *memorysync.Snapshot
	code := runMemorySyncRepoWith(&bytes.Buffer{}, &bytes.Buffer{}, []string{"sync-repo", "--repo", dir},
		memorySyncDeps{
			collect: func(ctx context.Context, repoPath string) (*memorysync.Snapshot, error) {
				return memorysync.Collect(ctx, repoPath, memorysync.DefaultLimits())
			},
			upload: func(ctx context.Context, snapshot *memorysync.Snapshot) (string, error) {
				uploaded = snapshot
				return "snap-test-1", nil
			},
		})
	if code != 0 {
		t.Fatal("sync failed")
	}
	if uploaded == nil {
		t.Fatal("upload never invoked")
	}
	if len(uploaded.Entries) != 1 || uploaded.Entries[0].Path != "src/a.ts" {
		t.Fatalf("uploaded entries: %+v", uploaded.Entries)
	}
}

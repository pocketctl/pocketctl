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
			upload: func(ctx context.Context, snapshot *memorysync.Snapshot) (memorysync.SyncResult, error) {
				uploaded = snapshot
				return memorysync.SyncResult{SnapshotID: "snap-test-1", Repository: "repo-test-1", State: "ready"}, nil
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

func TestMemoryHelpDoesNotCollectOrUpload(t *testing.T) {
	for _, args := range [][]string{nil, {"--help"}, {"-h"}, {"sync-repo", "--help"}, {"sync-repo", "--repo", "missing", "-h"}} {
		var out bytes.Buffer
		code := runMemorySyncRepoWith(&out, &out, args, memorySyncDeps{})
		if code != 0 || !strings.Contains(out.String(), "--committed") || !strings.Contains(out.String(), "--scope-installation-id") {
			t.Fatalf("help %v: %d %s", args, code, out.String())
		}
	}
}

func TestMemorySyncCommittedDryRunPreservesDirtyFiles(t *testing.T) {
	_, dir := buildSyncRepo(t)
	path := filepath.Join(dir, "src", "a.ts")
	dirty := []byte("export const dirty = 42;\n")
	if err := os.WriteFile(path, dirty, 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if code := runMemorySyncRepo(&out, &out, []string{"sync-repo", "--repo", dir, "--committed", "--dry-run", "--include", "src"}); code != 0 {
		t.Fatal(out.String())
	}
	if !strings.Contains(out.String(), "total_bytes: 20") {
		t.Fatal(out.String())
	}
	after, _ := os.ReadFile(path)
	if !bytes.Equal(after, dirty) {
		t.Fatal("worktree mutated")
	}
}

func TestMemorySyncPartialRequiresExplicitConsentAndPrintsRepository(t *testing.T) {
	var out bytes.Buffer
	calls := 0
	deps := memorySyncDeps{
		collect: func(context.Context, string) (*memorysync.Snapshot, error) {
			return &memorysync.Snapshot{Entries: []memorysync.CollectedEntry{{Path: "a.ts"}}, TotalBytes: 1, Excluded: []memorysync.Exclusion{{Path: "b.ts", Reason: "too_many_files"}}}, nil
		},
		upload: func(context.Context, *memorysync.Snapshot) (memorysync.SyncResult, error) {
			calls++
			return memorysync.SyncResult{Repository: "repo-id", SnapshotID: "snapshot-id", State: "ready", UploadedFiles: 1}, nil
		},
	}
	args := []string{"sync-repo", "--repo", "."}
	if code := runMemorySyncRepoWith(&out, &out, args, deps); code == 0 || calls != 0 {
		t.Fatal("truncation silently uploaded")
	}
	out.Reset()
	if code := runMemorySyncRepoWith(&out, &out, append(args, "--allow-partial"), deps); code != 0 {
		t.Fatal(out.String())
	}
	for _, want := range []string{"repository_id: repo-id", "snapshot_id: snapshot-id", "state: ready", "uploaded_files: 1"} {
		if !strings.Contains(out.String(), want) {
			t.Fatalf("missing %s: %s", want, out.String())
		}
	}
}

func TestMemoryGraphViewURLUsesAppRouteAndStripsRelayCredentials(t *testing.T) {
	got := memoryCodeGraphViewURL("wss://user:password@example.test/ws?token=secret#old", "repo", "scope")
	if got != "https://example.test/app/memory?installation_id=scope&repository_id=repo&tab=codegraph" {
		t.Fatal(got)
	}
	if got := memoryCodeGraphViewURL("file:///tmp/relay", "repo", ""); got != "" {
		t.Fatal(got)
	}
}

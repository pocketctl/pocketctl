package memorysync

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// testRepo builds a synthetic Git repository and commits the given files.
type testRepo struct {
	t    *testing.T
	dir  string
	git  string
	root string
}

func newTestRepo(t *testing.T) *testRepo {
	t.Helper()
	git, err := exec.LookPath("git")
	if err != nil {
		t.Skip("git not available")
	}
	dir := t.TempDir()
	r := &testRepo{t: t, dir: dir, git: git}
	r.run(dir, "init", "-q", "--initial-branch=main", ".")
	r.run(dir, "config", "user.email", "test@example.test")
	r.run(dir, "config", "user.name", "Test")
	r.run(dir, "config", "commit.gpgsign", "false")
	r.root = dir
	return r
}

func (r *testRepo) run(dir string, args ...string) string {
	r.t.Helper()
	cmd := exec.Command(r.git, args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_OPTIONAL_LOCKS=0")
	out, err := cmd.CombinedOutput()
	if err != nil {
		r.t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return string(out)
}

func (r *testRepo) write(rel, content string) {
	r.t.Helper()
	path := filepath.Join(r.root, rel)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		r.t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		r.t.Fatal(err)
	}
}

func (r *testRepo) symlink(rel, target string) {
	r.t.Helper()
	path := filepath.Join(r.root, rel)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		r.t.Fatal(err)
	}
	if err := os.Symlink(target, path); err != nil {
		r.t.Fatal(err)
	}
}

func (r *testRepo) commitAll(message string) {
	r.t.Helper()
	r.run(r.root, "add", "-A")
	r.run(r.root, "commit", "-q", "-m", message)
}

func (r *testRepo) head() string {
	return strings.TrimSpace(r.run(r.root, "rev-parse", "HEAD"))
}

func sha256Hex(content []byte) string {
	sum := sha256.Sum256(content)
	return hex.EncodeToString(sum[:])
}

func entryByPath(t *testing.T, snap *Snapshot, path string) *CollectedEntry {
	t.Helper()
	for i := range snap.Entries {
		if snap.Entries[i].Path == path {
			return &snap.Entries[i]
		}
	}
	t.Fatalf("entry %q missing from snapshot", path)
	return nil
}

func exclusionReasons(snap *Snapshot) map[string]string {
	reasons := map[string]string{}
	for _, ex := range snap.Excluded {
		reasons[ex.Path] = ex.Reason
	}
	return reasons
}

func TestCollectAcceptsCleanCommittedHeadWithStableHashes(t *testing.T) {
	repo := newTestRepo(t)
	repo.write("src/a.ts", "export const a = 1;\n")
	repo.write("src/lib/b.tsx", "export function b() { return 2; }\n")
	repo.write("README.md", "# readme\n")
	repo.write("main.go", "package main\n")
	repo.commitAll("initial")

	snap, err := Collect(context.Background(), repo.root, DefaultLimits())
	if err != nil {
		t.Fatalf("collect: %v", err)
	}
	if snap.CommitSHA != repo.head() {
		t.Fatalf("commit mismatch: %s vs %s", snap.CommitSHA, repo.head())
	}
	if snap.GitObjectFormat != "sha1" {
		t.Fatalf("object format: %q", snap.GitObjectFormat)
	}
	if len(snap.Entries) != 4 {
		t.Fatalf("entries: %d (%v)", len(snap.Entries), snap.Entries)
	}

	// Sorted canonical path order.
	for i := 1; i < len(snap.Entries); i++ {
		if snap.Entries[i-1].Path >= snap.Entries[i].Path {
			t.Fatalf("entries not sorted: %s >= %s", snap.Entries[i-1].Path, snap.Entries[i].Path)
		}
	}

	a := entryByPath(t, snap, "src/a.ts")
	if a.Capability != "symbols_and_edges" || a.Language != "typescript" {
		t.Fatalf("a.ts capability/language: %s/%s", a.Capability, a.Language)
	}
	if a.BlobSHA256 != sha256Hex([]byte("export const a = 1;\n")) {
		t.Fatalf("blob hash mismatch: %s", a.BlobSHA256)
	}
	if a.GitMode != "100644" {
		t.Fatalf("mode: %s", a.GitMode)
	}
	b := entryByPath(t, snap, "src/lib/b.tsx")
	if b.Capability != "symbols_and_edges" || b.Language != "tsx" {
		t.Fatalf("b.tsx capability/language: %s/%s", b.Capability, b.Language)
	}
	readme := entryByPath(t, snap, "README.md")
	if readme.Capability != "file_only" || readme.Language != "markdown" {
		t.Fatalf("README capability/language: %s/%s", readme.Capability, readme.Language)
	}
	goFile := entryByPath(t, snap, "main.go")
	if goFile.Capability != "file_only" || goFile.Language != "go" {
		t.Fatalf("main.go capability/language: %s/%s", goFile.Capability, goFile.Language)
	}

	// Deterministic manifest hash across repeated collections.
	again, err := Collect(context.Background(), repo.root, DefaultLimits())
	if err != nil {
		t.Fatalf("re-collect: %v", err)
	}
	if again.ManifestSHA256 != snap.ManifestSHA256 {
		t.Fatalf("manifest hash drifted: %s vs %s", snap.ManifestSHA256, again.ManifestSHA256)
	}
	if snap.ParserMatrixVersion != ParserMatrixVersion {
		t.Fatalf("parser matrix version: %q", snap.ParserMatrixVersion)
	}
}

func TestCollectRejectsDirtyIndexAndWorktree(t *testing.T) {
	repo := newTestRepo(t)
	repo.write("src/a.ts", "export const a = 1;\n")
	repo.commitAll("initial")

	repo.write("src/a.ts", "export const a = 2;\n")
	_, err := Collect(context.Background(), repo.root, DefaultLimits())
	if err == nil || !strings.Contains(err.Error(), "dirty_worktree") {
		t.Fatalf("dirty worktree not rejected: %v", err)
	}

	repo.run(repo.root, "add", "src/a.ts")
	_, err = Collect(context.Background(), repo.root, DefaultLimits())
	if err == nil || !strings.Contains(err.Error(), "dirty_index") {
		t.Fatalf("dirty index not rejected: %v", err)
	}
}

func TestCollectIgnoresUntrackedAndIgnoredFilesWithoutReadingThem(t *testing.T) {
	repo := newTestRepo(t)
	repo.write("src/a.ts", "export const a = 1;\n")
	repo.write(".gitignore", "scratch/\n")
	repo.commitAll("initial")
	// Untracked + ignored files exist in the worktree but never in HEAD.
	repo.write("untracked.ts", "secret-untracked")
	repo.write("scratch/ignored.ts", "secret-ignored")

	snap, err := Collect(context.Background(), repo.root, DefaultLimits())
	if err != nil {
		t.Fatalf("collect: %v", err)
	}
	if _, reasons := exclusionReasons(snap), map[string]string{}; len(reasons) != 0 {
		// no exclusions expected for untracked content
	}
	for _, entry := range snap.Entries {
		if entry.Path != "src/a.ts" && entry.Path != ".gitignore" {
			t.Fatalf("unexpected entry %q", entry.Path)
		}
	}
	found := false
	for _, entry := range snap.Entries {
		if entry.Path == "src/a.ts" {
			found = true
		}
	}
	if !found {
		t.Fatal("src/a.ts missing")
	}
}

func TestCollectExcludesSymlinkWithoutFollowingIt(t *testing.T) {
	repo := newTestRepo(t)
	repo.write("real.ts", "export const real = 1;\n")
	repo.symlink("link.ts", "real.ts")
	repo.commitAll("initial")

	snap, err := Collect(context.Background(), repo.root, DefaultLimits())
	if err != nil {
		t.Fatalf("collect: %v", err)
	}
	if reason := exclusionReasons(snap)["link.ts"]; reason != "symlink" {
		t.Fatalf("symlink exclusion reason: %q (excluded=%v)", reason, snap.Excluded)
	}
	if len(snap.Entries) != 1 { // only real.ts
		t.Fatalf("entries: %d", len(snap.Entries))
	}
}

func TestCollectHardDeniesSecretPathsAndVendorTrees(t *testing.T) {
	repo := newTestRepo(t)
	repo.write("src/a.ts", "export const a = 1;\n")
	repo.write(".env", "X=1\n")
	repo.write(".env.local", "X=1\n")
	repo.write("certs/server.pem", "-----BEGIN CERTIFICATE-----\n")
	repo.write("keys/id_rsa", "-----BEGIN OPENSSH PRIVATE KEY-----\n")
	repo.write("vendor/lib.ts", "export {}\n")
	repo.write("node_modules/pkg/index.js", "module.exports = 1\n")
	repo.write("packages/app/vendor/lib.ts", "export {}\n")
	repo.write("packages/app/node_modules/pkg/index.js", "module.exports = 1\n")
	repo.write("packages/app/package-lock.json", "{}\n")
	repo.write("app.min.js", "var a=1;")
	repo.write("types/global.d.ts", "declare var x: number;\n")
	repo.write("package-lock.json", "{}\n")
	repo.commitAll("initial")

	snap, err := Collect(context.Background(), repo.root, DefaultLimits())
	if err != nil {
		t.Fatalf("collect: %v", err)
	}
	reasons := exclusionReasons(snap)
	for path, want := range map[string]string{
		".env":                                   "hard_denied_path",
		".env.local":                             "hard_denied_path",
		"certs/server.pem":                       "hard_denied_path",
		"keys/id_rsa":                            "hard_denied_path",
		"vendor/lib.ts":                          "hard_denied_path",
		"node_modules/pkg/index.js":              "hard_denied_path",
		"packages/app/vendor/lib.ts":             "hard_denied_path",
		"packages/app/node_modules/pkg/index.js": "hard_denied_path",
		"packages/app/package-lock.json":         "lockfile",
		"app.min.js":                             "generated_or_minified",
		"types/global.d.ts":                      "generated_declaration",
		"package-lock.json":                      "lockfile",
	} {
		if got := reasons[path]; got != want {
			t.Fatalf("exclusion %q: got %q want %q", path, got, want)
		}
	}
	if _, ok := exclusionReasons(snap)["src/a.ts"]; ok {
		t.Fatal("src/a.ts must be accepted")
	}
}

func TestCollectHonorsCommittedIgnoreButNeverUncommitted(t *testing.T) {
	repo := newTestRepo(t)
	repo.write("src/a.ts", "export const a = 1;\n")
	repo.write("src/skipme.ts", "export const skip = 1;\n")
	repo.write(".pocketctlmemoryignore", "src/skipme.ts\n")
	repo.commitAll("initial")

	snap, err := Collect(context.Background(), repo.root, DefaultLimits())
	if err != nil {
		t.Fatalf("collect: %v", err)
	}
	if reason := exclusionReasons(snap)["src/skipme.ts"]; reason != "ignored" {
		t.Fatalf("committed ignore not honored: %+v", snap.Excluded)
	}
	entryByPath(t, snap, "src/a.ts")

	// An uncommitted ignore file never takes effect: the worktree is dirty
	// and commit-mode collection refuses before reading any tree content.
	repo.write(".pocketctlmemoryignore", "src/a.ts\n") // not committed
	_, err = Collect(context.Background(), repo.root, DefaultLimits())
	if err == nil || !strings.Contains(err.Error(), "dirty") {
		t.Fatalf("uncommitted ignore must leave the worktree dirty and refuse: %v", err)
	}
}

func TestCollectIgnoreCannotReincludeHardDeniedPath(t *testing.T) {
	repo := newTestRepo(t)
	repo.write("src/a.ts", "export const a = 1;\n")
	repo.write(".env", "X=1\n")
	repo.write(".pocketctlmemoryignore", "# comment\n\nsrc/a.ts\n")
	repo.commitAll("initial")

	snap, err := Collect(context.Background(), repo.root, DefaultLimits())
	if err != nil {
		t.Fatalf("collect: %v", err)
	}
	reasons := exclusionReasons(snap)
	if reasons[".env"] != "hard_denied_path" {
		t.Fatalf(".env must stay hard-denied, got %q", reasons[".env"])
	}
	if reasons["src/a.ts"] != "ignored" {
		t.Fatalf("src/a.ts should be ignored, got %q", reasons["src/a.ts"])
	}
}

func TestCollectExcludesSecretContentWithReasonOnly(t *testing.T) {
	repo := newTestRepo(t)
	repo.write("src/a.ts", "export const a = 1;\n")
	repo.write("src/leaked.ts", "const key = `-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----`;\n")
	repo.write("config/prod.json", `{"aws": "AKIAIOSFODNN7EXAMPLE"}`)
	repo.commitAll("initial")

	snap, err := Collect(context.Background(), repo.root, DefaultLimits())
	if err != nil {
		t.Fatalf("collect: %v", err)
	}
	reasons := exclusionReasons(snap)
	if reasons["src/leaked.ts"] != "secret_content" {
		t.Fatalf("private key not rejected: %+v", snap.Excluded)
	}
	if reasons["config/prod.json"] != "secret_content" {
		t.Fatalf("aws token not rejected: %+v", snap.Excluded)
	}
	// The exclusion record carries the reason only, never matched content.
	for _, ex := range snap.Excluded {
		if strings.Contains(ex.Reason, "AKIA") || strings.Contains(ex.Reason, "PRIVATE KEY") {
			t.Fatalf("exclusion reason leaks content: %+v", ex)
		}
	}
}

func TestCollectRejectsBinaryAndInvalidUTF8Content(t *testing.T) {
	repo := newTestRepo(t)
	repo.write("src/a.ts", "export const a = 1;\n")
	if err := os.WriteFile(filepath.Join(repo.root, "src/binary.ts"), []byte{0x00, 0x01, 0x02}, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repo.root, "src/badutf8.ts"), []byte{0xff, 0xfe, '\n'}, 0o644); err != nil {
		t.Fatal(err)
	}
	repo.commitAll("initial")

	snap, err := Collect(context.Background(), repo.root, DefaultLimits())
	if err != nil {
		t.Fatalf("collect: %v", err)
	}
	reasons := exclusionReasons(snap)
	if reasons["src/binary.ts"] != "binary" {
		t.Fatalf("binary reason: %+v", snap.Excluded)
	}
	if reasons["src/badutf8.ts"] != "invalid_utf8" {
		t.Fatalf("utf8 reason: %+v", snap.Excluded)
	}
}

func TestCollectEnforcesSizeLimitsThroughInjectableBounds(t *testing.T) {
	repo := newTestRepo(t)
	repo.write("src/a.ts", "export const a = 1;\n")
	big := strings.Repeat("x", 4096)
	repo.write("src/big.ts", big)
	repo.write("src/b2.ts", big)
	repo.commitAll("initial")

	limits := DefaultLimits()
	limits.MaxFileBytes = 2048
	snap, err := Collect(context.Background(), repo.root, limits)
	if err != nil {
		t.Fatalf("collect: %v", err)
	}
	if reason := exclusionReasons(snap)["src/big.ts"]; reason != "oversized_file" {
		t.Fatalf("file limit reason: %+v", snap.Excluded)
	}

	limits = DefaultLimits()
	limits.MaxTotalBytes = 4096
	snap2, err := Collect(context.Background(), repo.root, limits)
	if err != nil {
		t.Fatalf("collect 2: %v", err)
	}
	counts := map[string]int{}
	for _, ex := range snap2.Excluded {
		counts[ex.Reason]++
	}
	if counts["oversized_total"] == 0 {
		t.Fatalf("total limit never applied: %+v", snap2.Excluded)
	}

	limits = DefaultLimits()
	limits.MaxAcceptedFiles = 1
	snap3, err := Collect(context.Background(), repo.root, limits)
	if err != nil {
		t.Fatalf("collect 3: %v", err)
	}
	counts = map[string]int{}
	for _, ex := range snap3.Excluded {
		counts[ex.Reason]++
	}
	if counts["too_many_files"] == 0 {
		t.Fatalf("file-count limit never applied: %+v", snap3.Excluded)
	}
}

func TestCollectExcludesUnsupportedLanguages(t *testing.T) {
	repo := newTestRepo(t)
	repo.write("src/a.ts", "export const a = 1;\n")
	repo.write("tool.py", "print(1)\n")
	repo.write("lib.rs", "fn main() {}\n")
	repo.write("logo.png", "\x89PNG\r\n\x1a\n")
	repo.write("data.yaml", "a: 1\n")
	repo.write("go.mod", "module example.test/m\n\ngo 1.25\n")
	repo.commitAll("initial")

	snap, err := Collect(context.Background(), repo.root, DefaultLimits())
	if err != nil {
		t.Fatalf("collect: %v", err)
	}
	reasons := exclusionReasons(snap)
	if reasons["tool.py"] != "unsupported_language" {
		t.Fatalf("py: %+v", snap.Excluded)
	}
	if reasons["lib.rs"] != "unsupported_language" {
		t.Fatalf("rs: %+v", snap.Excluded)
	}
	if _, ok := reasons["logo.png"]; !ok {
		t.Fatalf("png must be excluded: %+v", snap.Excluded)
	}
	yamlEntry := entryByPath(t, snap, "data.yaml")
	if yamlEntry.Capability != "file_only" {
		t.Fatalf("yaml capability: %s", yamlEntry.Capability)
	}
	gomod := entryByPath(t, snap, "go.mod")
	if gomod.Capability != "file_only" || gomod.Language != "go" {
		t.Fatalf("go.mod: %s/%s", gomod.Capability, gomod.Language)
	}
}

func TestCollectDerivesInstallationScopedRepositoryIdentity(t *testing.T) {
	repo := newTestRepo(t)
	repo.write("src/a.ts", "export const a = 1;\n")
	repo.commitAll("initial")

	// No origin: identity must not leak the local checkout path.
	snap, err := Collect(context.Background(), repo.root, DefaultLimits())
	if err != nil {
		t.Fatalf("collect: %v", err)
	}
	if snap.RepositoryKey == "" {
		t.Fatal("repository key required")
	}
	if strings.Contains(snap.RepositoryKey, repo.root) || strings.Contains(snap.RepositoryKey, "/Users/") {
		t.Fatalf("repository key leaks path: %q", snap.RepositoryKey)
	}

	// With an HTTPS origin the canonical host/path identity applies.
	repo.run(repo.root, "remote", "add", "origin", "https://github.com/example/Test.Repo.git")
	snap2, err := Collect(context.Background(), repo.root, DefaultLimits())
	if err != nil {
		t.Fatalf("collect 2: %v", err)
	}
	if snap2.RepositoryKey != "github.com/example/Test.Repo" {
		t.Fatalf("canonical key: %q", snap2.RepositoryKey)
	}
	if snap2.CanonicalRemote != "https://github.com/example/Test.Repo.git" {
		t.Fatalf("canonical remote: %q", snap2.CanonicalRemote)
	}

	// Canonical metadata must never retain transport credentials.
	repo.run(repo.root, "remote", "set-url", "origin", "https://user:token@github.com/example/Test.Repo.git")
	snap3, err := Collect(context.Background(), repo.root, DefaultLimits())
	if err != nil {
		t.Fatalf("collect 3: %v", err)
	}
	if snap3.CanonicalRemote != "https://github.com/example/Test.Repo.git" {
		t.Fatalf("credential-free canonical remote: %q", snap3.CanonicalRemote)
	}
	if strings.Contains(snap3.CanonicalRemote, "user") || strings.Contains(snap3.CanonicalRemote, "token") {
		t.Fatalf("canonical remote leaks credentials: %q", snap3.CanonicalRemote)
	}
}

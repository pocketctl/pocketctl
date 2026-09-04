package memorysync

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/pocketctl/pocketctl/internal/repositoryidentity"
)

const gitTimeout = 30 * time.Second

// CollectedEntry is one accepted committed file with its content hash.
type CollectedEntry struct {
	Path       string
	GitMode    string
	Language   string
	Capability string
	BlobSHA256 string
	ByteCount  int64
	Content    []byte
}

// Exclusion records a bounded reason code; matched content never appears.
type Exclusion struct {
	Path   string
	Reason string
}

// Snapshot is the collected committed tree: entries sorted by path, a stable
// manifest hash, and the derived installation-scoped repository identity.
type Snapshot struct {
	Root                string
	CommitSHA           string
	GitObjectFormat     string
	RepositoryKey       string
	CanonicalRemote     string
	ManifestSHA256      string
	ParserMatrixVersion string
	TotalBytes          int64
	Entries             []CollectedEntry
	Excluded            []Exclusion
}

// CollectError carries a bounded machine code for CLI display.
type CollectError struct{ Code string }

func (e *CollectError) Error() string { return e.Code }

func codeErr(code string) error { return &CollectError{Code: code} }

// Collect enumerates exactly the clean committed HEAD tree of the repository
// containing repoPath. Dirty index/worktree states are rejected; untracked
// and ignored files are never read.
func Collect(ctx context.Context, repoPath string, limits Limits) (*Snapshot, error) {
	root, err := gitText(ctx, repoPath, "rev-parse", "--show-toplevel")
	if err != nil {
		return nil, codeErr("not_a_git_repository")
	}
	commit, err := gitText(ctx, root, "rev-parse", "HEAD")
	if err != nil {
		return nil, codeErr("no_commit")
	}
	objectFormat, err := gitText(ctx, root, "rev-parse", "--show-object-format")
	if err != nil || (objectFormat != "sha1" && objectFormat != "sha256") {
		return nil, codeErr("unsupported_object_format")
	}

	if err := requireClean(ctx, root); err != nil {
		return nil, err
	}

	tree, err := listTree(ctx, root)
	if err != nil {
		return nil, codeErr("tree_unreadable")
	}

	snapshot := &Snapshot{
		Root:                root,
		CommitSHA:           commit,
		GitObjectFormat:     objectFormat,
		ParserMatrixVersion: ParserMatrixVersion,
	}
	applyRepositoryIdentity(ctx, root, snapshot)

	// A committed .pocketctlmemoryignore is the only authoritative ignore
	// source; the worktree copy is deliberately never read.
	var ignore *ignoreRules
	for _, item := range tree {
		if item.path == pocketctlMemoryIgnorePath && item.mode == "100644" || item.path == pocketctlMemoryIgnorePath && item.mode == "100755" {
			content, err := gitBlob(ctx, root, item.object)
			if err == nil {
				rules, errParse := parseIgnoreRules(string(content))
				if errParse == nil {
					ignore = rules
				}
			}
		}
	}

	acceptedCount := 0
	var acceptedBytes int64
	for _, item := range tree {
		if reason, denied := hardDenyReason(item.path); denied {
			snapshot.Excluded = append(snapshot.Excluded, Exclusion{Path: item.path, Reason: reason})
			continue
		}
		if ignore != nil && ignore.matches(item.path) {
			snapshot.Excluded = append(snapshot.Excluded, Exclusion{Path: item.path, Reason: "ignored"})
			continue
		}
		capability, language, supported := languageFor(item.path)
		if !supported {
			snapshot.Excluded = append(snapshot.Excluded, Exclusion{Path: item.path, Reason: "unsupported_language"})
			continue
		}
		if acceptedCount >= limits.MaxAcceptedFiles {
			snapshot.Excluded = append(snapshot.Excluded, Exclusion{Path: item.path, Reason: "too_many_files"})
			continue
		}
		if item.kind != "blob" || item.mode == "120000" {
			snapshot.Excluded = append(snapshot.Excluded, Exclusion{Path: item.path, Reason: symlinkOrModuleReason(item)})
			continue
		}
		content, err := gitBlob(ctx, root, item.object)
		if err != nil {
			snapshot.Excluded = append(snapshot.Excluded, Exclusion{Path: item.path, Reason: "unreadable_blob"})
			continue
		}
		if int64(len(content)) > limits.MaxFileBytes {
			snapshot.Excluded = append(snapshot.Excluded, Exclusion{Path: item.path, Reason: "oversized_file"})
			continue
		}
		if idx := bytes.IndexByte(content, 0); idx >= 0 {
			snapshot.Excluded = append(snapshot.Excluded, Exclusion{Path: item.path, Reason: "binary"})
			continue
		}
		if !utf8.Valid(content) {
			snapshot.Excluded = append(snapshot.Excluded, Exclusion{Path: item.path, Reason: "invalid_utf8"})
			continue
		}
		if reason, secret := scanSecrets(string(content)); secret {
			snapshot.Excluded = append(snapshot.Excluded, Exclusion{Path: item.path, Reason: reason})
			continue
		}
		if acceptedBytes+int64(len(content)) > limits.MaxTotalBytes {
			snapshot.Excluded = append(snapshot.Excluded, Exclusion{Path: item.path, Reason: "oversized_total"})
			continue
		}
		sum := sha256.Sum256(content)
		snapshot.Entries = append(snapshot.Entries, CollectedEntry{
			Path:       item.path,
			GitMode:    item.mode,
			Language:   language,
			Capability: capability,
			BlobSHA256: hex.EncodeToString(sum[:]),
			ByteCount:  int64(len(content)),
			Content:    content,
		})
		acceptedCount++
		acceptedBytes += int64(len(content))
	}

	sort.Slice(snapshot.Entries, func(i, j int) bool {
		return snapshot.Entries[i].Path < snapshot.Entries[j].Path
	})
	snapshot.TotalBytes = acceptedBytes
	snapshot.ManifestSHA256 = manifestHash(snapshot.Entries)
	return snapshot, nil
}

// manifestHash implements the canonical manifest both Go and Memory agree
// on: one tab-separated line per entry, sorted by path, hashed with SHA-256.
func manifestHash(entries []CollectedEntry) string {
	hasher := sha256.New()
	for _, entry := range entries {
		fmt.Fprintf(hasher, "%s\t%s\t%s\t%s\t%s\t%d\n",
			entry.Path, entry.GitMode, entry.Language, entry.Capability,
			entry.BlobSHA256, entry.ByteCount)
	}
	return hex.EncodeToString(hasher.Sum(nil))
}

type treeItem struct {
	mode   string
	kind   string
	object string
	path   string
}

func listTree(ctx context.Context, root string) ([]treeItem, error) {
	raw, err := gitBytes(ctx, root, "ls-tree", "-r", "-z", "--long", "HEAD")
	if err != nil {
		return nil, err
	}
	var items []treeItem
	for _, record := range bytes.Split(raw, []byte{0}) {
		if len(record) == 0 {
			continue
		}
		tab := bytes.IndexByte(record, '\t')
		if tab < 0 {
			return nil, errors.New("malformed ls-tree record")
		}
		meta := strings.Fields(string(record[:tab]))
		itemPath := string(record[tab+1:])
		if len(meta) != 4 {
			return nil, errors.New("malformed ls-tree metadata")
		}
		items = append(items, treeItem{mode: meta[0], kind: meta[1], object: meta[2], path: itemPath})
	}
	return items, nil
}

func requireClean(ctx context.Context, root string) error {
	raw, err := gitBytes(ctx, root, "status", "--porcelain=v2", "--untracked-files=all")
	if err != nil {
		return codeErr("status_unreadable")
	}
	scanner := bufio.NewScanner(bytes.NewReader(raw))
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			continue
		}
		// Untracked ('?') and ignored ('!') entries never gate commit-mode
		// sync: they are simply never read from HEAD.
		if strings.HasPrefix(line, "?") || strings.HasPrefix(line, "!") {
			continue
		}
		switch {
		case strings.HasPrefix(line, "1 "), strings.HasPrefix(line, "2 "), strings.HasPrefix(line, "u "):
			if strings.HasPrefix(line, "u ") {
				return codeErr("dirty_conflict")
			}
			// The XY staged/worktree pair is the second whitespace field.
			xy := strings.Fields(line)
			if len(xy) > 1 && len(xy[1]) >= 2 {
				if xy[1][0] != '.' {
					return codeErr("dirty_index")
				}
				return codeErr("dirty_worktree")
			}
			return codeErr("dirty_worktree")
		default:
			return codeErr("dirty_worktree")
		}
	}
	return scanner.Err()
}

func gitText(ctx context.Context, dir string, args ...string) (string, error) {
	out, err := gitBytes(ctx, dir, args...)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

func gitBytes(ctx context.Context, dir string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, gitTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", append([]string{"-C", dir}, args...)...)
	cmd.Env = append(os.Environ(), "GIT_OPTIONAL_LOCKS=0", "GIT_TERMINAL_PROMPT=0")
	var stdout bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = io.Discard
	if err := cmd.Run(); err != nil {
		return nil, err
	}
	return stdout.Bytes(), nil
}

func gitBlob(ctx context.Context, root, object string) ([]byte, error) {
	return gitBytes(ctx, root, "cat-file", "blob", object)
}

func symlinkOrModuleReason(item treeItem) string {
	if item.mode == "120000" {
		return "symlink"
	}
	if item.mode == "160000" {
		return "submodule"
	}
	return "unsupported_entry"
}

// applyRepositoryIdentity derives the installation-scoped key from Git
// metadata only. A repository without a network origin falls back to a
// path-free root-commit identity — never the local checkout path.
func applyRepositoryIdentity(ctx context.Context, root string, snapshot *Snapshot) {
	if observation, ok := repositoryidentity.Resolve(ctx, root); ok {
		snapshot.RepositoryKey = observation.RepositoryID
		if remote, err := gitText(ctx, root, "remote", "get-url", "origin"); err == nil && remote != "" {
			if sanitized, valid := repositoryidentity.CredentialFreeRemote(remote); valid {
				snapshot.CanonicalRemote = sanitized
			}
		}
		return
	}
	rootCommit, err := gitText(ctx, root, "rev-list", "--max-parents=0", "HEAD")
	if err == nil && rootCommit != "" {
		snapshot.RepositoryKey = "local:" + rootCommit
		return
	}
	snapshot.RepositoryKey = "local:unknown"
}

// languageFor implements the frozen capability matrix (ADR-0006 §3).
func languageFor(filePath string) (capability, language string, ok bool) {
	base := path.Base(filePath)
	switch strings.ToLower(path.Ext(base)) {
	case ".ts", ".mts", ".cts":
		return "symbols_and_edges", "typescript", true
	case ".tsx":
		return "symbols_and_edges", "tsx", true
	case ".js", ".mjs", ".cjs":
		return "symbols_and_edges", "javascript", true
	case ".jsx":
		return "symbols_and_edges", "jsx", true
	case ".md":
		return "file_only", "markdown", true
	case ".json":
		return "file_only", "json", true
	case ".yaml", ".yml":
		return "file_only", "yaml", true
	case ".sql":
		return "file_only", "sql", true
	case ".sh":
		return "file_only", "shell", true
	case ".go":
		return "file_only", "go", true
	}
	if base == "go.mod" || base == "go.sum" {
		return "file_only", "go", true
	}
	return "", "", false
}

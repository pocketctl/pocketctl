package teamcode

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/pocketctl/pocketctl/internal/protocol"
	"github.com/pocketctl/pocketctl/internal/sessiondocument"
)

const BundleID = "team-code-bundle"
const ManifestID = "team-code-manifest"
const BundleMIME = "application/x-git-bundle"
const maxBundle = 2 << 20

type Manifest struct {
	Scope      *protocol.TeamCodeStep `json:"scope"`
	Repository string                 `json:"repository"`
	Base       string                 `json:"base_sha"`
	Head       string                 `json:"head_sha"`
	Call       string                 `json:"source_call_id"`
	Attempt    string                 `json:"attempt_id"`
	SHA256     string                 `json:"bundle_sha256"`
	Bytes      int                    `json:"bundle_bytes"`
}
type source struct {
	Step       string                          `json:"step_id"`
	Call       string                          `json:"source_call_id"`
	Attempt    string                          `json:"attempt_id"`
	Submission string                          `json:"submission_id"`
	Head       string                          `json:"code_revision"`
	Code       *protocol.TeamCodeStep          `json:"code"`
	Artifacts  []protocol.TeamDeliveryArtifact `json:"artifacts"`
}

func digest(data []byte) string { return fmt.Sprintf("%x", sha256.Sum256(data)) }

// Validate every introduced commit, including changes subsequently reverted.
func safeTreePath(name string) bool {
	if !utf8.ValidString(name) || len(name) > 4096 || strings.Contains(name, "\\") || strings.IndexFunc(name, unicode.IsControl) >= 0 {
		return false
	}
	for _, part := range strings.Split(strings.ToLower(name), "/") {
		if part == "" || part == "." || part == ".." || part == ".git" || strings.HasPrefix(part, ".pocketctl") {
			return false
		}
	}
	return true
}
func checkHistory(ctx context.Context, dir, base, head string, paths []string) error {
	if !sha.MatchString(base) || !sha.MatchString(head) {
		return fmt.Errorf("invalid code SHA")
	}
	if _, err := git(ctx, dir, "merge-base", "--is-ancestor", base, head); err != nil {
		return fmt.Errorf("code head does not descend from base")
	}
	revs, err := git(ctx, dir, "rev-list", "--max-count=1025", base+".."+head)
	if err != nil {
		return err
	}
	commits := strings.Fields(string(revs))
	if len(commits) > 1024 {
		return fmt.Errorf("code history exceeds 1024 commits")
	}
	for _, rev := range commits {
		if _, err := git(ctx, dir, "merge-base", "--is-ancestor", base, rev); err != nil {
			return fmt.Errorf("code history contains unrelated ancestry")
		}
		changes, err := git(ctx, dir, "diff-tree", "--no-commit-id", "--raw", "--no-renames", "-m", "-r", "-z", rev)
		if err != nil {
			return err
		}
		entries := bytes.Split(changes, []byte{0})
		for i := 0; i+1 < len(entries); i += 2 {
			fields := strings.Fields(string(entries[i]))
			name := string(entries[i+1])
			if len(fields) != 5 || !safeTreePath(name) || !covered(paths, name) {
				return fmt.Errorf("code path outside grant: %q", name)
			}
			for _, mode := range []string{strings.TrimPrefix(fields[0], ":"), fields[1]} {
				if mode != "000000" && mode != "100644" && mode != "100755" {
					return fmt.Errorf("unsupported Git entry: %q", name)
				}
			}
		}
	}
	return nil
}

// Prepare uses a new repository in the attempt directory and never writes to the owner's checkout.
// Export operates on the isolated attempt repository. Reject redirections and
// user-defined Git commands before invoking repository-aware plumbing.
func checkRepository(ctx context.Context, dir string) error {
	root, e := filepath.EvalSymlinks(dir)
	if e != nil {
		return e
	}
	metadata := filepath.Join(root, ".git")
	canonical, e := filepath.EvalSymlinks(metadata)
	if e != nil || canonical != metadata {
		return fmt.Errorf("code workspace Git directory changed")
	}
	for _, f := range []string{"commondir", "objects/info/alternates", "objects/info/http-alternates", "info/grafts", "shallow"} {
		if _, e := os.Lstat(filepath.Join(metadata, f)); !errors.Is(e, os.ErrNotExist) {
			return fmt.Errorf("unsupported Git metadata %s", f)
		}
	}
	if e := filepath.WalkDir(metadata, func(_ string, entry fs.DirEntry, e error) error {
		if e != nil {
			return e
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("symlink in Git metadata")
		}
		return ctx.Err()
	}); e != nil {
		return e
	}
	names, e := git(ctx, dir, "config", "--no-includes", "--file", filepath.Join(metadata, "config"), "--name-only", "--list")
	if e != nil {
		return e
	}
	for _, name := range strings.Fields(string(names)) {
		switch name {
		case "core.repositoryformatversion", "core.filemode", "core.bare", "core.logallrefupdates", "core.ignorecase", "core.precomposeunicode", "core.symlinks", "user.name", "user.email":
		default:
			return fmt.Errorf("unsupported code workspace Git config: %s", name)
		}
	}
	return nil
}
func Head(ctx context.Context, dir string) (string, error) {
	if e := checkRepository(ctx, dir); e != nil {
		return "", e
	}
	raw, e := git(ctx, dir, "rev-parse", "HEAD")
	if e != nil {
		return "", e
	}
	head := strings.TrimSpace(string(raw))
	if !sha.MatchString(head) {
		return "", fmt.Errorf("invalid Git HEAD")
	}
	return head, nil
}
func CheckPrepared(ctx context.Context, dir, prepared, kind string) error {
	head, e := Head(ctx, dir)
	if e != nil {
		return e
	}
	if !sha.MatchString(prepared) || kind == "verify" && prepared != head {
		return fmt.Errorf("code differs from the prepared revision")
	}
	_, e = git(ctx, dir, "merge-base", "--is-ancestor", prepared, head)
	return e
}
func Prepare(ctx context.Context, dir, repo string, a *protocol.CollaborationAuthorization) error {
	c := a.Delivery.Code
	if rel, e := filepath.Rel(repo, dir); e != nil || !filepath.IsAbs(dir) || rel == "." || rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return fmt.Errorf("configure a daemon workspace root outside the granted repository")
	}
	prefix := ".pocketctl-inputs/" + digest([]byte(a.CallID)) + "/"
	raw, err := sessiondocument.ReadExplicitArtifact(dir, prefix+"inputs.json", 512<<10)
	if err != nil {
		return err
	}
	var local struct {
		InputHash string   `json:"input_hash"`
		Call      string   `json:"call_id"`
		Attempt   string   `json:"attempt_id"`
		Sources   []source `json:"inputs"`
	}
	if json.Unmarshal(raw, &local) != nil || local.Call != a.CallID || local.Attempt != a.Delivery.AttemptID || local.Sources == nil {
		return fmt.Errorf("code input identity mismatch")
	}
	if c.InputHash != "" {
		if c.InputHash != local.InputHash || len(c.Upstream) != len(local.Sources) {
			return fmt.Errorf("code input hash or count differs from reservation")
		}
		for i, ref := range c.Upstream {
			up := local.Sources[i]
			if ref.StepID != up.Step || ref.AttemptID != up.Attempt || ref.SubmissionID != up.Submission {
				return fmt.Errorf("code input selection differs from reservation")
			}
		}
	}
	if _, e := os.Lstat(filepath.Join(dir, ".git")); !errors.Is(e, os.ErrNotExist) {
		return fmt.Errorf("code attempt already initialized")
	}
	if _, err = git(ctx, dir, "init", "--quiet", "--template="); err != nil {
		return err
	}
	if _, err = git(ctx, dir, "fetch", "--no-tags", "--no-recurse-submodules", "--", repo, c.BaseSHA); err != nil {
		return err
	}
	if _, err = git(ctx, dir, "checkout", "--detach", c.BaseSHA); err != nil {
		return err
	}
	if c.Kind == "develop" {
		return nil
	}
	if len(local.Sources) == 0 || c.Kind == "verify" && len(local.Sources) != 1 {
		return fmt.Errorf("code step input count invalid")
	}
	temp, err := os.MkdirTemp("", "pocketctl-code-import-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(temp)
	for _, s := range local.Sources {
		if s.Code == nil || s.Code.Repository != c.Repository || s.Code.BaseSHA != c.BaseSHA || !sha.MatchString(s.Head) {
			return fmt.Errorf("upstream repository or baseline mismatch")
		}
		read := func(id string) ([]byte, error) {
			for _, f := range s.Artifacts {
				if f.ID == id {
					key := s.Attempt + "/" + s.Submission + "/" + id
					b, e := sessiondocument.ReadExplicitArtifact(dir, prefix+"files/"+digest([]byte(key)), maxBundle)
					if e == nil && len(b) == f.ByteSize && digest(b) == f.SHA256 {
						return b, nil
					}
					break
				}
			}
			return nil, fmt.Errorf("invalid upstream artifact %s", id)
		}
		info, e := read(ManifestID)
		if e != nil {
			return e
		}
		bundle, e := read(BundleID)
		if e != nil {
			return e
		}
		var m Manifest
		if json.Unmarshal(info, &m) != nil || m.Scope == nil || m.Scope.GrantRevision != s.Code.GrantRevision || m.Scope.Repository != s.Code.Repository || m.Repository != c.Repository || m.Base != c.BaseSHA || m.Head != s.Head || m.Attempt != s.Attempt || m.Call != s.Call || m.Bytes != len(bundle) || m.SHA256 != digest(bundle) {
			return fmt.Errorf("invalid upstream Git manifest")
		}
		file := filepath.Join(temp, "upstream.bundle")
		if e = os.WriteFile(file, bundle, 0600); e != nil {
			return e
		}
		heads, e := git(ctx, dir, "bundle", "list-heads", file)
		if e != nil || strings.TrimSpace(string(heads)) != s.Head+" HEAD" {
			return fmt.Errorf("unexpected bundle ref")
		}
		if _, e = git(ctx, dir, "bundle", "verify", file); e != nil {
			return e
		}
		if _, e = git(ctx, dir, "fetch", "--no-tags", "--no-recurse-submodules", file, "HEAD"); e != nil {
			return e
		}
		if e = checkHistory(ctx, dir, c.BaseSHA, s.Head, s.Code.Paths); e != nil {
			return e
		}
		if e = checkHistory(ctx, dir, c.BaseSHA, s.Head, c.Paths); e != nil {
			return fmt.Errorf("upstream changes exceed this machine's grant: %w", e)
		}
		if c.Kind == "verify" {
			_, e = git(ctx, dir, "checkout", "--detach", s.Head)
		} else {
			_, e = git(ctx, dir, "merge", "--no-ff", "--no-edit", s.Head)
		}
		if e != nil {
			paths, _ := git(ctx, dir, "diff", "--name-only", "--diff-filter=U")
			return fmt.Errorf("integrating submission %s: %w; conflicts: %.1024s", s.Submission, e, paths)
		}
	}
	return nil
}
func Export(ctx context.Context, dir string, a *protocol.CollaborationAuthorization) (Manifest, []byte, error) {
	var m Manifest
	if e := checkRepository(ctx, dir); e != nil {
		return m, nil, e
	}
	c := a.Delivery.Code
	state, e := git(ctx, dir, "status", "--porcelain=v1", "--untracked-files=all", "--", ".", ":(exclude).pocketctl-inputs", ":(exclude).pocketctl-deliveries")
	if e != nil || len(state) != 0 {
		return m, nil, fmt.Errorf("commit all code changes before publishing")
	}
	head, e := git(ctx, dir, "rev-parse", "HEAD")
	if e != nil {
		return m, nil, e
	}
	rev := strings.TrimSpace(string(head))
	if e = checkHistory(ctx, dir, c.BaseSHA, rev, c.Paths); e != nil {
		return m, nil, e
	}
	if rev == c.BaseSHA {
		return m, nil, fmt.Errorf("code attempt has no changes to deliver")
	}
	tmp, e := os.MkdirTemp("", "pocketctl-code-export-")
	if e != nil {
		return m, nil, e
	}
	defer os.RemoveAll(tmp)
	file := filepath.Join(tmp, "code.bundle")
	cmd := gitCommand(ctx, dir, "bundle", "create", "-", "HEAD", "^"+c.BaseSHA)
	pipe, e := cmd.StdoutPipe()
	if e != nil {
		return m, nil, e
	}
	if e = cmd.Start(); e != nil {
		return m, nil, e
	}
	b, readErr := io.ReadAll(io.LimitReader(pipe, maxBundle+1))
	if len(b) > maxBundle || readErr != nil {
		_ = cmd.Process.Kill()
	}
	_ = pipe.Close()
	waitErr := cmd.Wait()
	if len(b) > maxBundle {
		return m, nil, fmt.Errorf("Git bundle exceeds 2 MiB: %w", sessiondocument.ErrArtifactTooLarge)
	}
	if readErr != nil {
		return m, nil, readErr
	}
	if waitErr != nil {
		return m, nil, fmt.Errorf("creating Git bundle: %w", waitErr)
	}
	if e = os.WriteFile(file, b, 0600); e != nil {
		return m, nil, e
	}
	heads, e := git(ctx, dir, "bundle", "list-heads", file)
	if e != nil || strings.TrimSpace(string(heads)) != rev+" HEAD" {
		return m, nil, fmt.Errorf("code head changed during export")
	}
	m = Manifest{Scope: c, Repository: c.Repository, Base: c.BaseSHA, Head: rev, Call: a.CallID, Attempt: a.Delivery.AttemptID, SHA256: digest(b), Bytes: len(b)}
	return m, b, nil
}

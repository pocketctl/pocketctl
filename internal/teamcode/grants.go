// Package teamcode binds Team code attempts to repositories granted by the local machine owner.
package teamcode

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"strings"

	"github.com/pocketctl/pocketctl/internal/config"
	"github.com/pocketctl/pocketctl/internal/protocol"
	"github.com/pocketctl/pocketctl/internal/sessiondocument"
)

type localGrant struct {
	RequireSandbox bool `json:"require_sandbox,omitempty"`
	protocol.TeamCodeGrant
	Provider  string `json:"provider"`
	Directory string `json:"directory"`
}

var sha = regexp.MustCompile("^[0-9a-f]{40}$")
var token = regexp.MustCompile("^[A-Za-z0-9._/-]{1,160}$")
var toolName = regexp.MustCompile("^[A-Za-z0-9_-]{1,40}$")

func safePath(s string) bool {
	if !token.MatchString(s) {
		return false
	}
	for _, part := range strings.Split(strings.ToLower(s), "/") {
		if part == "" || part == "." || part == ".." || part == ".git" || strings.HasPrefix(part, ".pocketctl") {
			return false
		}
	}
	return true
}
func covered(paths []string, name string) bool {
	for _, p := range paths {
		if name == p || strings.HasPrefix(name, p+"/") {
			return true
		}
	}
	return false
}

func grants(ctx context.Context, provider string, allows func(string) error) []localGrant {
	home, err := config.HomeDir()
	if err != nil {
		return nil
	}
	return readGrants(ctx, filepath.Join(home, ".pocketctl", "team-code-workspaces.json"), provider, allows)
}

func readGrants(ctx context.Context, path, provider string, allows func(string) error) []localGrant {
	fi, err := os.Lstat(path)
	if err != nil || !fi.Mode().IsRegular() || fi.Mode().Perm()&0077 != 0 {
		return nil
	}
	data, err := sessiondocument.ReadExplicitArtifact(filepath.Dir(path), filepath.Base(path), 128*1024)
	if err != nil {
		return nil
	}
	var entries []localGrant
	if json.Unmarshal(data, &entries) != nil || len(entries) > 64 {
		return nil
	}
	var result []localGrant
	for _, g := range entries {
		if g.RequireSandbox && provider != "codex" {
			continue
		}
		if g.Provider != provider || g.TeamID == "" || g.OfferID == "" || !safePath(g.Repository) || !sha.MatchString(g.BaseSHA) || len(g.Paths) == 0 || len(g.Paths) > 32 || len(g.Tools) > 16 || !filepath.IsAbs(g.Directory) {
			continue
		}
		root, err := filepath.EvalSymlinks(g.Directory)
		if err != nil || root != g.Directory || allows(root) != nil {
			continue
		}
		valid := true
		for _, p := range g.Paths {
			valid = valid && safePath(p)
		}
		toolState := map[string]string{}
		for _, t := range g.Tools {
			executable, e := exec.LookPath(t)
			valid = valid && toolName.MatchString(t) && e == nil
			if valid {
				binary, err := os.Stat(executable)
				if err != nil {
					valid = false
					continue
				}
				toolState[t] = fmt.Sprintf("%s/%d/%d", executable, binary.Size(), binary.ModTime().UnixNano())
			}
			if t == "xcodebuild" && valid {
				version, e := exec.CommandContext(ctx, "xcodebuild", "-version").Output()
				valid = e == nil && bytes.HasPrefix(version, []byte("Xcode "))
				toolState[t] += string(version)
			}
		}
		if !valid {
			continue
		}
		top, err := git(ctx, root, "rev-parse", "--show-toplevel")
		if err != nil || strings.TrimSpace(string(top)) != root {
			continue
		}
		if _, err := git(ctx, root, "cat-file", "-e", g.BaseSHA+"^{commit}"); err != nil {
			continue
		}
		slices.Sort(g.Paths)
		slices.Sort(g.Tools)
		g.GrantRevision = ""
		canonical, _ := json.Marshal([]any{g, runtime.GOOS, runtime.GOARCH, toolState})
		g.GrantRevision = fmt.Sprintf("%x", sha256.Sum256(canonical))
		result = append(result, g)
	}
	return result
}
func Inventory(ctx context.Context, provider string, allows func(string) error) []protocol.TeamCodeGrant {
	var result []protocol.TeamCodeGrant
	for _, g := range grants(ctx, provider, allows) {
		result = append(result, g.TeamCodeGrant)
	}
	return result
}
func Resolve(ctx context.Context, provider string, a *protocol.CollaborationAuthorization, allows func(string) error) (string, error) {
	c := a.Delivery.Code
	if len(c.InputHash) != 64 || strings.Trim(c.InputHash, "0123456789abcdef") != "" || c.LeaseGeneration < 1 || !protocol.ValidTeamDeliveryAttemptID(a.Delivery.AttemptID) || a.Delivery.AttemptID == "" || !slices.Contains([]string{"develop", "merge", "verify"}, c.Kind) || len(c.Paths) == 0 {
		return "", fmt.Errorf("invalid code attempt")
	}
	for _, g := range grants(ctx, provider, allows) {
		if g.TeamID != c.TeamID || g.OfferID != a.OfferID || g.Repository != c.Repository || g.BaseSHA != c.BaseSHA || g.GrantRevision != c.GrantRevision {
			continue
		}
		valid := true
		for _, p := range c.Paths {
			valid = valid && safePath(p) && covered(g.Paths, p)
		}
		for _, t := range c.Tools {
			valid = valid && slices.Contains(g.Tools, t)
		}
		if valid {
			return g.Directory, nil
		}
	}
	return "", fmt.Errorf("team_code_grant_unavailable")
}

func gitCommand(ctx context.Context, dir string, args ...string) *exec.Cmd {
	options := []string{"-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "protocol.allow=never", "-c", "protocol.file.allow=always", "-c", "user.name=PocketCtl Team", "-c", "user.email=team@localhost", "-c", "commit.gpgSign=false", "-C", dir}
	cmd := exec.CommandContext(ctx, "git", append(options, args...)...)
	cmd.Env = []string{"PATH=" + os.Getenv("PATH"), "LC_ALL=C", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1", "GIT_TERMINAL_PROMPT=0", "GIT_NO_REPLACE_OBJECTS=1", "GIT_ATTR_NOSYSTEM=1"}
	return cmd
}

func git(ctx context.Context, dir string, args ...string) ([]byte, error) {
	cmd := gitCommand(ctx, dir, args...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, e := cmd.Output()
	if e != nil {
		return nil, fmt.Errorf("git %s: %.1024s: %w", args[0], stderr.String(), e)
	}
	return out, nil
}

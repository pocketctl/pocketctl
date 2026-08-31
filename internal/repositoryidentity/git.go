package repositoryidentity

import (
	"context"
	"net/url"
	"os"
	"os/exec"
	"path"
	"strings"
	"time"
)

const resolveTimeout = 200 * time.Millisecond

// Observation is an explicit repository fact read from Git metadata. It never
// derives identity from the cwd or repository directory name.
type Observation struct {
	RepositoryID string
	Branch       string
	CommitSHA    string
}

// Resolve reads origin from the Git repository containing cwd and converts it
// to a credential-free host/path identity. Repositories without a network
// origin remain unknown instead of falling back to an absolute path.
func Resolve(parent context.Context, cwd string) (Observation, bool) {
	if strings.TrimSpace(cwd) == "" {
		return Observation{}, false
	}
	ctx, cancel := context.WithTimeout(parent, resolveTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", "-C", cwd, "remote", "get-url", "origin")
	cmd.Env = append(os.Environ(), "GIT_OPTIONAL_LOCKS=0", "GIT_TERMINAL_PROMPT=0")
	output, err := cmd.Output()
	if err != nil {
		return Observation{}, false
	}
	repositoryID, ok := canonicalRemote(string(output))
	if !ok {
		return Observation{}, false
	}
	branch, _ := gitOutput(ctx, cwd, "symbolic-ref", "--quiet", "--short", "HEAD")
	commitSHA, _ := gitOutput(ctx, cwd, "rev-parse", "--verify", "HEAD")
	return Observation{
		RepositoryID: repositoryID,
		Branch:       strings.TrimSpace(branch),
		CommitSHA:    strings.TrimSpace(commitSHA),
	}, true
}

func gitOutput(ctx context.Context, cwd string, args ...string) (string, error) {
	gitArgs := append([]string{"-C", cwd}, args...)
	cmd := exec.CommandContext(ctx, "git", gitArgs...)
	cmd.Env = append(os.Environ(), "GIT_OPTIONAL_LOCKS=0", "GIT_TERMINAL_PROMPT=0")
	output, err := cmd.Output()
	return string(output), err
}

func canonicalRemote(raw string) (string, bool) {
	remote := strings.TrimSpace(raw)
	if remote == "" {
		return "", false
	}

	var host, repoPath string
	if strings.Contains(remote, "://") {
		parsed, err := url.Parse(remote)
		if err != nil || parsed.Hostname() == "" || parsed.Scheme == "file" {
			return "", false
		}
		host = strings.ToLower(parsed.Hostname())
		if port := parsed.Port(); port != "" {
			host += ":" + port
		}
		repoPath = parsed.EscapedPath()
		if decoded, err := url.PathUnescape(repoPath); err == nil {
			repoPath = decoded
		}
	} else {
		colon := strings.IndexByte(remote, ':')
		if colon <= 0 || strings.Contains(remote[:colon], "/") {
			return "", false
		}
		hostPart := remote[:colon]
		if at := strings.LastIndexByte(hostPart, '@'); at >= 0 {
			hostPart = hostPart[at+1:]
		}
		host = strings.ToLower(strings.TrimSpace(hostPart))
		repoPath = remote[colon+1:]
	}

	rawSegments := strings.Split(strings.Trim(repoPath, "/"), "/")
	for _, segment := range rawSegments {
		if segment == "" || segment == "." || segment == ".." {
			return "", false
		}
	}
	repoPath = strings.TrimSuffix(strings.Trim(path.Clean("/"+repoPath), "/"), ".git")
	if host == "" || repoPath == "" || repoPath == "." {
		return "", false
	}
	identity := host + "/" + repoPath
	if len(identity) > 512 {
		return "", false
	}
	return identity, true
}

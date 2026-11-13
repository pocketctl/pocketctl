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
	return resolve(parent, cwd, gitOutput)
}

func resolve(parent context.Context, cwd string, readGit func(context.Context, string, ...string) (string, error)) (Observation, bool) {
	if strings.TrimSpace(cwd) == "" {
		return Observation{}, false
	}
	ctx, cancel := context.WithTimeout(parent, resolveTimeout)
	defer cancel()
	// Each read is independent. Use the same deadline for all three so a slow
	// remote or branch lookup cannot starve the commit lookup.
	start := func(args ...string) <-chan string {
		result := make(chan string, 1)
		go func() {
			value, err := readGit(ctx, cwd, args...)
			if err != nil {
				value = ""
			}
			result <- strings.TrimSpace(value)
		}()
		return result
	}
	receive := func(result <-chan string) string {
		select {
		case value := <-result:
			return value
		case <-ctx.Done():
			select {
			case value := <-result:
				return value
			default:
				return ""
			}
		}
	}
	remote := start("remote", "get-url", "origin")
	branch := start("symbolic-ref", "--quiet", "--short", "HEAD")
	commit := start("rev-parse", "--verify", "HEAD")
	repositoryID, ok := canonicalRemote(receive(remote))
	if !ok {
		return Observation{}, false
	}
	return Observation{
		RepositoryID: repositoryID,
		Branch:       receive(branch),
		CommitSHA:    receive(commit),
	}, true
}

func gitOutput(ctx context.Context, cwd string, args ...string) (string, error) {
	gitArgs := append([]string{"-C", cwd}, args...)
	cmd := exec.CommandContext(ctx, "git", gitArgs...)
	cmd.WaitDelay = 25 * time.Millisecond
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

// CredentialFreeRemote preserves a usable network remote while removing
// transport credentials and URL query/fragment material. The same validation
// as repository identity derivation applies, so local and ambiguous remotes
// are rejected rather than persisted.
func CredentialFreeRemote(raw string) (string, bool) {
	remote := strings.TrimSpace(raw)
	if _, ok := canonicalRemote(remote); !ok {
		return "", false
	}
	if strings.Contains(remote, "://") {
		parsed, err := url.Parse(remote)
		if err != nil {
			return "", false
		}
		parsed.User = nil
		parsed.RawQuery = ""
		parsed.ForceQuery = false
		parsed.Fragment = ""
		return parsed.String(), true
	}
	colon := strings.IndexByte(remote, ':')
	hostPart := remote[:colon]
	if at := strings.LastIndexByte(hostPart, '@'); at >= 0 {
		hostPart = hostPart[at+1:]
	}
	return hostPart + remote[colon:], true
}

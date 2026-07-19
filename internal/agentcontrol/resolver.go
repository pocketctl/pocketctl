package agentcontrol

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/pocketctl/pocketctl/internal/discovery"
)

var (
	ErrOpenCodeNotFound       = errors.New("opencode binary not found")
	ErrOpenCodeNotExecutable  = errors.New("opencode binary is not executable")
	ErrOpenCodeVersion        = errors.New("opencode version could not be detected")
	ErrOpenCodeVersionTimeout = errors.New("opencode version check timed out")
	ErrCodexNotFound          = errors.New("codex binary not found")
	ErrCodexVersion           = errors.New("codex version could not be detected")
	ErrCodexVersionTimeout    = errors.New("codex version check timed out")
)

var openCodeVersionRE = regexp.MustCompile(`\d+\.\d+(?:\.\d+)?`)

const minimumManagedOpenCodeVersion = "1.17.11"
const minimumManagedCodexVersion = "0.144.1"

func SupportsManagedOpenCodeVersion(version string) bool {
	return versionAtLeast(version, minimumManagedOpenCodeVersion)
}

func SupportsManagedCodexVersion(version string) bool {
	return versionAtLeast(version, minimumManagedCodexVersion)
}

func versionAtLeast(version, minimumVersion string) bool {
	parse := func(value string) ([3]int, bool) {
		var parsed [3]int
		value = strings.TrimPrefix(strings.TrimSpace(value), "v")
		if cut := strings.IndexAny(value, "-+"); cut >= 0 {
			value = value[:cut]
		}
		parts := strings.Split(value, ".")
		if len(parts) < 2 || len(parts) > 3 {
			return parsed, false
		}
		for i, part := range parts {
			n, err := strconv.Atoi(part)
			if err != nil || n < 0 {
				return parsed, false
			}
			parsed[i] = n
		}
		return parsed, true
	}
	got, ok := parse(version)
	if !ok {
		return false
	}
	minimum, _ := parse(minimumVersion)
	for i := range got {
		if got[i] != minimum[i] {
			return got[i] > minimum[i]
		}
	}
	return true
}

type BinaryResolver struct {
	Timeout      time.Duration
	ResolveAgent func(string, ...string) (string, bool, bool)
	RunVersion   func(context.Context, string) (string, error)
}

func NewBinaryResolver() BinaryResolver {
	return BinaryResolver{
		Timeout:      2 * time.Second,
		ResolveAgent: discovery.ResolveAgentExcluding,
		RunVersion: func(ctx context.Context, path string) (string, error) {
			out, err := exec.CommandContext(ctx, path, "--version").CombinedOutput()
			return strings.TrimSpace(string(out)), err
		},
	}
}

func ResolveConfiguredOpenCode() (string, string, error) {
	cfg, err := LoadConfig()
	if err != nil {
		return "", "", err
	}
	return NewBinaryResolver().ResolveOpenCode(cfg.OpenCode)
}

func ResolveConfiguredCodex() (string, string, error) {
	cfg, err := LoadConfig()
	if err != nil {
		return "", "", err
	}
	return NewBinaryResolver().ResolveCodex(cfg.Codex)
}

func (r BinaryResolver) ResolveOpenCode(cfg AgentConfig, excluded ...string) (string, string, error) {
	return r.resolve(AgentOpenCode, cfg, ErrOpenCodeNotFound, ErrOpenCodeVersion, ErrOpenCodeVersionTimeout, defaultOpenCodeShimPath(), excluded...)
}

func (r BinaryResolver) ResolveCodex(cfg AgentConfig, excluded ...string) (string, string, error) {
	return r.resolve(AgentCodex, cfg, ErrCodexNotFound, ErrCodexVersion, ErrCodexVersionTimeout, defaultCodexShimPath(), excluded...)
}

func (r BinaryResolver) resolve(agent string, cfg AgentConfig, notFound, versionError, timeoutError error, defaultShim string, excluded ...string) (string, string, error) {
	r = r.withDefaults()
	excluded = append(excluded, cfg.ShimPath, defaultShim)

	var storedErr error
	if cfg.RealBinary != "" {
		if path, version, err := r.validate(cfg.RealBinary, excluded, notFound, versionError, timeoutError); err == nil {
			return path, version, nil
		} else {
			storedErr = err
		}
	}

	path, _, found := r.ResolveAgent(agent, compactPaths(excluded)...)
	if !found {
		if storedErr != nil && !errors.Is(storedErr, notFound) {
			return "", "", storedErr
		}
		return "", "", notFound
	}
	resolved, version, err := r.validate(path, excluded, notFound, versionError, timeoutError)
	if err != nil {
		return "", "", err
	}
	return resolved, version, nil
}

func (r BinaryResolver) withDefaults() BinaryResolver {
	defaults := NewBinaryResolver()
	if r.Timeout <= 0 {
		r.Timeout = defaults.Timeout
	}
	if r.ResolveAgent == nil {
		r.ResolveAgent = defaults.ResolveAgent
	}
	if r.RunVersion == nil {
		r.RunVersion = defaults.RunVersion
	}
	return r
}

func (r BinaryResolver) validate(path string, excluded []string, notFound, versionError, timeoutError error) (string, string, error) {
	resolved, info, err := inspectExecutable(path)
	if err != nil {
		if errors.Is(err, ErrOpenCodeNotFound) {
			return "", "", notFound
		}
		return "", "", err
	}
	for _, blocked := range excluded {
		blockedResolved, blockedInfo, blockedErr := inspectPath(blocked)
		if blockedErr == nil && (resolved == blockedResolved || os.SameFile(info, blockedInfo)) {
			return "", "", notFound
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), r.Timeout)
	defer cancel()
	out, err := r.RunVersion(ctx, resolved)
	if errors.Is(ctx.Err(), context.DeadlineExceeded) || errors.Is(err, context.DeadlineExceeded) {
		return "", "", timeoutError
	}
	if err != nil {
		return "", "", fmt.Errorf("%w: %v", versionError, err)
	}
	version := openCodeVersionRE.FindString(out)
	if version == "" {
		return "", "", versionError
	}
	return resolved, version, nil
}

func inspectExecutable(path string) (string, os.FileInfo, error) {
	resolved, info, err := inspectPath(path)
	if err != nil {
		return "", nil, ErrOpenCodeNotFound
	}
	if !info.Mode().IsRegular() {
		return "", nil, ErrOpenCodeNotExecutable
	}
	if runtime.GOOS != "windows" && info.Mode().Perm()&0o111 == 0 {
		return "", nil, ErrOpenCodeNotExecutable
	}
	return resolved, info, nil
}

func inspectPath(path string) (string, os.FileInfo, error) {
	if strings.TrimSpace(path) == "" {
		return "", nil, os.ErrNotExist
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", nil, err
	}
	resolved, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return "", nil, err
	}
	info, err := os.Stat(resolved)
	if err != nil {
		return "", nil, err
	}
	return resolved, info, nil
}

func defaultOpenCodeShimPath() string {
	return defaultShimPath(AgentOpenCode)
}

func defaultCodexShimPath() string {
	return defaultShimPath(AgentCodex)
}

func defaultShimPath(agent string) string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	name := agent
	if runtime.GOOS == "windows" {
		name += ".cmd"
	}
	return filepath.Join(home, ".pocketctl", "bin", name)
}

func compactPaths(paths []string) []string {
	out := make([]string, 0, len(paths))
	for _, path := range paths {
		if strings.TrimSpace(path) != "" {
			out = append(out, path)
		}
	}
	return out
}

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
)

var openCodeVersionRE = regexp.MustCompile(`\d+\.\d+(?:\.\d+)?`)

const minimumManagedOpenCodeVersion = "1.17.11"

func SupportsManagedOpenCodeVersion(version string) bool {
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
	minimum, _ := parse(minimumManagedOpenCodeVersion)
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

func (r BinaryResolver) ResolveOpenCode(cfg AgentConfig, excluded ...string) (string, string, error) {
	r = r.withDefaults()
	excluded = append(excluded, cfg.ShimPath, defaultOpenCodeShimPath())

	var storedErr error
	if cfg.RealBinary != "" {
		if path, version, err := r.validate(cfg.RealBinary, excluded); err == nil {
			return path, version, nil
		} else {
			storedErr = err
		}
	}

	path, _, found := r.ResolveAgent(AgentOpenCode, compactPaths(excluded)...)
	if !found {
		if storedErr != nil && !errors.Is(storedErr, ErrOpenCodeNotFound) {
			return "", "", storedErr
		}
		return "", "", ErrOpenCodeNotFound
	}
	resolved, version, err := r.validate(path, excluded)
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

func (r BinaryResolver) validate(path string, excluded []string) (string, string, error) {
	resolved, info, err := inspectExecutable(path)
	if err != nil {
		return "", "", err
	}
	for _, blocked := range excluded {
		blockedResolved, blockedInfo, blockedErr := inspectPath(blocked)
		if blockedErr == nil && (resolved == blockedResolved || os.SameFile(info, blockedInfo)) {
			return "", "", ErrOpenCodeNotFound
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), r.Timeout)
	defer cancel()
	out, err := r.RunVersion(ctx, resolved)
	if errors.Is(ctx.Err(), context.DeadlineExceeded) || errors.Is(err, context.DeadlineExceeded) {
		return "", "", ErrOpenCodeVersionTimeout
	}
	if err != nil {
		return "", "", fmt.Errorf("%w: %v", ErrOpenCodeVersion, err)
	}
	version := openCodeVersionRE.FindString(out)
	if version == "" {
		return "", "", ErrOpenCodeVersion
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
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	name := "opencode"
	if runtime.GOOS == "windows" {
		name = "opencode.cmd"
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

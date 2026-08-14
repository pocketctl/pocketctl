package discovery

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/config"
)

type AgentInfo struct {
	Type       string `json:"type"`
	CLIName    string `json:"cli_name"`
	Path       string `json:"path"`
	Version    string `json:"version,omitempty"`
	Latest     string `json:"latest,omitempty"`
	Manageable bool   `json:"manageable"`
}

// Known agents (CLI name, npm package, upgrade command) come from the adapter
// registry — the single source of truth. UpdateCmd is the agent's built-in
// upgrade command; empty means fall back to `npm install -g <package>@latest`.

var versionRe = regexp.MustCompile(`\d+\.\d+(?:\.\d+)?`)

const (
	versionProbeTimeout   = 3 * time.Second
	versionProbeWaitDelay = time.Second
)

func DiscoverAgents() []AgentInfo {
	var agents []AgentInfo
	for _, a := range adapter.All() {
		// Storage-discovered agents (zcode) are surfaced only when the user has
		// explicitly enabled the read-only sync AND the local store probe passes.
		// They have no CLI/npm metadata, are never manageable, and never trigger
		// npm version queries.
		if a.Discovery == adapter.DiscoveryStorage {
			if info, ok := discoverStorageAgent(a); ok {
				agents = append(agents, info)
			}
			continue
		}
		path, manageable, found := ResolveAgent(a.CLIName)
		if !found {
			continue
		}
		agents = append(agents, AgentInfo{
			Type:       a.Type,
			CLIName:    a.CLIName,
			Path:       path,
			Version:    detectVersion(path),
			Latest:     detectLatest(a.Package),
			Manageable: manageable,
		})
	}
	return agents
}

// candidatePaths 按"用户本地优先"返回 cliName 的候选可执行路径(去重保序)。
func candidatePaths(cliName, home, pathEnv, npmPrefix string) []string {
	var ordered []string

	extensions := platformExtensions()
	addPath := func(dir, name string) {
		for _, ext := range extensions {
			ordered = append(ordered, filepath.Join(dir, name+ext))
		}
	}

	if home != "" {
		addPath(filepath.Join(home, ".local", "bin"), cliName)
		addPath(filepath.Join(home, ".claude", "local"), cliName)
		// opencode self-installs here via `opencode upgrade` (takes priority over
		// the older npm-installed version that may exist at /opt/homebrew/bin).
		addPath(filepath.Join(home, ".opencode", "bin"), cliName)
	}
	if npmPrefix != "" {
		addPath(filepath.Join(npmPrefix, "bin"), cliName)
	}
	for _, dir := range filepath.SplitList(pathEnv) {
		if dir == "" {
			continue
		}
		addPath(dir, cliName)
	}
	seen := make(map[string]bool, len(ordered))
	var out []string
	for _, p := range ordered {
		if seen[p] {
			continue
		}
		seen[p] = true
		out = append(out, p)
	}
	return out
}

// resolveFrom 从有序候选中选择:优先第一个 manageable(owned)的;否则第一个存在的。
func resolveFrom(candidates []string, statReal func(string) (string, bool), ownedByUser func(string) bool) (string, bool, bool) {
	return resolveFromExcluding(candidates, statReal, ownedByUser, nil)
}

// resolveFromExcluding applies the normal ownership preference while skipping
// candidates whose path or resolved target matches an excluded path.
func resolveFromExcluding(candidates []string, statReal func(string) (string, bool), ownedByUser func(string) bool, excluded []string) (string, bool, bool) {
	excludedPaths := make(map[string]struct{}, len(excluded))
	for _, path := range excluded {
		if normalized := normalizePath(path); normalized != "" {
			excludedPaths[normalized] = struct{}{}
		}
	}
	firstPath := ""
	for _, c := range candidates {
		real, ok := statReal(c)
		if !ok {
			continue
		}
		if pathExcluded(c, real, excludedPaths) {
			continue
		}
		if firstPath == "" {
			firstPath = c
		}
		if ownedByUser(real) {
			return c, true, true
		}
	}
	if firstPath != "" {
		return firstPath, false, true
	}
	return "", false, false
}

func pathExcluded(candidate, real string, excluded map[string]struct{}) bool {
	_, candidateExcluded := excluded[normalizePath(candidate)]
	_, realExcluded := excluded[normalizePath(real)]
	return candidateExcluded || realExcluded
}

func normalizePath(path string) string {
	if strings.TrimSpace(path) == "" {
		return ""
	}
	abs, err := filepath.Abs(path)
	if err == nil {
		path = abs
	}
	if real, err := filepath.EvalSymlinks(path); err == nil {
		path = real
	}
	return filepath.Clean(path)
}

var (
	npmPrefixOnce  sync.Once
	npmPrefixValue string
)

// npmPrefix 返回 `npm config get prefix` 的结果,daemon 生命周期内只计算一次并缓存。
// ResolveAgent 现在每次会话启动都会调用,不能每次都付出 npm 子进程(最高 3s 超时)的代价。
func npmPrefix() string {
	npmPrefixOnce.Do(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if out, err := exec.CommandContext(ctx, "npm", "config", "get", "prefix").Output(); err == nil {
			npmPrefixValue = strings.TrimSpace(string(out))
		}
	})
	return npmPrefixValue
}

// ResolveAgent 定位 agent 可执行文件。found=false 表示未安装;
// manageable=true 表示真实二进制属当前 uid,可被就地升级。
func ResolveAgent(cliName string) (string, bool, bool) {
	return ResolveAgentExcluding(cliName)
}

// ResolveAgentExcluding locates an agent executable without returning a
// Pocketctl-owned shim (or any other explicitly excluded path/target).
func ResolveAgentExcluding(cliName string, excluded ...string) (string, bool, bool) {
	home, _ := config.HomeDir()
	cands := candidatePaths(cliName, home, os.Getenv("PATH"), npmPrefix())
	statReal := func(p string) (string, bool) {
		if _, err := os.Lstat(p); err != nil {
			return "", false
		}
		real, err := filepath.EvalSymlinks(p)
		if err != nil {
			return p, true // symlink 解析失败,退回原路径
		}
		return real, true
	}
	return resolveFromExcluding(cands, statReal, fileOwnedByCurrentUser, excluded)
}

// AgentUpgradeInfo returns the upgrade command and npm package for an agent type.
// updateCmd non-empty → run it directly; empty → run `npm install -g <package>@latest`.
func AgentUpgradeInfo(agentType string) (updateCmd, pkg string, err error) {
	if a, ok := adapter.Get(agentType); ok {
		return a.UpdateCmd, a.Package, nil
	}
	return "", "", fmt.Errorf("unknown agent type: %s", agentType)
}

func detectVersion(binPath string) string {
	ctx, cancel := context.WithTimeout(context.Background(), versionProbeTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, binPath, "--version")
	// A wrapper may leave a child holding stdout/stderr open after cancellation.
	// WaitDelay closes those pipes so discovery remains bounded instead of waiting
	// for an unrelated CLI child to exit.
	cmd.WaitDelay = versionProbeWaitDelay
	out, err := cmd.Output()
	if err != nil || len(out) == 0 {
		return ""
	}
	return versionRe.FindString(string(out))
}

// detectLatest queries the npm registry for the latest published version (5s timeout).
func detectLatest(pkg string) string {
	if pkg == "" {
		return ""
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "npm", "view", pkg, "version").Output()
	if err != nil || len(out) == 0 {
		return ""
	}
	return versionRe.FindString(string(out))
}

func AgentTypeToCLI(agentType string) (string, error) {
	if a, ok := adapter.Get(agentType); ok {
		return a.CLIName, nil
	}
	return "", fmt.Errorf("unknown agent type: %s", agentType)
}

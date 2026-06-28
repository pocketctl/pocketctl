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
	"syscall"
	"time"

	"github.com/pocketctl/pocketctl/internal/adapter"
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

func DiscoverAgents() []AgentInfo {
	var agents []AgentInfo
	for _, a := range adapter.All() {
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
	if home != "" {
		ordered = append(ordered,
			filepath.Join(home, ".local", "bin", cliName),
			filepath.Join(home, ".claude", "local", cliName),
			// opencode self-installs here via `opencode upgrade` (takes priority over
			// the older npm-installed version that may exist at /opt/homebrew/bin).
			filepath.Join(home, ".opencode", "bin", cliName),
		)
	}
	if npmPrefix != "" {
		ordered = append(ordered, filepath.Join(npmPrefix, "bin", cliName))
	}
	for _, dir := range filepath.SplitList(pathEnv) {
		if dir == "" {
			continue
		}
		ordered = append(ordered, filepath.Join(dir, cliName))
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
	firstPath := ""
	for _, c := range candidates {
		real, ok := statReal(c)
		if !ok {
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
	home, _ := os.UserHomeDir()
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
	owned := func(real string) bool {
		info, err := os.Stat(real)
		if err != nil {
			return false
		}
		st, ok := info.Sys().(*syscall.Stat_t)
		return ok && int(st.Uid) == os.Getuid()
	}
	return resolveFrom(cands, statReal, owned)
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
	out, err := exec.Command(binPath, "--version").Output()
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

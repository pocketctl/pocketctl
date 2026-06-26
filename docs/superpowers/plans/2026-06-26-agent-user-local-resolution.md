# Agent 用户本地安装定位与升级提示 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 daemon 始终优先定位并使用用户本地(user-owned)安装的 coding agent,绕开 root-owned 二进制遮蔽;无法升级时如实提示,完全未安装时引导安装。

**Architecture:** 新增唯一定位真相源 `discovery.ResolveAgent`(用户本地优先、按 uid 归属判定 `manageable`),被发现/启动/升级三处复用。`manageable` 经 register → relay → web/iOS 全链路透传,前端据此渲染三态(可升级 / 系统安装提示自升 / 未安装提示安装)。删除自动 `claude install` 回退。

**Tech Stack:** Go(daemon)、TypeScript/Fastify(relay)、Vue 3 + vitest(web)、SwiftUI(iOS)。

## Global Constraints

- 复用现有 reason 码 `permission_denied`,**不新增** reason 常量。
- `manageable` 判定 = 真实二进制(跟随 symlink 后)`Stat.Uid == os.Getuid()`。
- 协议字段全部 `omitempty`,向后兼容旧 daemon/relay(缺省 `manageable=true`)。
- pocketctl **不**替用户安装/卸载任何 agent;**不**改 `$PATH` 或动 root-owned 文件。
- 可用性优先:仅有 root-owned 安装时仍照常启动会话,只在升级时提示。
- Go 测试:`go test ./internal/...`;relay/web:`npm run build`(tsc/vue-tsc)+ vitest;iOS:Xcode 构建。

---

## File Structure

- `internal/discovery/discovery.go` — 新增 `ResolveAgent` + 纯函数 `candidatePaths`/`resolveFrom`;`AgentInfo.Manageable`;`detectVersion` 改收绝对路径。
- `internal/discovery/discovery_test.go` — 新建,覆盖 `candidatePaths`/`resolveFrom`。
- `internal/session/manager.go` — `findAgentCLI` 改用 `ResolveAgent`。
- `internal/protocol/types.go` — `RegisterMessage.AgentManageable`。
- `internal/ws/client.go` — `agentManageable` 字段 + `SetAgentManageable` + 两处 register 构造。
- `cmd/pocketctl/main.go` — 填充 `agent_manageable`、删空列表默认值;`handleUpgradeAgent`/`runAgentUpgrade` 重写。
- `relay/src/router.ts` — compose `manageable` 进 agents 对象。
- `web/src/views/HostsView.vue` + `web/src/i18n/{zh,en}.json` — manageable 渲染 + 空态提示 + i18n。
- `ios/Pocketctl/Models/Daemon.swift` + `ios/Pocketctl/ViewModels/AgentManageViewModel.swift` — `manageable` 字段 + 升级门控。

---

### Task 1: discovery.ResolveAgent 与纯函数核心

**Files:**
- Modify: `internal/discovery/discovery.go`
- Test: `internal/discovery/discovery_test.go` (create)

**Interfaces:**
- Consumes: 无(本任务为基础)。
- Produces:
  - `func ResolveAgent(cliName string) (path string, manageable bool, found bool)`
  - `func candidatePaths(cliName, home, pathEnv, npmPrefix string) []string`
  - `func resolveFrom(candidates []string, statReal func(string) (real string, ok bool), ownedByUser func(real string) bool) (path string, manageable bool, found bool)`
  - `AgentInfo` 新增字段 `Manageable bool`(json `"manageable"`)。
  - `func detectVersion(binPath string) string`(签名由 `cli` 改为绝对/可执行路径)。

- [ ] **Step 1: 写失败测试 — candidatePaths 顺序与去重**

在新建文件 `internal/discovery/discovery_test.go`:

```go
package discovery

import (
	"reflect"
	"testing"
)

func TestCandidatePaths_UserLocalFirstAndDedup(t *testing.T) {
	got := candidatePaths("claude", "/home/u", "/usr/bin:/home/u/.local/bin", "")
	want := []string{
		"/home/u/.local/bin/claude", // well-known 用户本地
		"/home/u/.claude/local/claude",
		"/usr/bin/claude", // 来自 PATH
		// PATH 里的 /home/u/.local/bin/claude 被去重(已在首位)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("candidatePaths = %v, want %v", got, want)
	}
}

func TestCandidatePaths_NpmPrefixIncluded(t *testing.T) {
	got := candidatePaths("codex", "/home/u", "/usr/bin", "/home/u/.npm-global")
	// npm 用户 prefix 的 bin 应排在 PATH 之前
	want := []string{
		"/home/u/.local/bin/codex",
		"/home/u/.claude/local/codex",
		"/home/u/.npm-global/bin/codex",
		"/usr/bin/codex",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("candidatePaths = %v, want %v", got, want)
	}
}
```

- [ ] **Step 2: 写失败测试 — resolveFrom 选择逻辑**

追加到同文件:

```go
func TestResolveFrom(t *testing.T) {
	existsAll := func(p string) (string, bool) { return p, true } // 全部存在,real==p
	cases := []struct {
		name       string
		cands      []string
		owned      map[string]bool
		wantPath   string
		wantManage bool
		wantFound  bool
	}{
		{
			name:      "only root-owned: 仍可用但不可管理",
			cands:     []string{"/usr/bin/claude"},
			owned:     map[string]bool{},
			wantPath:  "/usr/bin/claude", wantManage: false, wantFound: true,
		},
		{
			name:      "only user-local: 可管理",
			cands:     []string{"/home/u/.local/bin/claude"},
			owned:     map[string]bool{"/home/u/.local/bin/claude": true},
			wantPath:  "/home/u/.local/bin/claude", wantManage: true, wantFound: true,
		},
		{
			name:      "both exist: 选用户本地(manageable 优先)",
			cands:     []string{"/usr/bin/claude", "/home/u/.local/bin/claude"},
			owned:     map[string]bool{"/home/u/.local/bin/claude": true},
			wantPath:  "/home/u/.local/bin/claude", wantManage: true, wantFound: true,
		},
		{
			name:      "无 manageable: 回退第一个存在的",
			cands:     []string{"/usr/bin/claude", "/opt/claude"},
			owned:     map[string]bool{},
			wantPath:  "/usr/bin/claude", wantManage: false, wantFound: true,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			owned := func(p string) bool { return c.owned[p] }
			path, manage, found := resolveFrom(c.cands, existsAll, owned)
			if path != c.wantPath || manage != c.wantManage || found != c.wantFound {
				t.Fatalf("got (%q,%v,%v), want (%q,%v,%v)", path, manage, found, c.wantPath, c.wantManage, c.wantFound)
			}
		})
	}
}

func TestResolveFrom_None(t *testing.T) {
	none := func(p string) (string, bool) { return "", false }
	path, manage, found := resolveFrom([]string{"/usr/bin/claude"}, none, func(string) bool { return false })
	if found || manage || path != "" {
		t.Fatalf("got (%q,%v,%v), want empty/not found", path, manage, found)
	}
}
```

- [ ] **Step 3: 运行测试确认失败**

Run: `go test ./internal/discovery/ -run 'CandidatePaths|ResolveFrom' -v`
Expected: 编译失败 `undefined: candidatePaths` / `undefined: resolveFrom`。

- [ ] **Step 4: 实现纯函数与 ResolveAgent**

编辑 `internal/discovery/discovery.go`:在 `AgentInfo` 增加字段:

```go
type AgentInfo struct {
	Type       string `json:"type"`
	CLIName    string `json:"cli_name"`
	Path       string `json:"path"`
	Version    string `json:"version,omitempty"`
	Latest     string `json:"latest,omitempty"`
	Manageable bool   `json:"manageable"`
}
```

新增 import:`os`、`path/filepath`、`strings`、`syscall`(`os/exec` 已有)。新增函数:

```go
// candidatePaths 按"用户本地优先"返回 cliName 的候选可执行路径(去重保序)。
func candidatePaths(cliName, home, pathEnv, npmPrefix string) []string {
	var ordered []string
	if home != "" {
		ordered = append(ordered,
			filepath.Join(home, ".local", "bin", cliName),
			filepath.Join(home, ".claude", "local", cliName),
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

// ResolveAgent 定位 agent 可执行文件。found=false 表示未安装;
// manageable=true 表示真实二进制属当前 uid,可被就地升级。
func ResolveAgent(cliName string) (string, bool, bool) {
	home, _ := os.UserHomeDir()
	npmPrefix := ""
	if out, err := exec.Command("npm", "config", "get", "prefix").Output(); err == nil {
		npmPrefix = strings.TrimSpace(string(out))
	}
	cands := candidatePaths(cliName, home, os.Getenv("PATH"), npmPrefix)
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
```

- [ ] **Step 5: 运行测试确认通过**

Run: `go test ./internal/discovery/ -run 'CandidatePaths|ResolveFrom' -v`
Expected: PASS。

- [ ] **Step 6: 改 detectVersion 收路径,并让 DiscoverAgents 用 ResolveAgent**

将 `detectVersion(cli string)` 改为 `detectVersion(binPath string)`,函数体内 `exec.Command(binPath, "--version")`。重写 `DiscoverAgents`:

```go
func DiscoverAgents() []AgentInfo {
	var agents []AgentInfo
	for _, a := range knownAgents {
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
```

- [ ] **Step 7: 全量构建 + 测试**

Run: `go build ./... && go test ./internal/discovery/ -v`
Expected: build ok;全部 PASS。

- [ ] **Step 8: 提交**

```bash
git add internal/discovery/discovery.go internal/discovery/discovery_test.go
git commit -m "feat(discovery): ResolveAgent 用户本地优先定位 + manageable 判定"
```

---

### Task 2: 会话启动走 ResolveAgent 绝对路径

**Files:**
- Modify: `internal/session/manager.go:1877-1884` (`findAgentCLI`)

**Interfaces:**
- Consumes: `discovery.ResolveAgent`(Task 1)、已有 `agentCLIName`。
- Produces: `findAgentCLI` 返回用户本地优先的绝对路径(签名不变:`(string, error)`)。

- [ ] **Step 1: 重写 findAgentCLI**

将 [manager.go:1877](../../../internal/session/manager.go):

```go
func findAgentCLI(agent string) (string, error) {
	name := agentCLIName(agent)
	path, _, found := discovery.ResolveAgent(name)
	if !found {
		return "", fmt.Errorf("agent CLI not found: %s (%s)", agent, name)
	}
	return path, nil
}
```

确认 `internal/session/manager.go` 顶部已 import `"github.com/pocketctl/pocketctl/internal/discovery"`(已在用 `adapter`,若无 discovery 则补)。

- [ ] **Step 2: 构建 + 现有会话测试**

Run: `go build ./... && go test ./internal/session/ -run 'CLI|Spawn|Manager' -count=1`
Expected: build ok;PASS(无回归)。

- [ ] **Step 3: 提交**

```bash
git add internal/session/manager.go
git commit -m "feat(session): findAgentCLI 走 ResolveAgent 绝对路径，优先用户本地安装"
```

---

### Task 3: 协议 + register 透传 agent_manageable

**Files:**
- Modify: `internal/protocol/types.go:104-117` (RegisterMessage)
- Modify: `internal/ws/client.go` (字段 + setter + 两处 register)
- Modify: `cmd/pocketctl/main.go:533-550, 615` (填充 + 删默认值)

**Interfaces:**
- Consumes: `discovery.DiscoverAgents()` 返回的 `AgentInfo.Manageable`(Task 1)。
- Produces:
  - `RegisterMessage.AgentManageable map[string]bool` (json `"agent_manageable,omitempty"`)
  - `func (c *Client) SetAgentManageable(m map[string]bool)`

- [ ] **Step 1: 加协议字段**

`internal/protocol/types.go` RegisterMessage 在 `AgentLatests` 后加:

```go
	AgentManageable  map[string]bool   `json:"agent_manageable,omitempty"`
```

- [ ] **Step 2: Client 字段 + setter**

`internal/ws/client.go`:`agentLatests map[string]string` 后加字段:

```go
	agentManageable map[string]bool
```

在 `SetAgentLatests` 后加:

```go
// SetAgentManageable updates the per-agent manageable flag map (user-owned install).
func (c *Client) SetAgentManageable(m map[string]bool) { c.agentManageable = m }
```

- [ ] **Step 3: 两处 register 带上字段**

`ResendRegister`(~L101)与 `connectAndServe`(~L165)两处 `RegisterMessage` 字面量,在 `AgentLatests: c.agentLatests,` 后各加一行:

```go
		AgentManageable: c.agentManageable,
```

- [ ] **Step 4: main.go 填充 + 删空列表默认值**

`cmd/pocketctl/main.go` 在 `agentLatests := make(map[string]string)` 旁加 `agentManageable := make(map[string]bool)`;循环内填充:

```go
		agentManageable[a.Type] = a.Manageable
```

删除 [main.go:547-550](../../../cmd/pocketctl/main.go) 的空列表默认块:

```go
	if len(agentTypes) == 0 {
		agentTypes = []string{"claude-code"} // default
		logger.Warn("no agents discovered, defaulting to claude-code")
	}
```

改为(保留告警,但不再伪造 agent):

```go
	if len(agentTypes) == 0 {
		logger.Warn("no coding agent discovered; clients will be prompted to install one")
	}
```

在 `client := ws.NewClient(...)`(~L615)之后、`client.SetVersion` 附近加:

```go
	client.SetAgentManageable(agentManageable)
```

- [ ] **Step 5: 构建**

Run: `go build ./...`
Expected: build ok。

- [ ] **Step 6: 提交**

```bash
git add internal/protocol/types.go internal/ws/client.go cmd/pocketctl/main.go
git commit -m "feat(protocol): register 透传 agent_manageable，空 agent 不再伪造默认值"
```

---

### Task 4: 升级行为改写 — manageable 门控 + 删 claude install 回退

**Files:**
- Modify: `cmd/pocketctl/main.go:1450-1539` (`runAgentUpgrade` + `handleUpgradeAgent`)
- Test: `cmd/pocketctl/main_test.go`(若不存在则新建,仅测纯逻辑)

**Interfaces:**
- Consumes: `discovery.ResolveAgent`、`discovery.AgentTypeToCLI`、`discovery.AgentUpgradeInfo`、`isPermissionDenied`、`protocol.ReasonPermissionDenied`。
- Produces: `func runAgentUpgrade(ctx context.Context, binPath, updateCmd, pkg string) ([]byte, error)`。

- [ ] **Step 1: runAgentUpgrade 收绝对路径**

将 [main.go:1450](../../../cmd/pocketctl/main.go) 改为:

```go
func runAgentUpgrade(ctx context.Context, binPath, updateCmd, pkg string) ([]byte, error) {
	if updateCmd != "" {
		// updateCmd 形如 "claude update"；用解析出的绝对二进制替换裸名，保留子命令。
		parts := strings.Fields(updateCmd)
		args := parts[1:]
		return exec.CommandContext(ctx, binPath, args...).CombinedOutput()
	}
	return exec.CommandContext(ctx, "npm", "install", "-g", pkg+"@latest").CombinedOutput()
}
```

- [ ] **Step 2: 重写 handleUpgradeAgent(含 manageable 门控,删 claude install 回退)**

替换 [main.go:1472-1539](../../../cmd/pocketctl/main.go) 函数体:

```go
func handleUpgradeAgent(client *ws.Client, logger *slog.Logger, agent string) {
	agentName := agent
	if agentName == "" {
		agentName = "claude-code"
	}
	cli, err := discovery.AgentTypeToCLI(agentName)
	if err != nil {
		client.SendMsg(protocol.DaemonEvent{Type: "upgrade_result", Agent: agentName, Status: "failed", Error: err.Error()})
		return
	}
	path, manageable, found := discovery.ResolveAgent(cli)
	if !found {
		client.SendMsg(protocol.DaemonEvent{Type: "upgrade_result", Agent: agentName, Status: "failed", Error: fmt.Sprintf("%s 未安装", agentName)})
		return
	}
	if !manageable {
		logger.Warn("agent upgrade refused: system (root-owned) install", "agent", agentName, "path", path)
		client.SendMsg(protocol.DaemonEvent{
			Type:   "upgrade_result",
			Agent:  agentName,
			Status: "failed",
			Reason: protocol.ReasonPermissionDenied,
			Error:  fmt.Sprintf("%s 为系统(root)安装，pocketctl 无法升级，请自行 sudo-free 升级", path),
		})
		return
	}

	updateCmd, pkg, err := discovery.AgentUpgradeInfo(agentName)
	if err != nil {
		client.SendMsg(protocol.DaemonEvent{Type: "upgrade_result", Agent: agentName, Status: "failed", Error: err.Error()})
		return
	}
	oldVer := ""
	for _, a := range discovery.DiscoverAgents() {
		if a.Type == agentName {
			oldVer = a.Version
		}
	}
	logger.Info("agent upgrade start", "agent", agentName, "old_version", oldVer, "path", path, "cmd", updateCmd)

	upCtx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	out, err := runAgentUpgrade(upCtx, path, updateCmd, pkg)
	if err != nil {
		reason := ""
		if isPermissionDenied(string(out)) {
			reason = protocol.ReasonPermissionDenied
		}
		logger.Error("agent upgrade failed", "agent", agentName, "error", err, "output", string(out))
		client.SendMsg(protocol.DaemonEvent{Type: "upgrade_result", Agent: agentName, Status: "failed", Reason: reason, Error: fmt.Sprintf("%v: %s", err, strings.TrimSpace(string(out)))})
		return
	}

	agentVersions := make(map[string]string)
	agentLatests := make(map[string]string)
	agentManageable := make(map[string]bool)
	newVer := ""
	for _, a := range discovery.DiscoverAgents() {
		if a.Version != "" {
			agentVersions[a.Type] = a.Version
		}
		if a.Latest != "" {
			agentLatests[a.Type] = a.Latest
		}
		agentManageable[a.Type] = a.Manageable
		if a.Type == agentName {
			newVer = a.Version
		}
	}
	client.SetAgentVersions(agentVersions)
	client.SetAgentLatests(agentLatests)
	client.SetAgentManageable(agentManageable)
	client.ResendRegister()
	client.SendMsg(protocol.DaemonEvent{Type: "upgrade_result", Agent: agentName, Status: "success", Message: newVer})
	logger.Info("agent upgrade done", "agent", agentName, "old", oldVer, "new", newVer)
}
```

注意:删除了原 [main.go:1493-1513](../../../cmd/pocketctl/main.go) 的 `claude install` 回退块。

- [ ] **Step 3: 写测试 — isPermissionDenied 仍正确(回归护栏)**

`isPermissionDenied` 逻辑保留;若 `cmd/pocketctl/main_test.go` 不存在则新建:

```go
package main

import "testing"

func TestIsPermissionDenied(t *testing.T) {
	for _, s := range []string{"npm ERR! EACCES", "Error: EPERM", "permission denied", "Insufficient permissions"} {
		if !isPermissionDenied(s) {
			t.Errorf("expected permission-denied for %q", s)
		}
	}
	for _, s := range []string{"network timeout", "404 not found", ""} {
		if isPermissionDenied(s) {
			t.Errorf("unexpected permission-denied for %q", s)
		}
	}
}
```

- [ ] **Step 4: 运行测试 + 构建**

Run: `go test ./cmd/pocketctl/ -run TestIsPermissionDenied -v && go build ./...`
Expected: PASS;build ok。

- [ ] **Step 5: 全量测试(确认无回归)**

Run: `go test ./... -count=1`
Expected: 全部 PASS(若有依赖旧 `claude install` 回退的测试,删除/调整它们)。

- [ ] **Step 6: 提交**

```bash
git add cmd/pocketctl/main.go cmd/pocketctl/main_test.go
git commit -m "feat(upgrade): manageable 门控，root-owned 安装回 permission_denied，删除自动 claude install 回退"
```

---

### Task 5: relay compose manageable

**Files:**
- Modify: `relay/src/router.ts:27-31`

**Interfaces:**
- Consumes: daemon register 的 `msg.agent_manageable`(Task 3)。
- Produces: 广播 agents 对象新增 `manageable` 字段(缺省 true)。

- [ ] **Step 1: 改 compose**

将 [router.ts:27-31](../../../relay/src/router.ts) 改为:

```ts
    // Compose agents as [{type, version, latest, manageable}] objects.
    const agentTypes: string[] = msg.agents || [];
    const agentVersions: Record<string, string> = msg.agent_versions || {};
    const agentLatests: Record<string, string> = msg.agent_latests || {};
    const agentManageable: Record<string, boolean> = msg.agent_manageable || {};
    const agents = agentTypes.map((t: string) => ({
      type: t,
      version: agentVersions[t] || '',
      latest: agentLatests[t] || '',
      manageable: agentManageable[t] !== false, // 缺省 true，兼容旧 daemon
    }));
```

- [ ] **Step 2: 构建**

Run: `cd relay && npm run build`
Expected: tsc 无错误。

- [ ] **Step 3: 提交**

```bash
git add relay/src/router.ts
git commit -m "feat(relay): agents compose 透传 manageable，缺省 true 兼容旧 daemon"
```

---

### Task 6: web 渲染三态 + 空态提示 + i18n

**Files:**
- Modify: `web/src/views/HostsView.vue` (helper + 模板 144-164)
- Modify: `web/src/i18n/zh.json`、`web/src/i18n/en.json`

**Interfaces:**
- Consumes: agent 对象的 `manageable`(Task 5);已有 `agentRawName`、`isAgentLatest`、`upgradeAgent`。
- Produces: helper `agentManageable(a)`。

- [ ] **Step 1: 加 i18n key**

`web/src/i18n/zh.json` 增加:

```json
  "hosts.agent_system_install": "系统安装，pocketctl 无法自动升级，请在主机手动 sudo-free 升级",
  "hosts.agent_none": "未检测到 coding agent，请在主机安装 Claude Code 等后重试",
```

`web/src/i18n/en.json` 增加:

```json
  "hosts.agent_system_install": "System install — pocketctl can't auto-upgrade. Reinstall sudo-free on the host.",
  "hosts.agent_none": "No coding agent detected. Install one (e.g. Claude Code) on the host and retry.",
```

- [ ] **Step 2: 加 helper**

在 `HostsView.vue` `<script setup>` 内 `isAgentLatest` 附近(~L440)加:

```ts
function agentManageable(a: any): boolean { return typeof a !== 'object' || a?.manageable !== false }
```

- [ ] **Step 3: 模板门控升级按钮 + 系统安装提示**

将 [HostsView.vue:152-155](../../../web/src/views/HostsView.vue) 改为:

```html
                <button v-if="selectedDaemon?.daemon_online && !isAgentLatest(a) && agentManageable(a)" class="ag-upgrade-btn" :class="{ upgrading: upgrading === agentRawName(a) }" :disabled="upgrading === agentRawName(a)" @click="upgradeAgent(agentRawName(a))">
                  {{ t('settings.upgrade_btn') }}
                </button>
                <span v-else-if="!agentManageable(a)" class="ag-sysinstall" :title="t('hosts.agent_system_install')">{{ t('hosts.agent_system_install') }}</span>
                <span v-else-if="isAgentLatest(a)" class="ag-latest">✓ {{ t('settings.installed') }}</span>
```

- [ ] **Step 4: 空态改为安装提示**

将 [HostsView.vue:158-164](../../../web/src/views/HostsView.vue) 的 `v-else` 块 meta 文案改为引导安装:

```html
            <div v-else class="agent-card">
              <div class="ag-icon claude">CC</div>
              <div class="ag-info">
                <div class="ag-name">Claude Code <span class="ag-version">{{ t('settings.version_pending') }}</span></div>
                <div class="ag-meta">{{ t('hosts.agent_none') }}</div>
              </div>
            </div>
```

加样式(在 `.ag-latest` 附近的 `<style>`):

```css
.ag-sysinstall { flex-shrink: 0; max-width: 220px; font-size: 11px; color: var(--fg-tertiary); text-align: right; line-height: 1.3; }
```

- [ ] **Step 5: 构建**

Run: `cd web && npm run build`
Expected: vue-tsc + vite 构建无错误。

- [ ] **Step 6: 提交**

```bash
git add web/src/views/HostsView.vue web/src/i18n/zh.json web/src/i18n/en.json
git commit -m "feat(web): agent 三态渲染（可升级/系统安装提示/未安装引导）"
```

---

### Task 7: iOS manageable 字段 + 升级门控

**Files:**
- Modify: `ios/Pocketctl/Models/Daemon.swift:5-16, 76-86`
- Modify: `ios/Pocketctl/ViewModels/AgentManageViewModel.swift:125-128`

**Interfaces:**
- Consumes: agent dict 的 `manageable`(Task 5)。
- Produces: `AgentInfo.manageable: Bool`;升级可用性 = `canUpgrade && manageable`。

- [ ] **Step 1: AgentInfo 加 manageable + canUpgrade 收紧**

`ios/Pocketctl/Models/Daemon.swift` struct `AgentInfo` 改为:

```swift
struct AgentInfo: Identifiable, Sendable, Hashable {
    let type: String
    let version: String
    let latest: String
    let manageable: Bool

    var id: String { type }

    /// 存在新版且为用户本地可管理安装时才允许一键升级。
    var canUpgrade: Bool {
        manageable && !version.isEmpty && !latest.isEmpty && version != latest
    }
}
```

- [ ] **Step 2: parseAgents 解析 manageable(缺省 true)**

`parseAgents`(~L78)的 `AgentInfo(...)` 构造改为:

```swift
            return AgentInfo(
                type: type,
                version: dict["version"] as? String ?? "",
                latest: dict["latest"] as? String ?? "",
                manageable: dict["manageable"] as? Bool ?? true
            )
```

- [ ] **Step 3: ViewModel 升级门控引用 manageable**

`AgentManageViewModel.swift:125-128` 当前用 `$0.canUpgrade`;因 `canUpgrade` 已含 `manageable`,逻辑自动收紧 —— 确认该处 `.map { $0.canUpgrade } ?? true` 的兜底改为 `?? false`(找不到 agent 时不应显示可升级):

```swift
                if let agents = daemon?.agents {
                    return agents.first { $0.type == type }.map { $0.canUpgrade } ?? false
                }
```

- [ ] **Step 4: 构建(Xcode / xcodebuild)**

Run: 在 Xcode 打开 `ios/Pocketctl` 构建,或 `xcodebuild -scheme Pocketctl -destination 'generic/platform=iOS' build`(若 CI 可用)。
Expected: 编译通过;`AgentInfo` 所有构造点已带 `manageable`。

- [ ] **Step 5: 提交**

```bash
git add ios/Pocketctl/Models/Daemon.swift ios/Pocketctl/ViewModels/AgentManageViewModel.swift
git commit -m "feat(ios): AgentInfo.manageable，升级门控含可管理性"
```

---

## 验证(端到端手动)

1. **场景 A — 仅 root-owned**:`sudo npm i -g @anthropic-ai/claude-code` 后启动 daemon。预期:web/iOS agent 行显示"系统安装"提示、无升级按钮;点升级(若触发)收到 `permission_denied` toast。
2. **场景 B — 用户本地**:`curl -fsSL https://claude.ai/install.sh | bash`(装到 `~/.local/bin`),启动 daemon。预期:即便 `/usr/bin/claude` 仍在,daemon 启动会话用的是 `~/.local/bin/claude`(`which claude` 之外的那个),settings.json 生效;升级按钮可用。
3. **场景 C — 全无**:无任何 agent。预期:卡片显示"未检测到 coding agent,请安装"。

---

## Self-Review

- **Spec 覆盖**:组件 1→Task 1;组件 2→Task 2;组件 3→Task 4;组件 4(协议)→Task 3、(relay)→Task 5、(web)→Task 6、(iOS)→Task 7。错误处理表四行分别落在 Task 3(空列表)/Task 4(root-owned、EACCES)/Task 2(用户本地启动)。测试策略落在各 Task 的 test step。无遗漏。
- **占位符**:无 TBD/TODO;每个代码 step 均含完整代码。
- **类型一致**:`ResolveAgent` 三返回值签名在 Task 1/2/4 一致;`AgentInfo.Manageable`(Go)/`manageable`(TS/Swift)贯穿;`SetAgentManageable` 在 Task 3 定义、Task 4 使用,签名一致;`runAgentUpgrade(ctx, binPath, updateCmd, pkg)` 在 Task 4 定义并调用。

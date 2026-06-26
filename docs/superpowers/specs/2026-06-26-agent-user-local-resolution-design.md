# Agent 用户本地安装定位与升级提示

**日期**: 2026-06-26
**状态**: 设计已确认，待评审

## 背景与问题

pocketctl daemon 在三处都用**裸名**(如 `claude`)经 `$PATH` 解析 coding agent 二进制:

- 发现/注册:`discovery.DiscoverAgents` — [internal/discovery/discovery.go:37](../../../internal/discovery/discovery.go)(`exec.LookPath`)
- 会话启动:`findAgentCLI` — [internal/session/manager.go:1879](../../../internal/session/manager.go)(`exec.LookPath`)
- 升级:`runAgentUpgrade` — [cmd/pocketctl/main.go:1453](../../../cmd/pocketctl/main.go)(裸名 `claude update` / `npm install -g`)

当机器上存在 root-owned 的 `/usr/bin/claude`(典型:此前用 `sudo npm install -g` 装的),且 daemon 以普通用户启动时,所有症状都源于这一个根因:

1. `/usr/bin/claude` 排在 `$PATH` 前 → daemon 永远启动它。
2. daemon 无权写它的安装目录 → `claude update` 报 EACCES,**升级失败**。
3. 用户即便 sudo-free 重装到 `~/.local/bin/claude`,仍被 `/usr/bin/claude` 遮蔽 → 新二进制和用户配置永远不生效,表现为"**用户已配置的 settings.json 用不上**"(实为运行了错误的二进制,HOME=`/home/<user>` 本身是对的)。

现有代码对升级失败有一个自动回退:EACCES 时跑 `claude install` 做用户本地安装([main.go:1498](../../../cmd/pocketctl/main.go))。但该回退产物会被 root-owned 二进制继续遮蔽(无效),且违反"不替用户安装"的产品意图。

## 产品决策(已与用户确认)

- **只用用户本地安装**:存在用户可管理(user-owned)的 agent 时,发现/启动/升级一律用它,绕开 root 遮蔽。
- **可用性优先**:若只有 root-owned 安装,仍照常用它跑会话(不阻断使用),仅在升级时给提示。
- **不替用户安装**:删除自动 `claude install` 回退;无法升级时由前端提示用户自行 sudo-free 升级。
- **完全没装 agent 时提示用户**:如实上报空列表,前端引导安装。
- `manageable` 判定 = **真实二进制(跟随 symlink 后)属当前 uid 所有**。
- 复用现有 reason 码 `permission_denied`,**不新增** reason。
- web + iOS 前端提示一并纳入本 spec。

## 架构总览

```
daemon                               relay                      clients
──────                               ─────                      ───────
discovery.ResolveAgent  ─┐
  (唯一定位真相源)        │  register{                ┌─ daemon_status / list_daemons
findAgentCLI ────────────┤    agents,                │    agents:[{type,version,
runAgentUpgrade ─────────┘    agent_versions,        │      latest, manageable}]
                              agent_latests,    ──────┤
                              agent_manageable }      └─ web HostsView / iOS AgentManage
                          upgrade_result{
                            status, reason:           前端:
                            "permission_denied" }     - manageable=false → 升级按钮禁用 + 提示
                                                       - agents 为空 → "未检测到 agent，请安装"
```

## 组件设计

### 组件 1 — 统一解析器 `discovery.ResolveAgent`

新增函数,作为二进制定位的**唯一真相源**,被发现/启动/升级三处复用:

```go
// ResolveAgent 定位某 agent 的可执行文件。
// found=false 表示机器上未安装该 agent。
// manageable=true 表示返回的二进制真实目标属当前 uid 所有，可被就地升级。
func ResolveAgent(cliName string) (path string, manageable bool, found bool)
```

算法:

1. **枚举候选路径**(按用户本地优先排序):
   - `~/.local/bin/<cli>`(Claude Code 原生安装位置)
   - `~/.claude/local/<cli>`(旧版原生安装位置)
   - npm 用户 prefix 的 `bin/<cli>`(`npm config get prefix` 非 root 前缀时)
   - macOS:homebrew `bin/<cli>`
   - `$PATH` 中所有匹配(等价 `which -a`),追加在后
   - 去重，保持顺序
2. 对每个候选 `os.Lstat` → 跟随 symlink 到真实目标 → `os.Stat` → 取 `Sys().(*syscall.Stat_t).Uid`,与 `os.Getuid()` 比较得 `manageable`。
3. **优先返回第一个 `manageable=true` 的候选**(用户本地安装)。
4. 否则返回第一个存在的候选 + `manageable=false`(root-owned,可用性优先)。
5. 全无 → `found=false`。

`AgentInfo` 增加字段 `Manageable bool`。`DiscoverAgents` 改为对每个 known agent 调 `ResolveAgent`:`found=false` 时跳过(不计入已安装);否则记录 `Path` 与 `Manageable`,`Version` 用解析出的**绝对路径**探测(见组件 2)。

> 设计取舍:`manageable` 用"属当前 uid 所有"而非"在 HOME 下",更准确反映 `claude update` 能否写入,且不受安装位置变动影响。

### 组件 2 — 启动与版本探测走绝对路径

- `findAgentCLI`([manager.go:1877](../../../internal/session/manager.go))改为调用 `discovery.ResolveAgent`,用返回的**绝对路径**启动,而非 `exec.LookPath` 裸名。这是让用户本地安装(及其 settings.json)真正生效的关键。
- `detectVersion`([discovery.go:63](../../../internal/discovery/discovery.go))接收绝对路径,确保探测的是将被启动的那个二进制。

### 组件 3 — 升级行为改写(`handleUpgradeAgent`)

[cmd/pocketctl/main.go:1472](../../../cmd/pocketctl/main.go) 改写:

1. `ResolveAgent(cli)`:
   - `found=false`(未安装):此入口正常不会被触发(前端无升级按钮)。若仍收到,回 `upgrade_result{status:"failed"}`,`error` 说明"未安装",**不带** `permission_denied`(它是另一类状态,由 register 空列表表达)。
   - `manageable=false`(root-owned)→ **不执行任何命令**,直接回 `upgrade_result{status:"failed", reason:"permission_denied", error:"<path> 为系统(root)安装，pocketctl 无法升级，请自行 sudo-free 升级"}`。
   - `manageable=true` → 继续。
2. 对**绝对路径**执行升级:`<path> update`(claude/opencode)或 `npm install -g <pkg>@latest`(codex)。
3. 若仍 EACCES(`isPermissionDenied`)→ 回 `permission_denied`,**不再** `claude install`。
4. **删除** [main.go:1498-1513](../../../cmd/pocketctl/main.go) 的自动 `claude install` 回退块。

`isPermissionDenied`、`ReasonPermissionDenied` 保留。`runAgentUpgrade` 改为接收绝对二进制路径。

### 组件 4 — 协议与前端提示

**协议**(向后兼容,均 `omitempty`):

- `RegisterMessage` 增加 `AgentManageable map[string]bool`([protocol/types.go:104](../../../internal/protocol/types.go))。
- daemon 注册时(`main.go` ~L533 与 `ResendRegister` 路径)填充该 map;`SetAgentManageable` 加到 `ws.Client`。
- **空 agent 不再默认塞 `["claude-code"]`**([main.go:547](../../../cmd/pocketctl/main.go)):如实上报 `agents: []`。

**relay**([relay/src/router.ts:31](../../../relay/src/router.ts)):

- 读取 `msg.agent_manageable`,组装为 `agents:[{type, version, latest, manageable}]`(缺省 `manageable: true`,兼容旧 daemon)。
- `agents` 为空数组时照常存储/广播(`row.agents || []` 已兼容)。

**web**(`web/src/views/HostsView.vue`):

- agent 行读取 `manageable`:为 `false` 时禁用升级按钮并展示 hint(i18n key `hosts.upgrade_system_install`:"系统安装，无法自动升级,请手动 sudo-free 升级")。
- `d.agents` 为空时,该 daemon 卡片展示"未检测到 coding agent"提示。
- `upgrade_result` 的 `permission_denied` 文案复用/微调 `hosts.upgrade_perm_denied`,指向"自行 sudo-free 升级"。

**iOS**:

- `AgentInfo`([Daemon.swift:5](../../../ios/Pocketctl/Models/Daemon.swift))增加 `let manageable: Bool`(parseAgents 缺省 `true`)。
- 升级可用性 = `canUpgrade && manageable`;`manageable=false` 行展示系统安装说明、禁用一键升级。
- `daemon.agents` 为空 → AgentManageView 展示"未检测到 agent,请安装"空态。
- `upgrade_result` 收到 `permission_denied` → 提示自行升级(沿用现有 reason 处理)。

## 数据流(端到端)

1. daemon 启动 → `ResolveAgent` 得 `(path, manageable, found)` per agent → 跳过未安装者 → register 带 `agent_manageable`。
2. relay 组装 `agents:[{type,version,latest,manageable}]` → 广播。
3. 客户端渲染:可升级(manageable && 有新版)/ 系统安装(!manageable,提示自行升级)/ 未安装(空列表,提示安装)。
4. 用户点升级 → daemon `handleUpgradeAgent` → 仅对 manageable 安装执行;不可管理则回 `permission_denied`,前端提示。
5. 用户 sudo-free 重装到 `~/.local/bin` → 下次 register `ResolveAgent` 优先选中它 → 启动/升级/settings.json 全部切到用户本地安装。

## 错误处理

| 场景 | daemon 行为 | 前端 |
|------|------------|------|
| 未安装任何 agent | register `agents: []` | "未检测到 coding agent,请安装" |
| 仅 root-owned 安装 | 照常启动会话;升级请求回 `permission_denied`(不执行命令) | 升级按钮禁用 + "系统安装,请自行 sudo-free 升级" |
| 用户本地安装存在 | 优先用它启动/升级 | 正常升级流程 |
| manageable 但 `update` 仍 EACCES | 回 `permission_denied`,不再 `claude install` | 提示自行升级 |

## 测试策略

- `discovery`:`ResolveAgent` 单测覆盖 — 仅 root-owned、仅用户本地、两者并存(应选用户本地)、全无;用 temp dir + 构造不同 uid 的桩(uid 比较可注入)。删除现有依赖裸 `claude install` 回退的相关断言。
- `discovery`:`DiscoverAgents` 对未安装 agent 不计入。
- `cmd/pocketctl`:`handleUpgradeAgent` 在 `manageable=false` 时不执行命令、直接回 `permission_denied`(注入 ResolveAgent 桩);删除 `claude install` 回退路径的测试。
- relay:`agent_manageable` 缺省为 true 的兼容性;空 agents 数组传播。
- 前端:手动验证三态渲染(可升级/系统安装/未安装)。

## 不做(YAGNI)

- 不自动迁移/写入 settings.json(HOME 正确,非真问题)。
- pocketctl 不替用户安装或卸载任何 agent。
- 不对 codex/opencode 做特殊逻辑 — 同一 `ResolveAgent` 通用覆盖。
- 不改 `$PATH` 或动 root-owned 文件。

## Context

pocketctl 通过 daemon 直接 spawn `claude` CLI（`internal/session/manager.go:165`，`--output-format stream-json`）驱动 agent，每个会话携带明确的 `cwd`。Web 客户端跑在浏览器中，经 WebSocket（`web/src/composables/useWebSocket.ts`）与 relay/daemon 通信。

当前会话详情页 `web/src/views/SessionDetail.vue` 的输入框是一个裸 `<input>`，`sendMessage()` 把文本原样作为 `user_message` 发出（`:277`）。底层 Claude Code agent 本身支持 slash command，其来源有四类：

- **builtin**：编译进 `claude` 二进制（`/clear`、`/compact`、`/model`…），**不在文件系统**
- **commands**：`.md` 单文件，文件名即命令名（`.claude/commands/**/*.md`、`~/.claude/commands/**/*.md`、插件 `commands/`）
- **skills**：目录 + `SKILL.md`，命令名取 frontmatter `name`（`.claude/skills/*/`、`~/.claude/skills/*/`、插件 `skills/`）
- **plugin**：经 `enabledPlugins` 启用的插件提供的 commands/skills

核心约束：**前端在浏览器里永远扫不到 agent 所在机器的文件系统**，因此命令补全必须由 daemon 侧列举、经 WS 推送、前端展示。本设计建立这条链路。

## Goals / Non-Goals

**Goals:**
- daemon 能按会话 `cwd` 列举四源（builtin / project / user / plugin）可用命令，准确反映 commands 与 skills
- 经 WS 把命令清单推给前端，统一为 `CommandItem` 模型并区分 `command` / `skill`
- Web 会话详情页输入框在输入 `/` 时触发补全：前缀过滤、键盘选择、插入命令名
- 零新增第三方依赖；可复用现有 `os.ReadDir` 扫描模式（参考 `internal/watcher/tailer.go`）

**Non-Goals:**
- 不做命令"执行回执卡片"的渲染（agent 执行 slash command 后的可视化反馈，属另一方向，不在本 change）
- 不做文件监听（fsnotify）增量更新——v1 每次请求扫描或会话级缓存
- 不调用 `claude plugin details` 作为主路径（仅作 v2 兜底候选）
- 不补全 MCP 工具（非 slash command，概念不同）
- 不改变命令的发送/执行机制——选中后仍作为 `user_message` 原样发送，由 agent 自行解析
- 不在 `NewSessionDialog` 等其他输入框启用补全（v1 仅 `SessionDetail`）

## Decisions

### D1. 架构：daemon 列举 → WS 推送 → 前端补全
**选择**：命令清单由 daemon 按 `cwd` 扫描产生，经 `command_list` 消息推送，前端做补全 UI。
**理由**：前端无文件系统访问权，这是唯一可行路径。
**备选**：前端硬编码一份命令表 —— 无法反映因项目/插件而异的自定义命令，准确度不可接受，放弃。

### D2. 四源扫描策略：常量 + 文件扫描 + `installed_plugins.json`
**选择**：
- **builtin** → 维护一份 Go 常量表（CLI 不暴露列举接口、命令编译进二进制，无法扫描）
- **project / user** → `os.ReadDir` 扫描 `<cwd>/.claude/` 与 `~/.claude/` 下的 `commands/**/*.md` 和 `skills/*/SKILL.md`
- **plugin** → 读 `~/.claude/plugins/installed_plugins.json` 取每个插件的 `installPath`，经 `enabledPlugins` 过滤后扫描其下 `commands/`、`skills/`

**理由（plugin 为何用 `installed_plugins.json`）**：该文件直接给出每个插件的绝对 `installPath`，免去复刻 `cache/<marketplace>/<plugin>/<version>/` 与 `.in_use` 版本选择、marketplace 映射等 Claude Code 内部路径规则。实测插件路径有 3 种形态并存（cache+version、扁平 `plugins/skills/`、marketplaces），自己拼路径易错。
**备选**：① 自己扫 `~/.claude/plugins/*` 拼路径 —— 形态复杂、易漏；② spawn `claude plugin details <name>` —— 输出为人类可读文本（非 JSON）、N 个插件需 N 次 spawn、且不提供 `description`/`arg_hint`。两者均劣于直接读 JSON。

### D3. 统一数据模型 `CommandItem`，用 `kind` 区分 command / skill
**选择**：两类命令填充同一模型，新增 `kind` 维度。
```
CommandItem {
  name:        string    // 触发名：/clear、/pocket-release、/codex:rescue
  source:      'builtin' | 'project' | 'user' | 'plugin'
  kind:        'command' | 'skill'
  description: string
  arg_hint?:   string    // 多见于 command（frontmatter argument-hint）
  namespace?:  string    // 仅 plugin：插件名（如 codex），用于 /<ns>:<name>
}
```
**理由**：command 与 skill 的扫描逻辑不同（单文件 vs 目录+SKILL.md），但展示与补全触发统一为 `/` 前缀；`kind` 让前端区分图标/分组（如 🔧 command / 📘 skill）。

### D4. skill 命名与文件匹配规则
**选择**：
- 命令名优先读 frontmatter `name`，目录名仅作 fallback
- `SKILL.md` 文件名匹配 **case-insensitive**（同时认 `SKILL.md` 与 `skill.md`）

**理由**：实测本机 14 个 `SKILL.md` + 1 个 `skill.md`（`pocket-release`），文档只提 `SKILL.md`，纯按文档实现会静默漏命令。本机 frontmatter `name` 恰等于目录名，但规范上 `name` 才是 agent 注册名，直接用目录名会埋雷。

### D5. `enabledPlugins` 合并规则
**选择**：合并 `~/.claude/settings.json`（user）与 `<cwd>/.claude/settings.json`（project）的 `enabledPlugins`，project 覆盖 user；**忽略** `settings.local.json` 的 `enabledPlugins`。
**理由**：Claude Code 的 settings 优先级为 user < project < local < CLI < enterprise，但 `settings.local.json` 的 `enabledPlugins` 存在[已知被忽略的坑](https://github.com/anthropics/claude-code/issues/25086)（除非 `settings.json` 也存在该 key）。为避免与官方行为不一致导致多/漏插件，v1 明确只取 user + project 两级。project 级让"项目专属插件"也能进补全。

### D6. 协议设计：`list_commands` / `command_list`
**选择**：复用现有「请求-回传」消息对模式（参照 `list_sessions` / `session_list`）。
```
client → daemon: { "type": "list_commands", "session_id": "<id>" }
daemon → client: { "type": "command_list", "session_id": "<id>", "commands": [CommandItem, ...] }
```
**理由**：daemon 自持每个 session 的 `cwd`，前端只需传 `session_id`，无需关心路径解析。回传带 `session_id` 便于前端在会话切换时丢弃过期响应。

### D7. 前端补全交互
**选择**：
- 进入会话页（`onMounted`）即发 `list_commands` 预取并缓存（命令对同一 session 稳定）
- 输入框监听 `messageInput`，以 `/` 开头时弹出 popover，按前缀模糊过滤缓存
- ↑↓ 选择、Tab/Enter 确认、Esc 关闭；确认后插入命令名，光标停在末尾供继续输参数（若 `arg_hint` 非空则提示）
- 会话切换时清缓存重取（与现有 `watch(sessionId)` 一致）

**理由**：预取避免打字时延迟；同一 session 命令稳定无需每次按键请求。命令对 cwd 敏感，会话切换必须重取。
**备选**：打 `/` 时按需请求 —— 首次有网络延迟，体验差；放弃。

### D8. frontmatter 手写解析，不引入 YAML 库
**选择**：手写轻量解析（识别 `---` 边界 + 提取 `name` / `description` / `argument-hint` 等键）。
**理由**：`go.mod` 当前很干净（无 yaml 依赖），命令 frontmatter 字段简单固定，~20 行可解；引入 YAML 库成本/收益不划算。

### D9. 扫描时机：每次请求扫描（v1）
**选择**：daemon 收到 `list_commands` 即时扫描，不做文件监听。
**理由**：`.claude/commands`、`.claude/skills` 文件数通常极少，即时扫描开销可忽略；fsnotify 增量更新属 v2 优化。
**备选**：daemon 侧 fsnotify 监听 + 主动推送 —— 复杂度高，v1 无必要。

## Risks / Trade-offs

- **[内置命令表过时]** CLI 版本间会增减命令 → 标注 `source: builtin`；内置命令变动频率低；后续可加版本探测或随 release 维护。风险可接受。
- **[`enabledPlugins` 合并错误]** 规则若与官方不一致，会漏/多插件 → D5 明确 user+project 两级，配单测覆盖合并逻辑。
- **[`SKILL.md` 大小写遗漏]** → D4 case-insensitive 实现 + 单测（构造 `skill.md` 用例）。
- **[`installed_plugins.json` schema 变化]** → v1 以路径 A（JSON）为主；若未来 schema 变动，降级为 `claude plugin list` + 文件扫描兜底（v2）。
- **[扫描性能]** 极端项目命令文件多 → 可加会话级缓存 + TTL 重扫；v1 实测后再定。
- **[补全与流式输出争用]** popover 不阻塞消息流，Esc/失焦即关 → 低风险。

## Migration Plan

纯增量变更，无破坏性：
- 新增 WS 消息类型（`list_commands` / `command_list`）——老客户端不发即无影响，向后兼容
- 新增 daemon 扫描模块与处理 case，不动现有会话/消息逻辑
- 新增前端补全组件，输入框改造为受控触发

daemon 与 web 可分别部署；无数据迁移、无需回滚策略。

## Open Questions

1. **内置命令表 v1 收录清单**：候选 `/clear` `/compact` `/model` `/help` `/resume` `/cost` `/config` `/agents` `/init` `/status`……需对照当前 CLI 版本实测确认完整集合与描述文案（实现阶段定稿）。
2. **补全 UI 视觉**：command / skill 的图标与分组样式（🔧 / 📘 或其它），交 UI 设计确认。
3. **会话级缓存 TTL**：v1 是否需要"会话期间新增命令"的手动刷新入口或定时重扫，待性能实测后决定。

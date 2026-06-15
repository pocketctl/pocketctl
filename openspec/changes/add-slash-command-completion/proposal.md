## Why

Web 客户端会话详情页的输入框目前是一个裸 `<input>`：用户输入 `/clear`、`/compact` 等 slash command 时没有任何辅助——无补全、无命令列表、无执行反馈。而底层 agent（Claude Code CLI）本身就支持大量 slash command：内置命令、项目级/用户级自定义 commands、skills、以及插件命令。用户在 Web 端既无法发现这些命令的存在，也无从知道某个会话当前到底有哪些命令可用，交互体验明显落后于终端。

更本质的约束是：**Web 前端跑在浏览器里，永远扫不到 agent 所在机器的文件系统**（`.claude/commands/`、`.claude/skills/`、插件目录都在 daemon 那一侧）。因此命令补全不可能由前端独立完成，唯一可行路径是 **daemon 侧按会话的 cwd 列举可用命令 → 经 WebSocket 推给前端 → 前端做补全 UI**。本 change 即建立这条链路。

## What Changes

- **Daemon 新增命令列举能力**：按会话 `cwd` 扫描四类命令来源，统一产出命令清单——
  - **builtin**：内置 slash command 常量表（`/clear`、`/compact`、`/model`、`/help` 等，标注 `source: builtin`）
  - **project**：`<cwd>/.claude/commands/**/*.md` 与 `<cwd>/.claude/skills/*/SKILL.md`
  - **user**：`~/.claude/commands/**/*.md` 与 `~/.claude/skills/*/SKILL.md`
  - **plugin**：以 `~/.claude/plugins/installed_plugins.json` 的 `installPath` 为真相源，经 `enabledPlugins`（user + project settings 合并）过滤启用项，命名空间 `/<plugin>:<name>`
- **命令统一建模**：`CommandItem { name, source, kind, description, arg_hint?, namespace? }`，其中 `kind` 区分 `command`（单文件 `.md`，文件名即命令名）与 `skill`（目录 + `SKILL.md`，命令名取 frontmatter `name`），前端据此分组/区分图标
- **新增 WS 协议消息**：`list_commands`（client → daemon，带 `session_id`）请求列举；`command_list`（daemon → client）回传 `CommandItem[]`
- **Web 会话详情页输入框补全**：输入以 `/` 开头时弹出候选 popover，按输入前缀模糊过滤、键盘 ↑↓ 选择、Tab/Enter 确认插入；候选区分 command / skill 视觉标识
- **处理已知边界**：`SKILL.md` 文件名大小写不统一（实测 `SKILL.md` 与 `skill.md` 并存），扫描须 case-insensitive；skill 命令名优先读 frontmatter `name`，目录名仅作 fallback

## Capabilities

### New Capabilities
- `slash-command-completion`: Web 会话详情页输入框的 slash command 补全能力——含 daemon 四源命令扫描（builtin/project/user/plugin）、command 与 skill 的统一建模与区分、`SKILL.md` 大小写与 frontmatter `name` 处理、`enabledPlugins` 合并过滤，以及前端 `/` 触发的补全交互

### Modified Capabilities
- `stream-protocol`: 新增 `list_commands`（client → daemon）与 `command_list`（daemon → client）两个消息类型，用于按会话请求与回传可用命令清单

## Impact

- **Daemon (新增扫描模块)**: 新增命令列举逻辑——四源扫描、`installed_plugins.json` + `enabledPlugins` 合并解析、frontmatter 解析（手写，不引入 YAML 依赖）、`SKILL.md` case-insensitive 匹配；可复用现有 `os.ReadDir` 模式（参考 `internal/watcher/tailer.go`）
- **Daemon (会话入口)**: 在 WS 命令处理中新增 `list_commands` case，按消息携带的 `session_id` 解析对应 `cwd` 后扫描回传
- **Protocol (`internal/protocol/types.go`)**: 新增 `list_commands` / `command_list` 消息类型定义
- **Web (`web/src/views/SessionDetail.vue`)**: 输入框由裸 `<input>` 改造为带补全的组件——监听 `/` 前缀、过滤、键盘选择、插入；进入会话时预取命令列表缓存
- **Web (新增补全组件)**: 候选 popover 组件，区分 command / skill 视觉标识（如 🔧 / 📘），展示 description / arg_hint
- **Web (`web/src/composables/useWebSocket.ts`)**: 新增 `command_list` 事件处理
- **依赖**: 无新增第三方依赖（frontmatter 结构简单，手写解析）
- **风险点**: 内置命令表需随 CLI 版本维护（标注 `source: builtin`，过时风险低但存在）；plugin 的 `enabledPlugins` 合并须明确 user 与 project settings 的优先级（注意 `settings.local.json` 已知会被忽略的坑）

# Tasks

> 实现顺序按依赖：协议类型 → daemon 扫描核心 → daemon 插件扫描 → daemon WS 接入 → web 协议接入 → web 补全 UI → 测试 → 验收。任务编号即建议执行顺序。

## 1. Protocol 消息与数据模型

- [x] 1.1 在 `internal/protocol/types.go` 定义 `CommandItem` 结构：`Name`、`Source`(`builtin`/`project`/`user`/`plugin`)、`Kind`(`command`/`skill`)、`Description`、可选 `ArgHint`、可选 `Namespace`，JSON tag 与前端约定一致
- [x] 1.2 在 `internal/protocol/types.go` 新增 client→daemon 消息类型 `list_commands`（携带 `session_id`）
- [x] 1.3 在 `internal/protocol/types.go` 新增 daemon→client 消息类型 `command_list`（携带 `session_id` 与 `commands []CommandItem`）

## 2. Daemon 命令扫描核心（builtin / project / user）

- [x] 2.1 新增扫描包（如 `internal/commands`），实现手写 frontmatter 解析器：识别 `---` 边界，提取 `name`、`description`、`argument-hint`，不引入 YAML 依赖
- [x] 2.2 实现 commands 扫描器：递归扫 `<base>/commands/**/*.md`，文件名（去 `.md`）作命令名，`kind=command`，读 frontmatter 取 `description`/`argument-hint`
- [x] 2.3 实现 skills 扫描器：扫 `<base>/skills/*/` 下 **case-insensitive** 匹配 `SKILL.md`/`skill.md`，命令名取 frontmatter `name`、缺失时 fallback 目录名，`kind=skill`
- [x] 2.4 定稿 builtin 命令常量表（对照当前 `claude` CLI 实测确认命令集与描述，收录 `/clear` `/compact` `/model` `/help` `/resume` `/cost` `/config` `/agents` 等），`source=builtin`
- [x] 2.5 实现 `ListCommands(cwd)` 入口：合并 builtin + project(`<cwd>/.claude`) + user(`~/.claude`) 三源结果，按 `name` 去重

## 3. Daemon 插件命令扫描

- [x] 3.1 解析 `~/.claude/plugins/installed_plugins.json`，提取每个插件的 `installPath` 与插件名（`<plugin>@<marketplace>` 的 plugin 段）
- [x] 3.2 实现 `enabledPlugins` 合并：读 `~/.claude/settings.json`（user）与 `<cwd>/.claude/settings.json`（project），project 覆盖 user；显式忽略 `settings.local.json`
- [x] 3.3 对每个启用插件，复用 §2 扫描器扫 `installPath` 下的 commands/skills，命令名加命名空间 `<plugin>:<name>`，置 `source=plugin`、`namespace=<plugin>`
- [x] 3.4 将插件结果合并进 `ListCommands(cwd)`，与前三源统一去重

## 4. Daemon WebSocket 接入

- [x] 4.1 在 WS 命令处理循环新增 `list_commands` case：按 `session_id` 解析对应 `cwd`，调用 `ListCommands(cwd)`
- [x] 4.2 回送 `command_list` 消息，携带原 `session_id` 与命令数组
- [x] 4.3 处理边界：`session_id` 不存在或无有效 `cwd` 时，回送 `commands` 为空数组的 `command_list`

## 5. Web 协议接入

- [x] 5.1 在 `web/src/composables/useWebSocket.ts` 新增 `CommandItem` TS 类型与 `command_list` 事件类型
- [x] 5.2 `SessionDetail.vue` 在 `onMounted` 发送 `list_commands` 预取命令并缓存到响应式变量
- [x] 5.3 `watch(sessionId)` 会话切换时清除缓存并重新请求
- [x] 5.4 收到 `command_list` 时校验 `session_id` 匹配当前会话，不匹配则丢弃（防过期响应污染）

## 6. Web 补全 UI

- [x] 6.1 新增补全候选组件（如 `CommandPopover.vue`）：接收命令列表 + 当前前缀，按前缀过滤渲染候选，区分 `command`/`skill` 视觉标识（如图标 🔧/📘）
- [x] 6.2 改造 `SessionDetail.vue` 输入框：监听 `messageInput`，以 `/` 开头时弹出 popover 并按前缀过滤缓存命令
- [x] 6.3 实现键盘交互：`↑`/`↓` 移动高亮、`Tab`/`Enter` 确认插入命令名（光标停末尾）、`Esc`/失焦关闭
- [x] 6.4 非命令输入（不以 `/` 开头）不触发 popover
- [x] 6.5 确认命令后仍走现有 `sendMessage` 作为 `user_message` 原样发送，不引入新的命令执行通道

## 7. 测试

- [x] 7.1 daemon: frontmatter 解析单测（含字段缺失、多字段、无 frontmatter）
- [x] 7.2 daemon: skills 扫描单测——构造 `skill.md`(小写) 与 `SKILL.md`(大写) 共存，验证 case-insensitive 不漏；命令名取 frontmatter `name`
- [x] 7.3 daemon: `enabledPlugins` 合并单测——project 覆盖 user、`settings.local.json` 忽略、`false`/缺失排除插件
- [x] 7.4 daemon: `ListCommands(cwd)` 集成测试——四源合并、插件命名空间 `<plugin>:<name>`、跨源去重
- [x] 7.5 web: `CommandPopover` 组件测试——前缀过滤、键盘选择、command/skill 区分
- [x] 7.6 web: `SessionDetail` 补全交互测试——`/` 触发、预取缓存命中、会话切换重取、过期 `command_list` 丢弃

## 8. 验收与收尾

- [ ] 8.1 逐条对照 `specs/slash-command-completion/spec.md` 与 `specs/stream-protocol/spec.md` 的 scenario 手测验证（重点：SKILL.md 小写、插件命名空间、enabledPlugins 覆盖、过期响应丢弃）
- [x] 8.2 运行 `openspec validate add-slash-command-completion --strict` 通过
- [x] 8.3 将 builtin 命令表清单与来源文档化（写入 design.md 的 Open Questions 回填或单独说明）

## 9. 修订：命令列表改用 agent init.slash_commands（取代静态 builtin 表）

> 手测发现 `/model` 在 -p 模式不可用却被静态表推荐。改为用 agent init 事件的 `slash_commands` 作权威命令名集（见 design D10）。

- [x] 9.1 adapter 解析 init 事件的 `slash_commands` 字段，新增 `SlashCommands()` 方法
- [x] 9.2 `ProcessState` 缓存 `SlashCommands`；`readOutput` 在 init 时提取；新增 `GetSessionSlashCommands`
- [x] 9.3 `ListCommands(cwd, available)` 用 available 作权威 name 集，文件扫描补 description；无 available 时回退扫描
- [x] 9.4 `main.go` 的 `list_commands` case 取 session 的 available 传入 `ListCommands`
- [x] 9.5 测试：available 过滤掉 `/model`（即使静态表有）、无 available 时 fallback

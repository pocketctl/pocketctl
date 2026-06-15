## ADDED Requirements

### Requirement: Daemon 按会话列举可用 slash command
Web 客户端 SHALL 能为指定会话请求其当前可用的 slash command 清单。Daemon 收到 `list_commands` 请求后，SHALL 解析该 `session_id` 对应的 `cwd`，扫描四类命令来源（builtin 常量、project、user、plugin），并经 `command_list` 消息回传命令数组。回传 SHALL 携带原 `session_id`。

#### Scenario: 请求并回传命令清单
- **WHEN** 客户端发送 `{"type":"list_commands","session_id":"abc"}`
- **THEN** daemon 解析会话 abc 的 `cwd`
- **AND** daemon 回送 `{"type":"command_list","session_id":"abc","commands":[...]}`
- **AND** 命令数组包含 builtin / project / user / plugin 四源的命令

#### Scenario: 会话切换丢弃过期响应
- **WHEN** 客户端在等待会话 abc 响应期间切换到会话 xyz
- **AND** 随后收到 `session_id` 为 abc 的 `command_list`
- **THEN** 客户端 SHALL 丢弃该响应，不写入 xyz 的补全缓存

#### Scenario: 会话无有效 cwd 时回空
- **WHEN** 请求的 `session_id` 在 daemon 侧不存在或无有效 `cwd`
- **THEN** daemon SHALL 回送 `commands` 为空数组的 `command_list`

### Requirement: 命令统一建模与 command/skill 区分
每条命令 SHALL 表示为 `CommandItem`，字段包含：`name`（触发名，如 `/clear`、`/pocket-release`、`/codex:rescue`）、`source`（`builtin` / `project` / `user` / `plugin`）、`kind`（`command` / `skill`）、`description`，以及可选的 `arg_hint` 与 `namespace`。前端 SHALL 能依据 `kind` 区分展示。

#### Scenario: command 项字段
- **WHEN** 扫描到 `<cwd>/.claude/commands/optimize.md`，其 frontmatter 含 `description` 与 `argument-hint`
- **THEN** 产出 `{"name":"optimize","source":"project","kind":"command","description":"...","arg_hint":"<file>"}`
- **AND** 不含 `namespace` 字段

#### Scenario: skill 项字段
- **WHEN** 扫描到 `<cwd>/.claude/skills/pocket-release/`，其 SKILL.md frontmatter `name` 为 `pocket-release`
- **THEN** 产出 `{"name":"pocket-release","source":"project","kind":"skill","description":"..."}`
- **AND** `kind` 为 `skill`

#### Scenario: plugin 项带命名空间
- **WHEN** 启用的插件 `codex` 提供命令 `rescue`
- **THEN** 产出 `{"name":"codex:rescue","source":"plugin","kind":"...","namespace":"codex","description":"..."}`
- **AND** `name` 形如 `<namespace>:<cmd>`

### Requirement: commands 与 skills 的扫描规则
扫描 commands 时 SHALL 将 `.md` 单文件的文件名（去掉 `.md` 扩展名）作为命令名，并从 frontmatter 读取 `description` 与 `argument-hint`。扫描 skills 时 SHALL 识别每个子目录下的 `SKILL.md`，命令名 SHALL 取 frontmatter 的 `name`，仅在缺失时以目录名作为 fallback。

#### Scenario: SKILL.md 小写也能识别
- **WHEN** skill 目录 `pocket-release/` 下的定义文件名为 `skill.md`（小写）
- **THEN** 该文件 SHALL 仍被识别为该 skill 的定义文件
- **AND** 不会因大小写不匹配而漏掉该命令

#### Scenario: skill 命令名取自 frontmatter
- **WHEN** `pocket-release/skill.md` 的 frontmatter 含 `name: pocket-release`
- **THEN** 命令名 SHALL 为 frontmatter 的 `name` 值
- **AND** 目录名仅在前者缺失时作为 fallback

#### Scenario: command 描述取自 frontmatter
- **WHEN** commands 目录下 `optimize.md` 的 frontmatter 含 `description` 与 `argument-hint`
- **THEN** `CommandItem.description` 取 frontmatter 的 `description`
- **AND** `CommandItem.arg_hint` 取 frontmatter 的 `argument-hint`

### Requirement: 插件命令来源与启用过滤
插件命令 SHALL 以 `~/.claude/plugins/installed_plugins.json` 中每个插件的 `installPath` 作为路径来源，扫描其下的 `commands/**/*.md` 与 `skills/*/SKILL.md`。仅当插件在合并后的 `enabledPlugins` 中被启用时，其命令才被纳入。`enabledPlugins` SHALL 合并 user 级（`~/.claude/settings.json`）与 project 级（`<cwd>/.claude/settings.json`），project 覆盖 user；SHALL 忽略 `settings.local.json` 中的 `enabledPlugins`。插件命令名 SHALL 带命名空间 `/<plugin>:<name>`。

#### Scenario: 启用插件的命令被纳入
- **WHEN** `installed_plugins.json` 含插件 `codex`，且合并后的 `enabledPlugins` 含 `"codex@openai-codex": true`
- **THEN** 扫描 `codex` 的 `installPath` 下的 commands 与 skills
- **AND** 产出命令名形如 `codex:rescue`，`source` 为 `plugin`，`namespace` 为 `codex`

#### Scenario: 未启用插件被排除
- **WHEN** `installed_plugins.json` 含插件 `open-code-review`，但合并后的 `enabledPlugins` 中其为 `false` 或缺失
- **THEN** 该插件的命令 SHALL NOT 出现在结果中

#### Scenario: project 级 enabledPlugins 覆盖 user 级
- **WHEN** user 级 settings 启用插件 X，project 级 settings 显式将其置为 `false`
- **THEN** 以 project 级为准，插件 X 的命令 SHALL NOT 出现

#### Scenario: 忽略 settings.local.json 的 enabledPlugins
- **WHEN** 仅 `settings.local.json` 的 `enabledPlugins` 启用了某插件
- **THEN** 该插件 SHALL NOT 被纳入（与 Claude Code 已知行为一致）

### Requirement: 前端 slash command 补全交互
会话详情页输入框 SHALL 在输入内容以 `/` 开头时弹出命令候选 popover，按输入前缀过滤缓存的命令列表，并提供键盘选择：`↑`/`↓` 移动高亮、`Tab` 或 `Enter` 确认、`Esc` 关闭。确认后 SHALL 将命令名插入输入框。

#### Scenario: 输入 / 触发补全
- **WHEN** 用户在输入框输入 `/c`
- **THEN** 弹出候选 popover，列出 `name` 匹配 `/c` 的命令
- **AND** 高亮首项

#### Scenario: 键盘选择与确认
- **WHEN** popover 打开后用户按 `↓` 选择第二项，再按 `Enter`
- **THEN** 将选中命令的 `name` 插入输入框，光标停在末尾
- **AND** 关闭 popover

#### Scenario: Esc 关闭保留输入
- **WHEN** popover 打开且用户按 `Esc`
- **THEN** 关闭 popover
- **AND** 保留当前输入框内容不变

#### Scenario: 非命令输入不触发
- **WHEN** 用户输入 `hello world`（不以 `/` 开头）
- **THEN** SHALL NOT 弹出 popover

### Requirement: 命令列表预取与缓存
会话详情页 SHALL 在进入会话时（onMounted）发送 `list_commands` 预取命令并缓存，供输入框补全过滤，避免每次按键请求。会话切换时 SHALL 清除缓存并重新请求。

#### Scenario: 进入会话预取
- **WHEN** 用户进入会话 abc 的详情页
- **THEN** 发送 `{"type":"list_commands","session_id":"abc"}`
- **AND** 将响应缓存供输入框补全使用

#### Scenario: 会话切换重取
- **WHEN** 用户从会话 abc 切换到会话 xyz
- **THEN** 清除 abc 的命令缓存
- **AND** 发送 `list_commands` 请求 xyz 的命令

#### Scenario: 缓存命中不重复请求
- **WHEN** 用户已在会话 abc 且命令缓存就绪，再次在输入框输入 `/`
- **THEN** 使用已缓存的命令列表，SHALL NOT 再次发送 `list_commands`

### Requirement: command/skill 视觉区分与发送
补全候选 SHALL 按 `kind` 区分 `command` 与 `skill` 的视觉标识（如图标或分组）。用户确认命令后，SHALL 将该命令作为普通 `user_message` 原样发送，不引入特殊的命令执行通道，由 agent 自行解析执行。

#### Scenario: 区分视觉标识
- **WHEN** popover 同时列出 `command` 与 `skill` 两类候选
- **THEN** 两类 SHALL 呈现不同的视觉标识（如图标）

#### Scenario: 选中后作为普通消息发送
- **WHEN** 用户选中 `/clear` 并提交发送
- **THEN** 发送 `{"type":"user_message","session_id":"abc","content":"/clear"}`
- **AND** SHALL NOT 走特殊的命令执行通道，复用现有 `user_message` 机制

### Requirement: 命令列表反映 agent 实际可用性
当 daemon 能获取会话 agent 的 init 事件时，命令名集 SHALL 优先取自 init 报告的 `slash_commands` 字段——它反映 `-p` 环境下 agent 实际可用的命令（例如 `/model` 因不可用而被排除）。文件扫描结果仅用于补充 `description` 与 `arg_hint`。当无 init 数据可用时（如终端会话），SHALL 回退到纯文件扫描（含静态 builtin 表）。

#### Scenario: 以 init 报告的命令为准
- **WHEN** 会话 agent 的 init 事件 `slash_commands` 含 `clear`、`compact`、`codex:status`，且不含 `model`
- **THEN** `command_list` SHALL 含 `clear`、`compact`、`codex:status`
- **AND** SHALL NOT 含 `model`（即便静态 builtin 表中存在）

#### Scenario: 无 init 数据时回退扫描
- **WHEN** 会话没有 init 数据（如终端会话，或 agent 尚未发出 init）
- **THEN** `command_list` SHALL 回退到文件扫描结果（含静态 builtin 表的命令）

# Slash Command Icons 设计

**日期**: 2026-06-17
**状态**: 已批准（待实现）

## 背景

会话详情页输入框的 slash command 快捷提示（`CommandPopover`）当前用 emoji 区分类型：

```vue
{{ c.kind === 'skill' ? '📘' : '🔧' }}
```

问题：
1. **emoji 与系统风格不统一**——系统其他图标（SessionActions、copy-btn 等）用 SVG outline（stroke-width 2），emoji 显得突兀
2. **分类粗糙**——只按 `kind`（command/skill）二分，未体现 `source`（builtin/project/user/plugin）来源差异
3. **未标记 web 不可执行命令**——`kind: 'command'`（local command）在 web PTY 下返回 "isn't available in this environment"（claude 检测 PTY 为非交互），但当前提示无任何标记，用户选中才知道不可用

## claude slash command 类型分类

`CommandItem`（useWebSocket.ts:32-35）两个维度：

```
kind:   'command' | 'skill'
source: 'builtin' | 'project' | 'user' | 'plugin'
```

| kind | 含义 | 例子 | web 可执行 |
|------|------|------|-----------|
| `command` | local command（客户端本地执行） | /clear /compact /model /context /help | ❌ PTY "isn't available" |
| `skill` | skill（SKILL.md，LLM 执行） | /pocket-release /opsx:new /codex:rescue | ✅ |

**web 不可执行 = 所有 `kind: 'command'`**。`kind: 'skill'`（任意 source）可执行。

## 设计

### icon 矩阵（kind + source 组合，SVG outline）

5 类，lucide/feather 风格 SVG（stroke-width 2，14×14，与系统图标一致）：

| kind | source | icon | 理由 | web 可执行 |
|------|--------|------|------|-----------|
| `command` | builtin | **Terminal** (`>_`) | 本地命令（终端执行） | ❌ 灰显 |
| `skill` | builtin | **Sparkles** (✨) | 内置 skill（/commit /review） | ✅ |
| `skill` | project | **Folder** (📁) | 项目 .claude/skills（/pocket-release） | ✅ |
| `skill` | user | **User** (👤) | 用户级 skill | ✅ |
| `skill` | plugin | **Puzzle** (🧩) | 插件 skill（/opsx:* /codex:*） | ✅ |

### 视觉规则

```
┌─ slash command 提示（CommandPopover）─────────────┐
│ [Terminal]_  /clear      清空上下文        ← 灰显（command, web 不可执行）
│ [Terminal]_  /compact    压缩历史          ← 灰显 + tooltip"web 不支持，在终端使用"
│ [Sparkles]✨ /commit      创建提交          ← 正常（builtin skill）
│ [Folder]📁  /pocket-release  发布流程      ← 正常（project skill）
│ [Puzzle]🧩  /opsx:new    openspec    ← 正常 + namespace 徽章（plugin skill）
└────────────────────────────────────────────────────┘
```

- **SVG outline**（stroke-width 2），替换当前 emoji
- **command 灰显**（`opacity: 0.4`）+ hover tooltip「web 不支持，在终端使用」
  - ⚠️ **实现修正（2026-06-17，d7396c12 实测）**：移除灰显。claude 的 command 可用性是**运行时判断**（非所有 command 不可）：`/clear /loop /compact` 在 PTY **可执行**（compact 有 "Compacted" stdout），仅 `/help /model` 等 isn't available。web 无法预知（command_list 不标 available），故不灰显——Terminal icon 标识 command 类型即可，执行后 isn't-available 由 command_receipt（status unavailable）显示。
- **plugin skill** 保留现有 namespace 徽章（`.cmd-source`）
- icon 尺寸 14×14（与 SessionActions 菜单图标一致）

### 映射函数

```ts
function commandIcon(c: CommandItem): string {
  // 返回 inline SVG（lucide path）
  if (c.kind === 'command') return SVG_TERMINAL      // 灰显由 CSS class 控制
  switch (c.source) {
    case 'builtin': return SVG_SPARKLES
    case 'project': return SVG_FOLDER
    case 'user':    return SVG_USER
    case 'plugin':  return SVG_PUZZLE
  }
}
```

CSS：
```css
.cmd-row.is-command { opacity: 0.4; }  /* command 灰显 */
.cmd-row.is-command:hover { opacity: 0.7; }  /* hover 提示可读 */
```

## 改动范围

- **`web/src/components/CommandPopover.vue`**：
  - 替换 emoji 为 SVG icon 函数（`commandIcon`，按 kind+source 映射 5 个 lucide SVG）
  - command 行灰显（`.is-command` class + opacity）+ tooltip
  - 保留 plugin namespace 徽章
- **纯前端**（icon 渲染），无 daemon/relay/protocol 改动
- `CommandItem` 数据结构不变（已有 kind/source/namespace）
- `CommandPopover.test.ts` 更新（icon 断言）

## 非 Goal

- 不改 command 列表获取（list_commands 协议不变）
- 不实现"command 在 web 执行"（PTY 限制是 claude 侧，非 pocketctl 可控）
- 不过滤 command（保留显示 + 灰显，让用户知道存在但需终端用）
- 不加 icon 库依赖（inline SVG，与现有 SessionActions 图标一致）

## 风险

| 风险 | 缓解 |
|------|------|
| lucide SVG path 错（手抄） | 用 lucide 官方 path（已知 stroke-width 2）；或 emoji fallback |
| command 灰显用户困惑（为何灰） | tooltip「web 不支持，在终端使用」明确原因 |
| source 新类型（未来） | default fallback（skill 默认 Sparkles，command 默认 Terminal） |

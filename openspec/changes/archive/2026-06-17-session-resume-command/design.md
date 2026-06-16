## Context

web 客户端的会话（daemon 创建 / terminal 发现）常需在主机终端恢复继续（local command/skill 完整支持、交互体验、自动化）。cross-device-handoff spec 提过 `claude --resume` 但无实际 UI，且未覆盖 codex。本 change 实现「恢复会话命令」入口（两处）+ 多 agent 命令映射 + 复制到粘贴板。

## Goals

- web 会话（claude-code / codex）一键复制终端恢复命令
- 命令含 cwd（`cd "<cwd>" &&`），用户在终端粘贴即恢复
- 两处入口（列表卡片 + 详情页），共享构建逻辑
- opencode 后续支持（本次隐藏入口）

## Non-Goals

- 不改 daemon / relay / protocol（纯前端 clipboard）
- 不实现 opencode resume（后续）
- 不弹 dialog（仅复制 + toast）

## Decisions

### D1: 共享 `buildResumeCommand(session)` 工具函数
放 `web/src/utils/resumeCommand.ts`（或就近 composable）。SessionActions + SessionDetail 复用，避免两处重复命令构建逻辑。签名：
```ts
buildResumeCommand(session: { agent?: string; cwd?: string; session_id: string }): string
```

### D2: agent 命令映射（claude / codex，opencode 隐藏）
```ts
const cmd = session.agent === 'codex' ? `codex resume ${sid}`
          :                            `claude --resume ${sid}`  // claude-code 默认
```
opencode 在**调用方**隐藏入口（`v-if="session.agent !== 'opencode'"`），`buildResumeCommand` 不处理 opencode（避免误用）。后续支持时加 `opencode -s ${sid}` 分支 + 移除 v-if。

依据：`claude --help`（`--resume`）、`codex resume --help`（`[SESSION_ID]` 参数）、`opencode --help`（`-s, --session` flag，无 resume 子命令——本次不做）。

### D3: 入口两处
- **SessionActions**（列表卡片 ⋮ 菜单）：加菜单项「🖥️ 恢复会话命令」（在「导出记录」后、「删除」分隔符前），`v-if agent !== opencode`
- **SessionDetail**（详情页 header）：加按钮（header 右侧，与返回/主机 chip 同区），`v-if`

### D4: 仅复制 + toast（复用 copyId 模式）
点击 → `navigator.clipboard.writeText(cmd)`（fallback `execCommand('copy')` textarea）→ toast「已复制恢复命令 — 在主机终端粘贴运行」。与现有「复制会话 ID」一致的轻交互。

### D5: cwd 引号 + fallback
`cd "<cwd>"`（引号包裹，防空格/特殊字符破坏命令）。session 无 cwd → `cd ~`。

## Architecture / Data Flow

```
session 对象（agent, cwd, session_id）
       ↓ buildResumeCommand(session)
  codex? → `cd "<cwd>" && codex resume <sid>`
  else   → `cd "<cwd>" && claude --resume <sid>`
       ↓ navigator.clipboard.writeText
  粘贴板 ← cd "/Users/x/proj" && claude --resume abc-123
       ↓
  toast「已复制恢复命令 — 在主机终端粘贴运行」

用户在主机终端粘贴 → cd 到 cwd → agent CLI resume session（加载 web 历史继续）
```

## 改造点

- **新增** `web/src/utils/resumeCommand.ts`：`buildResumeCommand(session)` + 单测
- **SessionActions.vue**：菜单项「恢复会话命令」+ `copyResumeCmd()`（复用 copyId 的 clipboard fallback）+ `v-if`
- **SessionDetail.vue**：header 按钮「恢复会话命令」+ 同 copyResumeCmd（或调 utils + 本地 clipboard）

## Risks / Trade-offs

| 风险 | 缓解 |
|------|------|
| opencode session 无入口（用户困惑） | 后续加 `opencode -s`；本次 opencode 占比低 |
| cwd 跨主机不存在 | pocketctl 单 daemon 主机，用户终端同主机；多主机时命令注明主机（未来） |
| clipboard 权限（部分浏览器） | execCommand fallback（copyId 已验证） |
| session 无 cwd | `cd ~` fallback |

## Open Questions

- `buildResumeCommand` 放 utils 文件还是 SessionActions 内 export？（倾向 utils，单测方便 + 复用清晰）
- SessionDetail header 按钮样式（文字按钮 / 图标按钮）？倾向文字「恢复会话命令」（与 header 其他元素一致）

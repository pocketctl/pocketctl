## 1. `buildResumeCommand` 工具函数

- [x] 1.1 新增 `web/src/utils/resumeCommand.ts`：`buildResumeCommand(session: { agent?: string; cwd?: string; session_id: string }): string`
  - claude-code → `cd "<cwd>" && claude --resume <sid>`
  - codex → `cd "<cwd>" && codex resume <sid>`
  - cwd 引号包裹；无 cwd → `cd ~`
- [x] 1.2 单元测试（vitest）：claude-code / codex 命令格式 / 无 cwd fallback / cwd 含空格引号 / opencode 不在此处理（调用方隐藏）

## 2. SessionActions 菜单项（列表卡片 ⋮）

- [x] 2.1 `SessionActions.vue` 菜单加「🖥️ 恢复会话命令」项（位置：「导出记录」后、删除分隔符前），`v-if="session.agent !== 'opencode'"`
- [x] 2.2 `copyResumeCmd()`：调 `buildResumeCommand(props.session)` → `navigator.clipboard.writeText`（复用 `copyId` 的 `execCommand` fallback）→ `showToast('已复制恢复命令 — 在主机终端粘贴运行')` + 关菜单

## 3. SessionDetail header 按钮（详情页）

- [x] 3.1 `SessionDetail.vue` header（返回/主机 chip 同区，右侧）加「恢复会话命令」按钮，`v-if="currentSession?.agent !== 'opencode'"`
- [x] 3.2 `copyResumeCmd()`：同 2.2（调 utils + clipboard + toast）

## 4. 测试与验证

- [x] 4.1 `cd web && npx vue-tsc --noEmit`
- [x] 4.2 `buildResumeCommand` 单测通过
- [x] 4.3 web 实测 ✓（用户实测通过）：claude-code 会话复制 `cd "<cwd>" && claude --resume <sid>` / codex 会话复制 `codex resume` / opencode 会话隐藏入口 / 无 cwd 会话 `cd ~`
- [x] 4.4 回归：现有 SessionActions 菜单（复制 ID/固定/重命名/导出/删除）不受影响

---

**实现顺序建议**：1（utils + 单测）→ 2（SessionActions）→ 3（SessionDetail）→ 4（测试 + 实测）。纯 web，~40 行，无 daemon/relay 改动。

**关键点**：1.1 agent 命令映射、2.1/3.1 opencode v-if 隐藏、2.2 clipboard fallback（复用 copyId）。

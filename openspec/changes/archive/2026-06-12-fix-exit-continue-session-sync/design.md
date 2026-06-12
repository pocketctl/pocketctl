## Context

Claude Code 在两个目录下存储 session 数据：

```
~/.claude/
├── sessions/<pid>.json     ← PID 元数据（exit 后删除，continue 后新建）
└── projects/<id>.jsonl     ← 对话内容（持久保留，continue 后追加写入）
```

pocketctl daemon 通过 `SessionWatcher`（fsnotify）监控 `sessions/` 目录来发现终端的 Claude Code 进程，通过 `JSONLTailer` 持续读取 `projects/` 下的 JSONL 文件获取对话事件。

当前 exit→continue 的完整链路有三处断裂：

1. **watcher**：`handleRemovedFile` 将 sessionId 从 `knownSessions` 中删除 → 新 PID 文件创建时找不到已有记录 → 触发 `discovered` 而非 `changed`
2. **manager**：`RegisterTerminalSession` 对已存在的 terminal session 直接 `return false`，不更新 PID/status/ExitReason
3. **handler**：`!registered` 分支直接 `break`，不发出 `session_status` 事件

三者叠加导致 session 状态永远停在 `exited`，relay/DB 无法感知 session 已恢复。

## Goals / Non-Goals

**Goals:**
- exit→continue 后，relay/DB 中的 session status 从 `exited` 恢复为 `busy`
- web 客户端的"已退出" banner 消失，新对话内容正常显示
- 改动最小化，不引入新的数据结构或 goroutine 管理

**Non-Goals:**
- 处理 JSONL 文件被手动删除或重建（新 inode）的场景——这需要 tailer 重启机制，复杂度高、收益低
- 处理 daemon 重启期间的 continue（ta 会走 `scanExisting`，需单独评估但不在本次范围）
- 修改 relay 或 web 端逻辑——问题完全在 daemon 侧

## Decisions

### Decision 1：保留 knownSessions 而非在 handler 中补偿

**选项 A**：在 `handleWatcherEvents` 的 discovered 分支中补偿状态更新（治标）
**选项 B**：不在 `handleRemovedFile` 中删除 `knownSessions` 条目（治本）
**选项 C**：同时做 A + B

**→ 选择 C（防御纵深）**：B 修复根因（让 handleNewFile 正确走 changed 路径），A/C 中改动 3 作为安全网（万一某些边缘情况仍触发 discovered）。两处改动都极简（各 ~5 行），不增加复杂度。

**为什么不是选项 A alone**：`changed` handler 已正确调用 `SetSessionStatus`，让基础架构正确工作比在每个边缘 case 中补偿更好。

### Decision 2：不引入 TailerCancel 机制

最初方案考虑在 `ProcessState` 中增加 `TailerCancel context.CancelFunc` 字段，在 re-discovery 时取消旧 tailer 并启动新 tailer。

**放弃原因**：
- `claude --resume` 将新内容追加写入**同一个 JSONL 文件**（同 inode），旧 tailer 的文件句柄和 offset 继续有效，`Stat()` 能正确看到 size 增长
- 引入 goroutine 生命周期管理增加复杂度（需要正确的 cancel 传播、竞态处理）
- 目前每个 session 只有一个 fire-and-forget tailer goroutine，改动 2+3 不改变这个假设

### Decision 3：RegisterTerminalSession 更新已有 session 而非创建新的

之前 `return false` 时完全不修改 `ProcessState`。现改为更新 `Pid`、`Status`、清空 `ExitReason`。旧 tailer 继续运行——它在 session exit 期间因 `Stat().Size() <= offset` 一直返回空，continue 后 JSONL 有新内容追加，自动恢复输出。

**备选方案**：重启 tailer 并 `NewJSONLTailerFromStart`（重放全部历史 → 大量重复事件）→ 放弃。

## Risks / Trade-offs

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| `knownSessions` 不删除导致内存中残留已不存在 session 的条目 | 极低 — 进程内 map，最多几十条目，进程退出即释放 | 无需处理 |
| 两个不同 sessionId 的 PID 文件指向同一 sessionId（Claude Code 内部 bug） | 极低 | `register` 已有 `ON CONFLICT` 保护，DB 层不可重复 |
| JSONL 文件被重建（新 inode）时旧 tailer 失效 | 低 — `--resume` 追加到现有文件 | 如果出现，daemon 重启后 `scanExisting` + 新 tailer 自动修复 |
| `handleRemovedFile` 保留后产生重复的 "removed" + "changed" 事件 | 无 — "removed" 和 "changed" 基于不同文件，各自产生独立事件 | relay `insertEvent` 有 MD5 去重 |

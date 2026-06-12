## Why

当用户在终端中 `/exit` 退出 Claude Code，再执行 `claude --continue` 恢复同一会话时，web 客户端无法同步恢复后的状态和内容。Session 的 status 永远停在 `exited`，用户看到的"已退出" banner 不消失，新对话内容可能完全无法显示。根本原因是 exit→continue 过程中 SessionWatcher 的去重逻辑错误地把同一 session 的重新出现判定为 `discovered` 而非 `changed`，且 handler 层对 re-discovery 场景没有任何处理。

## What Changes

- **修复 SessionWatcher 去重逻辑**：`handleRemovedFile` 不再从 `knownSessions` 中删除条目，使得同一 sessionId 的新 PID 文件能被正确识别为 `changed`
- **修复 RegisterTerminalSession**：对已存在的 terminal session 被重新发现时（exit→continue），更新内存中的 PID、status、ExitReason，而不是直接返回 false
- **修复 handleWatcherEvents discovered 分支**：在 !registered 的情况下仍然发出 `SetSessionStatus` 事件，确保 relay/DB 状态从 `exited` 恢复为 `busy`

## Capabilities

### New Capabilities
<!-- No new capabilities — this is a bug fix -->

### Modified Capabilities
- `session-sync`: terminal session 的 exit→continue 生命周期中，relay/web 的状态同步行为修正——session 重新活跃时状态应从 `exited` 恢复为 `busy`，内容继续实时推送

## Impact

- **Affected code**：`internal/watcher/watcher.go`（1 处删除）、`internal/session/manager.go`（逻辑分支修改）、`cmd/pocketctl/main.go`（discovered handler 增强）
- **Total diff**：约 21 行，3 个文件
- **Risk**：低。不引入新字段、不改变数据结构、不改变 goroutine 生命周期。`knownSessions` 为进程内内存 map，不删除条目不会造成泄漏
- **Breaking changes**：无
- **需要测试的场景**：正常 exit→continue、进程 crash 后 continue、多次 exit→多次 continue

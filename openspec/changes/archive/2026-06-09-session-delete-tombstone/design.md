## Context

当前 pocketctl 没有 session 删除功能。exited 状态的 session 会一直堆积在 App 列表中。Watcher 以文件路径（PID）为 key 跟踪 session，导致 `claude --continue` 产生重复记录。

现有架构：
- Watcher 监控 `~/.claude/sessions/*.json` 文件，文件名是 PID
- Watcher 通过 `knownFiles[filepath]` 跟踪已知 session
- Relay 通过 `sessions` 和 `events` 表存储 session 数据
- App 通过 WebSocket 接收实时事件 + `list_sessions` 查询

## Goals / Non-Goals

**Goals:**
- 用户可以删除 exited 状态的 session
- 删除仅影响 Relay DB，不触碰 daemon/终端/JSONL 文件
- 被删除的 session 通过 `claude --continue` 恢复时能重新出现
- Watcher 以 session ID 为 key 跟踪，消除 `--continue` 产生的重复
- 多设备同步删除状态

**Non-Goals:**
- 不支持删除 running/idle/busy 等活跃状态的 session
- 不清理磁盘上的 JSONL 文件
- 不实现批量删除

## Decisions

### D1: 删除范围 — 仅 Relay DB

删除操作只清除 `sessions` 和 `events` 表中的记录，不通知 daemon kill 进程。

**理由**：exited 状态的 session 进程已死，daemon 侧的 `sm.sessions` 记录会在 daemon 重启时自然清理。保持删除操作的单向性（App → Relay）简化逻辑。

### D2: 墓碑机制 — `deleted_sessions` 表

新增 `deleted_sessions` 表记录被删除的 session ID。`session_discovered` 事件到达时检查墓碑，存在则跳过。

**表结构**：
```sql
CREATE TABLE deleted_sessions (
  session_id VARCHAR(64) PRIMARY KEY,
  deleted_at TIMESTAMPTZ DEFAULT NOW()
);
```

**替代方案考虑**：
- 在 `sessions` 表加 `deleted` 标记 → 不选，因为会让所有查询都加 `WHERE deleted = false`
- Daemon 侧标记 → 不选，用户需求是不操作 daemon

### D3: 墓碑拦截粒度 — discovered 拦截，changed 不拦截

```
session_discovered（首次发现）→ 检查墓碑 → 存在则跳过
changed（文件内容更新）→ 不检查墓碑 → 正常处理
```

**理由**：
- Daemon 重启后扫描所有 session 文件，exited 的会被重新发现 → discovered → 被墓碑拦截
- 用户 `--continue` 时 Claude CLI 更新 session 文件（PID、status）→ changed → 不被拦截 → session 恢复

### D4: Watcher 重构 — session ID 为 key

将 `knownFiles map[string]DiscoveredSession`（filepath→session）改为 `knownSessions map[string]DiscoveredSession`（sessionId→session）。新增 `fileToSession map[string]string`（filepath→sessionId）辅助索引。

**`handleNewFile` 逻辑**：
```
解析 session 文件 → 获取 sessionId
if sessionId 在 knownSessions 中：
    更新 filepath、PID、status → 发送 "changed"
else：
    注册为新 session → 发送 "discovered"
```

**`handleRemovedFile` 逻辑**：
```
通过 fileToSession 找到 sessionId
删除 fileToSession[path]
检查是否还有其他 filepath 指向该 sessionId
如果没有 → 删除 knownSessions[sessionId] → 发送 "removed"
如果有 → 只更新记录，不发送事件
```

### D5: 删除广播 — 通知同 userId 所有客户端

`session_delete` 处理完成后，广播 `session_deleted` 给同 userId 的所有 WebSocket 客户端，而非仅回复发起者。

**理由**：用户可能在 iPhone 和 iPad 上同时使用 App，删除操作需要同步。

### D6: App 端交互 — 右滑删除

仅 exited/completed/error/killed 终态 session 可右滑露出删除按钮。使用 `SwipeToDelete` 包装组件，左滑露出红色删除按钮。

## Risks / Trade-offs

**[R1] 墓碑表无限增长** → 已实现定时清理：每 6 小时清理超过 30 天的墓碑记录（`db.cleanStaleTombstones()`，`server.ts` 定时任务）。

**[R2] 并发删除与 --continue** → 如果用户删除 session 后立即 `--continue`（< 1秒），changed 事件可能在 delete 之前到达。由于 changed 不受墓碑拦截，session 会恢复，而随后的 delete 会再次删除。这是极端场景，可接受。

**[R3] Watcher 重构引入回归** → 改动集中在 watcher.go 一个文件，下游（main.go、SessionManager、Relay、iOS）全部按 sessionId 处理，无需修改。通过 Daemon 重启后的全量扫描验证正确性。

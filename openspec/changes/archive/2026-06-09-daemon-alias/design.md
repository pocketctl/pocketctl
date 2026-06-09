## Context

当前 `daemons` 表只有 `daemon_id`、`hostname`、`agents` 等系统字段。用户在主机列表中看到的是操作系统 hostname（如 `MacBook-Pro`、`ubuntu-vm-01`），难以区分多台主机。设计稿 `screens-daemon-list.html` 定义了内联重命名交互：点击编辑按钮 → 展开输入框 → 确认/取消 → 显示别名 badge + 恢复默认按钮。

项目是多用户架构（`daemons.user_id`），别名需跨设备同步，因此选择服务端持久化而非纯客户端存储。

## Goals / Non-Goals

**Goals:**
- 用户可以为任意已注册主机设置自定义别名
- 别名持久化在服务端，跨设备同步
- 别名通过 WebSocket 实时同步到所有已连接客户端
- iOS 端实现设计稿的内联编辑 UI
- 排序和搜索使用别名（别名优先于 hostname）

**Non-Goals:**
- 别名不用于 CLI 端（daemon 端不感知别名）
- 不支持别名历史或审计
- 不限制别名唯一性（不同主机可以有相同别名）

## Decisions

### 1. 存储层：daemons 表新增 alias 列

**选择**：`ALTER TABLE daemons ADD COLUMN alias VARCHAR(64)`（可空）

**理由**：别名与 daemon 是 1:1 关系，直接加列最简单。不需要新表。设为可空，NULL 表示未设置别名（显示 hostname）。

**备选**：独立的 `daemon_aliases` 表 —— 过度设计，增加 JOIN 复杂度。

### 2. API 设计：RESTful PUT 端点

**选择**：`PUT /api/daemons/:daemonId/alias`，body `{ "alias": "我的Mac" }` 或 `{ "alias": null }` 清除

**理由**：
- 需要 Bearer token 认证，只能操作自己的 daemon
- 用 PUT 语义（幂等设置）
- 传 null 或空字符串清除别名

### 3. WebSocket 同步：daemon_status 事件携带 alias

**选择**：在 `upsertDaemon` 查询结果和 `daemon_status` 广播中包含 `alias` 字段

**理由**：客户端通过现有的 `daemon_status` 事件即可获取最新别名，无需额外消息类型。

### 4. iOS UI 状态管理：DaemonCard 内部 @State

**选择**：`DaemonCard` 内部用 `@State` 管理 `isEditing` 和 `editText`

**理由**：编辑状态是纯 UI 关注点，不需要提升到 ViewModel。ViewModel 只负责保存结果（调 API）。设计稿的交互完全在卡片内部完成。

### 5. 乐观更新策略

**选择**：iOS 端先本地更新 UI，API 调用后台执行。失败时回滚并提示。

**理由**：内联编辑的 UX 需要即时反馈，等 API 返回再更新会感觉迟钝。

## Risks / Trade-offs

- **[别名长度溢出]** → 前端 maxlength=32，API 层截断到 64 字符
- **[并发修改冲突]** → 别名是单用户操作，最后写入胜出（Last Write Wins），可接受
- **[daemon 不属于当前用户]** → API 层校验 `user_id`，返回 403
- **[排序变化突兀]** → 设别名后排序可能跳变，但这是预期行为（用户主动改了名称）

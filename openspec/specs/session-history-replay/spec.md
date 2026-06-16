## Purpose
SessionDetail 页面通过 relay replay 加载完整对话历史，并将事件渲染为不同样式的消息（agent 文本 / 工具调用 / 工具结果 / 错误）。

## ADDED Requirements

### Requirement: Session detail page loads full conversation history on mount
SessionDetail 页面在挂载时 SHALL 通过 WebSocket 发送 `{ type: "replay", session_id, direction: "backward", limit: 50 }` 请求**最近 50 条**历史事件（反向分页，非全量加载）。收到的事件（relay 以 id DESC 返回）reverse 后渲染（旧在上、新在下），滚动到底部。向上滚动到顶 + `has_more` 时翻页加载更早 50 条。

#### Scenario: User opens a session (initial load = recent 50)
- **WHEN** 用户从 session 列表点击一个 session
- **THEN** SessionDetail 发送 `replay { direction: "backward", limit: 50 }`
- **AND** relay 返回最近 50 条（`id DESC LIMIT 50`），web reverse 后渲染 + 滚到底
- **AND** 不全量加载（首屏快速，大 session 从 5524 → 50）

#### Scenario: User opens a running session
- **WHEN** 用户点击一个正在运行的 session
- **THEN** 先 backward 加载最近 50，然后实时接收新事件 append

#### Scenario: 向后兼容（旧客户端）
- **WHEN** 客户端发 `replay { last_seq: 0 }`（无 direction）
- **THEN** relay 当 forward（现有全量行为），不破坏旧客户端

### Requirement: Conversation events are rendered with proper message types
系统 SHALL 根据事件类型渲染不同样式的消息气泡：
- `agent_text`: agent 文本回复，支持 streaming 状态的打字光标
- `tool_call`: 工具调用，显示工具名称和格式化的 input 参数
- `tool_result`: 工具结果，折叠展示，可展开查看完整 output
- `error`: 红色错误提示
- `user_message`: 用户消息（从 session 中 replay 或实时发送的）

#### Scenario: Agent reads a file
- **WHEN** agent 执行文件读取工具调用
- **THEN** 显示工具名称（如 `Read`）和文件路径，结果可折叠展开

#### Scenario: Agent streams a text response
- **WHEN** agent 产生 `agent_text` 事件
- **THEN** streaming=true 时显示打字光标，streaming=false 时光标消失

### Requirement: Replay handles large event sets without blocking UI
当 session 包含大量事件时，前端 SHALL 分批渲染或使用虚拟滚动，确保页面不卡顿。Phase 1 允许全量加载但需在 500ms 内完成首屏渲染。

#### Scenario: Session with 500+ events
- **WHEN** 用户打开一个包含 500+ 事件的 session
- **THEN** 页面在 1 秒内渲染完成，滚动流畅

### Requirement: Replay protocol pagination (direction / limit / cursor / has_more)
`replay` 消息 SHALL 支持分页参数：`direction`（`forward` 默认 / `backward`）、`limit`（每页条数，默认 50）、`last_seq`（cursor）。relay SHALL 按 direction 分流查询：
- `forward`：`id > last_seq ORDER BY id ASC`（现有，实时补齐 / 增量）
- `backward` + 无 `last_seq`：`ORDER BY id DESC LIMIT N`（最近 N）
- `backward` + `last_seq=X`：`id < X ORDER BY id DESC LIMIT N`（X 之前 N 条）

`replay_end` SHALL 带 `has_more`（count-based：返回条数 = limit → has_more=true）。`replay_batch` / `replay_end` 的 `req_id` 透传用于 backward 翻页去重。

#### Scenario: backward 首次（最近 N）
- **WHEN** 客户端发 `replay { direction: "backward", limit: 50, req_id: 1 }`
- **THEN** relay 返回最近 50 条 + replay_end { has_more, req_id: 1 }

#### Scenario: backward 翻页（cursor 前 N）
- **WHEN** 客户端发 `replay { direction: "backward", last_seq: 5424, limit: 50, req_id: 2 }`
- **THEN** relay 返回 `id < 5424` 的 50 条 + replay_end { has_more, req_id: 2 }

#### Scenario: has_more 信号
- **WHEN** backward 返回条数 = limit
- **THEN** replay_end { has_more: true }（可能还有更早）
- **AND** has_more: false 时顶部不再触发翻页

### Requirement: 向上滚动翻页与滚动位置保持
web SessionDetail SHALL 监听滚动到顶（`scrollTop ≈ 0`）+ `has_more` + 无翻页在途时触发 backward 翻页（`last_seq` = 最旧已加载 id）。新批次（id DESC）reverse 后 prepend。prepend 后 SHALL 手动恢复 scrollTop（`scrollTop = oldScrollTop + (newScrollHeight - oldScrollHeight)`）保持视口。**`overflow-anchor` SHALL 禁用**（`none`）——浏览器原生锚定会错锚到新 prepend 的顶部元素，把视口拉到最早记录。

#### Scenario: 滚到顶触发翻页
- **WHEN** 用户滚到顶部 + `has_more=true` + 无翻页在途
- **THEN** web 发 backward replay（`last_seq=最旧id, limit=50, req_id=递增`）+ reverse + prepend

#### Scenario: prepend 后保持滚动位置（手动 scrollTop）
- **WHEN** prepend 了 50 条更早事件
- **THEN** `scrollTop = oldScrollTop + ΔscrollHeight`（手动，nextTick 后）
- **AND** 视口可见内容不变（不跳顶）

#### Scenario: 翻页请求去重
- **WHEN** 翻页请求在途时再次滚到顶
- **THEN** 不重复发请求（isLoadingBackward 标志）

### Requirement: id-based 去重边界（实现省略 —— 不必要）
~~realtime `id > loadedMaxId` 才 append~~。**实现发现不必要**：realtime 事件是 payload 原始事件（无 db id），且 relay subscribe 在 replay 同消息生效（router.ts），backward(id≤X) 与 realtime(id>X) 时序上不重叠。依赖 subscribe 时序 + 现有 `isDuplicate`（邻接文本去重）兜底，无需 id 去重。`loadedMaxId` 未引入。

### Requirement: 固定分页大小 50
web 每页加载 50 条（移动/桌面统一），作为 `limit` 传 relay。原设计动态（移动 50 / 桌面 100），实现统一为 50（平衡首屏/翻页性能 + 减少单次 prepend 重排量）。

#### Scenario: 每页 50
- **WHEN** 用户打开 session 或向上翻页
- **THEN** replay `limit=50`（移动/桌面统一）

### Requirement: 回到底部浮动按钮（iOS 风格）
web SessionDetail SHALL 提供一个**固定悬浮**的"回到底部"按钮（`position: fixed`，视口右下角，不随内容滚动），有消息时常驻显示，点击 `scrollToBottom`。在底部时半透明（提示已在底部），hover 恢复。

#### Scenario: 按钮常驻 + 点击回底
- **WHEN** 会话有消息（无论是否在底）
- **THEN** 右下角 fixed 浮动按钮显示；点击滚动到底部
- **AND** 在底时 `opacity: 0.35`（半透明），hover 恢复

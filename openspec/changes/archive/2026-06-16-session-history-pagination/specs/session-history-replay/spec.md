## MODIFIED Requirements

### Requirement: Session detail page loads full conversation history on mount
SessionDetail 页面在挂载时 SHALL 通过 WebSocket 发送 `{ type: "replay", session_id, direction: "backward", limit: N }` 请求**最近 N 条**历史事件（N = 移动端 50 / 桌面端 100，按视口宽度判断），而非全量加载。收到的事件（relay 以 id DESC 返回）reverse 后渲染（旧在上、新在下），并滚动到底部（最新在底）。向上滚动到顶 + `has_more` 时翻页加载更早 N 条。

#### Scenario: User opens a session (initial load = recent N)
- **WHEN** 用户从 session 列表点击一个 session
- **THEN** SessionDetail 发送 `replay { direction: "backward", limit: N }`（N 按移动 50 / 桌面 100）
- **AND** relay 返回最近 N 条（`id DESC LIMIT N`），web reverse 后渲染 + 滚到底
- **AND** 不全量加载（首屏快速，大 session 从 5524 → 100）

#### Scenario: User opens a running session
- **WHEN** 用户点击一个正在运行的 session
- **THEN** 先 backward 加载最近 N，然后实时接收新事件（`id > 已加载最新id`）append

#### Scenario: 向后兼容（旧客户端）
- **WHEN** 客户端发 `replay { last_seq: 0 }`（无 direction 字段）
- **THEN** relay 当 forward（现有全量行为），不破坏旧客户端

## ADDED Requirements

### Requirement: Replay protocol pagination (direction / limit / cursor / has_more)
`replay` 消息 SHALL 支持分页参数：`direction`（`forward` 默认 / `backward`）、`limit`（每页条数）、`last_seq`（cursor）。relay SHALL 按 direction 分流查询：
- `forward`：`id > last_seq ORDER BY id ASC`（现有，实时补齐 / 增量）
- `backward` + 无 `last_seq`：`ORDER BY id DESC LIMIT N`（最近 N）
- `backward` + `last_seq=X`：`id < X ORDER BY id DESC LIMIT N`（X 之前 N 条）

`replay_end` SHALL 带 `has_more` 字段（cursor 前是否还有更早事件），客户端据此决定是否允许向上翻页。`replay_batch` / `replay_end` 的 `req_id` 透传机制（现有）继续用于 backward 翻页的去重。

#### Scenario: backward 首次（最近 N）
- **WHEN** 客户端发 `replay { direction: "backward", limit: 100, req_id: 1 }`
- **THEN** relay 返回最近 100 条（`id DESC LIMIT 100`）via replay_batch + replay_end { has_more: <是否还有更早>, req_id: 1 }

#### Scenario: backward 翻页（cursor 前 N）
- **WHEN** 客户端发 `replay { direction: "backward", last_seq: 5424, limit: 100, req_id: 2 }`
- **THEN** relay 返回 `id < 5424` 的 100 条（`DESC`）+ replay_end { has_more, req_id: 2 }

#### Scenario: has_more 信号
- **WHEN** backward 返回的 N 条中，最旧 id 大于该 session 的 min(id)
- **THEN** replay_end { has_more: true }（还有更早可翻页）
- **AND** has_more: false 时，客户端顶部显示"没有更多"且不再触发翻页

### Requirement: 向上滚动翻页与滚动位置保持
web SessionDetail SHALL 监听滚动到顶（`scrollTop ≈ 0`）+ `has_more` 时触发 backward 翻页（`last_seq` = 当前最旧已加载 id）。新批次（relay 以 id DESC 返回）reverse 后 **prepend** 到列表顶部。prepend 后 SHALL 保持滚动位置：记录 prepend 前 `scrollHeight` 与 `scrollTop`，prepend 后 `scrollTop += (newScrollHeight - oldScrollHeight)`，避免视口跳到顶。

#### Scenario: 滚到顶触发翻页
- **WHEN** 用户滚动到顶部 + `has_more=true` + 无翻页请求在途
- **THEN** web 发 backward replay（`last_seq=最旧已加载id, limit=N, req_id=递增`）
- **AND** 收到 replay_batch 后 reverse + prepend

#### Scenario: prepend 后保持滚动位置
- **WHEN** prepend 了 N 条更早事件
- **THEN** `scrollTop` 调整为 `prepend前scrollTop + (prepend后scrollHeight - prepend前scrollHeight)`
- **AND** 用户视口可见内容不变（不跳顶）

#### Scenario: 翻页请求去重
- **WHEN** 翻页 backward 请求在途时用户再次滚到顶
- **THEN** 不重复发请求（在途标志 / req_id 机制）

### Requirement: id-based 去重边界（backward vs 实时）
web SHALL 跟踪已加载事件的 id 范围（最旧 id / 最新 id）。实时事件（forward）`id > 已加载最新id` 才 append 并更新最新id；`id ≤ 已加载最新id` 丢弃（防 backward 与实时在边界重复）。backward 翻页返回的事件 id 若已在范围内则跳过（防重复 prepend）。

#### Scenario: 实时事件 id 在已加载范围内丢弃
- **WHEN** backward 已加载 `id ≤ X`，收到实时事件 `id ≤ X`
- **THEN** 丢弃（已在 backward 中渲染），不重复 append

#### Scenario: 实时事件 id > 已加载最新 append
- **WHEN** 收到实时事件 `id > 已加载最新id`
- **THEN** append 到底部 + 更新已加载最新id

### Requirement: 动态分页大小（移动 / 桌面）
web SHALL 按视口宽度（或 UA）决定每页大小 N：移动端（窄屏，如 `< 768px`）N=50，桌面端 N=100。N 作为 `limit` 传给 relay。响应式断点与现有移动端适配（mobile-responsive capability）一致。

#### Scenario: 移动端 N=50
- **WHEN** 用户在移动端（视口 `< 768px`）打开 session
- **THEN** replay `limit=50`

#### Scenario: 桌面端 N=100
- **WHEN** 用户在桌面端（视口 `≥ 768px`）打开 session
- **THEN** replay `limit=100`

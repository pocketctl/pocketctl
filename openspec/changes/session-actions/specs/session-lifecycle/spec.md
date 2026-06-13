## MODIFIED Requirements

### Requirement: session_delete 带归属校验
relay 处理 session_delete 时 SHALL 校验该 session 属于发起方 user，否则拒绝删除。

#### Scenario: 删除自己的会话
- **WHEN** client 发送 `session_delete` 且 session 属于该 user
- **THEN** 删除 events+sessions+墓碑，广播 session_deleted

#### Scenario: 越权删除他人会话
- **WHEN** client 发送 `session_delete` 但 session 不属于该 user
- **THEN** 拒绝删除，返回 error

### Requirement: daemon 被动标题同步只覆盖默认标题
relay 处理 daemon 上报的 `session_title_update` 时 SHALL 只更新仍为默认模式（`Terminal Session-%`）的标题，保护用户自定义标题。

#### Scenario: daemon 覆盖默认标题
- **WHEN** daemon 上报标题且当前标题是 `Terminal Session-xxx`
- **THEN** 更新标题

#### Scenario: daemon 不覆盖用户改名
- **WHEN** daemon 上报标题但当前标题已被用户自定义
- **THEN** 不更新（保留用户标题）

## ADDED Requirements

### Requirement: session_pin 消息
新增 `session_pin` WS 消息，client 发起置顶/取消，relay 持久化并广播 `session_pinned` 给同 user 所有 client。

#### Scenario: 处理 session_pin
- **WHEN** client 发送 `{type:'session_pin', session_id, pinned:true}`
- **AND** session 属于该 user
- **THEN** relay `UPDATE sessions SET pinned=$1, pinned_at=NOW() WHERE session_id=$2 AND user_id=$3`
- **AND** 广播 `{type:'session_pinned', session_id, pinned:true}` 给同 user client

### Requirement: sessions.pinned 字段与排序
sessions 表 SHALL 新增 `pinned BOOLEAN DEFAULT false` 和 `pinned_at TIMESTAMPTZ` 列。listSessions 排序 SHALL 置顶项优先。

#### Scenario: 列表置顶排序
- **WHEN** 查询会话列表
- **THEN** ORDER BY `pinned DESC, pinned_at DESC NULLS LAST, COALESCE(last_activity_at, updated_at) DESC`
- **AND** SELECT 返回 pinned 字段

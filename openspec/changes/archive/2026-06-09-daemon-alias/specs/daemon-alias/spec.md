## ADDED Requirements

### Requirement: Daemon alias persistence
系统 SHALL 在 `daemons` 表中存储用户为主机设置的自定义别名。别名为可空的 VARCHAR(64) 字段，按 `user_id` 隔离。NULL 表示未设置别名。

#### Scenario: 设置别名
- **WHEN** 用户通过 API 为主机设置别名 "我的Mac"
- **THEN** 系统将该 alias 值写入 `daemons` 表对应行

#### Scenario: 清除别名
- **WHEN** 用户通过 API 发送 `alias: null` 或 `alias: ""`
- **THEN** 系统将 alias 设为 NULL

#### Scenario: 别名长度限制
- **WHEN** 用户提交超过 64 字符的别名
- **THEN** 系统截断到 64 字符后存储

### Requirement: Alias API endpoint
系统 SHALL 提供 `PUT /api/daemons/:daemonId/alias` 端点，需 Bearer token 认证。请求体为 `{ "alias": "string" | null }`。

#### Scenario: 成功设置别名
- **WHEN** 已认证用户发送 `PUT /api/daemons/daemon-abc/alias` body `{ "alias": "我的Mac" }`
- **THEN** 返回 200 `{ "success": true, "alias": "我的Mac" }`

#### Scenario: 成功清除别名
- **WHEN** 已认证用户发送 `PUT /api/daemons/daemon-abc/alias` body `{ "alias": null }`
- **THEN** 返回 200 `{ "success": true, "alias": null }`

#### Scenario: daemon 不属于当前用户
- **WHEN** 已认证用户尝试设置不属于自己 daemon 的别名
- **THEN** 返回 403 `{ "error": "forbidden" }`

#### Scenario: daemon 不存在
- **WHEN** 已认证用户对不存在的 daemonId 设置别名
- **THEN** 返回 404 `{ "error": "daemon not found" }`

#### Scenario: 未认证请求
- **WHEN** 未提供 Bearer token 的请求
- **THEN** 返回 401

### Requirement: WebSocket daemon_status carries alias
`daemon_status` 事件 SHALL 在 payload 中包含 `alias` 字段（string 或 null）。

#### Scenario: 有别名的 daemon 上线广播
- **WHEN** 一个有别名 "我的Mac" 的 daemon 上线
- **THEN** 广播 `daemon_status` 包含 `"alias": "我的Mac"`

#### Scenario: 无别名的 daemon 上线广播
- **WHEN** 一个未设置别名的 daemon 上线
- **THEN** 广播 `daemon_status` 包含 `"alias": null`

### Requirement: Alias updated via WebSocket
当别名字段变更后，系统 SHALL 在后续的 `daemon_status` 广播中反映最新值。无需额外的 WebSocket 消息类型。

#### Scenario: 别名修改后 daemon 重连
- **WHEN** 用户修改了别名，随后 daemon 断连重连
- **THEN** 新的 `daemon_status` 广播携带更新后的 alias 值

### Requirement: iOS inline rename UI
iOS DaemonCard SHALL 实现内联编辑交互：点击编辑按钮展开输入框，确认/取消操作，显示别名 badge 和恢复默认按钮。

#### Scenario: 进入编辑模式
- **WHEN** 用户点击 daemon 卡片上的编辑按钮（✏️）
- **THEN** 卡片内展开输入框，预填当前别名（无别名则为空），自动聚焦键盘

#### Scenario: 确认编辑
- **WHEN** 用户输入别名并点击确认（✓）或按回车
- **THEN** 系统调用 API 保存别名，卡片退出编辑模式，显示新别名 + 蓝色 badge "别名"

#### Scenario: 取消编辑
- **WHEN** 用户点击取消（✗）或按 ESC
- **THEN** 输入框收起，别名不变

#### Scenario: 恢复默认名称
- **WHEN** 用户点击"恢复默认"按钮
- **THEN** 系统调用 API 清除别名（传 null），卡片恢复显示原始 hostname，badge 和恢复按钮消失

#### Scenario: 显示逻辑
- **WHEN** daemon 有别名时
- **THEN** hostname 位置显示别名，旁边显示蓝色小标签 "别名"，并显示"恢复默认"按钮

#### Scenario: 编辑按钮可见性
- **WHEN** daemon 无别名时
- **THEN** 编辑按钮 hover/长按时可见（设计稿 opacity 过渡效果）

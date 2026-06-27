## ADDED Requirements

### Requirement: daemon 托管单例 opencode serve

daemon SHALL 拉起并维护一个长驻 `opencode serve` 进程，作为所有 opencode owned 操作与 foreign 续聊的入口。该进程 SHALL 设置 `OPENCODE_SERVER_PASSWORD`，daemon 的 HTTP/SSE 客户端 SHALL 携带对应鉴权。daemon SHALL 通过 `GET /api/health` 做健康检查并在崩溃时自动重启。

#### Scenario: serve 正常拉起

- **WHEN** daemon 启动且检测到 opencode 已安装
- **THEN** SHALL 拉起单例 `opencode serve` 并通过 `/api/health` 确认就绪

#### Scenario: serve 启动失败降级

- **WHEN** `opencode serve` 启动失败（如 DB schema 不兼容，实测曾报 `no such column: name`）
- **THEN** opencode owned 会话能力 SHALL 被禁用并向客户端给出明确提示
- **AND** 终端会话的发现与只读实时同步（经 storage）SHALL 仍然可用

#### Scenario: serve 崩溃重启

- **WHEN** 运行中的 serve 进程退出
- **THEN** daemon SHALL 自动重启它
- **AND** 重启期间受影响的 owned 会话 SHALL 标记为 degraded

### Requirement: opencode owned 会话经 serve API 达到对等能力

由客户端创建的 opencode 会话 SHALL 经 serve REST/SSE 提供与 claude/codex 对等的能力：建会话（`POST /api/session`）、发消息（`POST /api/session/{id}/prompt`）、实时输出（`/event` SSE）、中断、模型列表（`GET /api/model`）、context/用量（`GET /api/session/{id}/context`）、compact（`POST /api/session/{id}/compact`）。

#### Scenario: 创建并实时输出

- **WHEN** 客户端创建一个 opencode 会话并发送消息
- **THEN** sessionID SHALL 来自 `POST /api/session` 响应
- **AND** 助手输出 SHALL 经 `/event` SSE 实时同步到客户端

#### Scenario: 模型列表映射

- **WHEN** 客户端请求 opencode 的可用模型
- **THEN** daemon SHALL 经 `GET /api/model` 获取并把 `provider/model` 形态映射为 `protocol.ModelOption`

### Requirement: opencode 审批与交互统一进现有协议

opencode 的 `/permission` 与 `/question` SSE 事件 SHALL 被翻译为 daemon 现有的 approval / interactive_prompt 协议事件；客户端的回复 SHALL 反向调用 opencode 对应的 reply/reject endpoint。客户端 SHALL NOT 感知 opencode 专属协议。

#### Scenario: 工具审批

- **WHEN** opencode 会话触发一次权限请求
- **THEN** daemon SHALL 把它转为现有 approval 事件推给客户端
- **AND** 客户端的决定 SHALL 经 `POST /api/session/{id}/permission/{req}/reply` 回传

### Requirement: 终端 opencode 会话的发现、实时同步与续聊（CORE）

用户在终端正常运行 `opencode` 所创建的会话 SHALL 被 daemon 零配置发现、实时同步到客户端、并能在客户端续聊，无需用户改变 opencode 启动方式。daemon 与终端 opencode 进程 SHALL 通过共享磁盘（`~/.local/share/opencode` 的 SQLite + `storage/`）汇合，而非进程间直接通信。

#### Scenario: 发现终端会话

- **WHEN** 用户在终端运行 `opencode` 并开始一个会话
- **THEN** daemon SHALL 经 fsnotify 监视 `storage/session/<projectHash>/` 发现新 `ses_*.json`
- **AND** 从其 meta 读取 directory/title/time 并登记为 `Source: terminal`

#### Scenario: 实时同步终端会话

- **WHEN** 一个已发现的终端会话产生新消息/part
- **THEN** daemon SHALL 经 `DirWatch` 监视 `message/<sid>/` 与 `part/<msgId>/` 把更新实时同步到客户端

#### Scenario: 客户端续聊终端会话

- **WHEN** 客户端对一个终端发起的 opencode 会话发送消息
- **THEN** daemon SHALL 经其单例 serve 的 `POST /api/session/{id}/prompt` 续聊（共享 DB 可加载别进程创建的会话）
- **AND** 续聊产生的输出 SHALL 经实时通道回流到客户端

#### Scenario: 续聊不与终端撞车

- **WHEN** 客户端尝试续聊一个仍被终端活跃占用的会话
- **THEN** daemon SHALL 依据 `session.time.updated` 新鲜度与 serve 会话状态判活
- **AND** 在会话被终端占用时拒绝或排队，避免并发写冲突

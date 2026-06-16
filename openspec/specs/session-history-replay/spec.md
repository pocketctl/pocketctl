## Purpose
SessionDetail 页面通过 relay replay 加载完整对话历史，并将事件渲染为不同样式的消息（agent 文本 / 工具调用 / 工具结果 / 错误）。

## ADDED Requirements

### Requirement: Session detail page loads full conversation history on mount
SessionDetail 页面在挂载时 SHALL 通过 WebSocket 发送 `{ type: "replay", session_id, last_seq: 0 }` 请求历史事件，并将收到的事件渲染为对话消息列表。

#### Scenario: User opens a completed session from the list
- **WHEN** 用户从 session 列表点击一个已完成的 session
- **THEN** SessionDetail 页面加载并发送 replay 请求，收到所有历史事件后渲染完整的对话记录（用户消息、agent 文本、工具调用、工具结果）

#### Scenario: User opens a running session
- **WHEN** 用户点击一个正在运行的 session
- **THEN** 先通过 replay 加载历史事件，然后实时接收新事件，两者无缝衔接

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

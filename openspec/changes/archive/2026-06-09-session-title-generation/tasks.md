## 1. Relay Server — GLM-4.6 集成

- [x] 1.1 在 `relay/.env.example` 新增 `ZHIPU_API_KEY` 环境变量说明
- [x] 1.2 创建 `relay/src/title.ts`：实现 `generateTitle(userMessage, assistantMessage)` 函数，调用 GLM-4.6 API（endpoint: `https://open.bigmodel.cn/api/paas/v4/chat/completions`，model: `glm-4.6`，max_tokens: 32，temperature: 0.3，stream: false）
- [x] 1.3 在 `title.ts` 中实现 3 秒超时机制：使用 `AbortController` 取消超时请求
- [x] 1.4 在 `title.ts` 中实现降级逻辑：API 调用失败或返回空时，fallback 到用户消息原文截断前 15 字
- [x] 1.5 在 `title.ts` 中实现 prompt 模板：系统 prompt 指示生成 ≤15 字、无引号、与用户消息同语言的简洁标题

## 2. Relay Server — 数据库条件更新

- [x] 2.1 在 `relay/src/db.ts` 新增 `updateTitleIfDefault(pool, sessionId, newTitle)` 函数：SQL 使用 `WHERE title LIKE 'Terminal Session-%'` 条件，仅覆盖默认标题
- [x] 2.2 在 `relay/src/db.ts` 新增 `hasDefaultTitle(pool, sessionId)` 辅助函数：检查 session 标题是否仍是默认值

## 3. Relay Server — 事件处理

- [x] 3.1 在 `relay/src/router.ts` 的 `handleDaemonMessage` 中新增 `generate_title_request` 事件处理分支
- [x] 3.2 实现事件处理流程：先调用 `hasDefaultTitle` 检查 → 若非默认值则跳过 → 调用 `generateTitle` → 调用 `updateTitleIfDefault` 写入 DB → 广播 `session_title_update` 给所有订阅客户端
- [x] 3.3 在 `session_discovered` 事件处理中，确认默认标题格式为 `Terminal Session-${sessionId.slice(-8)}`（当前已有，验证即可）

## 4. Go Daemon — 新增协议类型

- [x] 4.1 在 `internal/protocol/types.go` 中新增 `generate_title_request` 事件类型常量
- [x] 4.2 确认该事件的 payload 结构包含：`session_id`、`user_message`、`assistant_message`

## 5. Go Daemon — JSONL 消息提取扩展

- [x] 5.1 在 `internal/adapter/claude_jsonl.go` 新增 `ExtractFirstAssistantMessage(lines []string, maxLen int)` 函数：过滤 tool_use/tool_result，返回第一条 assistant 文本响应
- [x] 5.2 为新函数编写单元测试

## 6. Go Daemon — Session Manager 扩展

- [x] 6.1 在 `internal/session/manager.go` 的 `ProcessState` 结构体中新增 `TitleGenerated bool` 字段
- [x] 6.2 新增 `GenerateTitle(sessionID, userMessage, assistantMessage)` 方法：检查 `TitleGenerated` flag，若为 false 则发送 `generate_title_request` 事件并设置 flag 为 true
- [x] 6.3 在 `RegisterTerminalSession` 和 session ID 解析流程中，确保默认标题格式统一为 `Terminal Session-{后8位}`

## 7. Go Daemon — 触发逻辑集成

- [x] 7.1 修改 `cmd/pocketctl/main.go` 中 `OnSessionIDResolved` 回调：从 JSONL 提取首条 user msg 和首条 assistant msg，两者都存在时调用 `GenerateTitle`
- [x] 7.2 修改重试逻辑：现有逻辑重试最多 10 次提取 title，改为轮询等待 assistant 回复出现后触发 `GenerateTitle`
- [x] 7.3 确保 daemon session（非 terminal）也适用同样的标题生成流程

## 8. iOS — 展示适配

- [x] 8.1 修改 `ios/Pocketctl/Models/Session.swift` 的 `displayTitle` 计算属性：当 title 为 nil 或空时显示 `sessionId.prefix(8)`；当 title 匹配 `Terminal Session-` 前缀时原样显示；其他情况显示 title 原文
- [x] 8.2 验证 iOS 端在收到 `session_title_update` 事件时能平滑更新 UI（SessionListViewModel 和 SessionDetailViewModel 已有处理逻辑，确认即可）

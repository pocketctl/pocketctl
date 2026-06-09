## Context

pocketctl 是一个 AI 编码代理的监控和控制系统，包含 Go Daemon（本地监控）、Relay Server（中转+持久化）和 iOS App（客户端展示）。当前 session 标题提取逻辑在 Go Daemon 中完成，直接从 JSONL 文件取第一条用户消息原文并截断为60字符作为标题。该方案生成的标题质量不稳定，且用户在 iOS 端看到的 session 列表缺乏辨识度。

Relay Server 是 Node.js/TypeScript 应用（Fastify），当前无任何 LLM API 集成。需要在此层新增 GLM-4.6 调用能力。

## Goals / Non-Goals

**Goals:**
- 利用 GLM-4.6 生成简洁、准确的 session 标题（≤15字）
- 生成逻辑完全收敛在 Relay Server，Go Daemon 和 iOS 不感知 LLM
- 等首条 assistant 回复完成后触发，确保上下文完整
- 标题仅从默认值更新为生成值一次，永不二次变更
- 降级到原文截断，不因 LLM 不可用而阻塞用户体验

**Non-Goals:**
- 不做多轮动态标题更新（只更新一次）
- 不在 iOS 端添加手动编辑标题的功能（后续独立迭代）
- 不在 Go Daemon 中引入任何 LLM 调用
- 不改变现有的 session 事件流其他部分（状态、删除等不受影响）
- 不做标题去重或冲突检测

## Decisions

### D1: LLM 调用放在 Relay Server（非 Go Daemon）

**选择**: Relay Server 集中调用 GLM-4.6 API
**替代方案**: Go Daemon 本地调用 → 需要每个用户配置 API Key，运维成本高
**理由**:
- API Key 服务端统一管理，用户无感知
- 可集中做限流、缓存、降级
- Relay 已有 APNS 密钥等敏感配置管理，模式一致

### D2: 选择智谱 GLM-4.6

**选择**: `glm-4.6` 模型，通过 `https://open.bigmodel.cn/api/paas/v4/chat/completions` 调用
**替代方案**: Claude Haiku（贵）、GPT-4o-mini（国内延迟高）
**理由**:
- API 兼容 OpenAI 格式，无需额外 SDK，原生 `fetch()` 即可
- 国内部署，延迟低（<1s）
- 标题生成是极轻量任务，GLM-4.6 绰绰有余
- 单次成本约 ¥0.001

### D3: 方案 B — 等 assistant 回复后触发

**选择**: 检测到首条 user msg + 首条 assistant msg 完成后，一起发送给 GLM
**替代方案 A**: 只有 user msg 就触发 → 信息量不足，如用户输入 "hi" 则标题质量差
**理由**: 反正只生成一次，多等几秒换取更准确的上下文

### D4: 三层防重保证

**选择**: Go Daemon (titleGenerated flag) + Relay (检查非默认标题) + DB (条件 WHERE)
**理由**: 分布式系统中任何单点都可能异常（网络断开、进程重启），三层确保幂等

### D5: 降级策略

**选择**: 3秒超时 + API 错误 → 用用户消息原文截断前15字
**理由**: 绝不让标题生成失败影响主流程，用户消息原文是最可靠的 fallback

### D6: 新增 WebSocket 事件 `generate_title_request`

**选择**: 新增专用事件类型，携带 user_message 和 assistant_message
**替代方案**: 复用 `session_title_update` → 语义混淆，Relay 无法区分"原始标题"和"待生成请求"
**理由**: 职责清晰，Daemon 发请求，Relay 负责生成后自行广播 `session_title_update`

## Risks / Trade-offs

- **[GLM API 不可用]** → 降级到原文截断，用户无感。但标题质量回落到 Level 0
- **[新增 Relay 环境变量]** → `ZHIPU_API_KEY` 未配置时，跳过生成，保持默认名称。需在部署文档中说明
- **[标题生成延迟]** → 用户可能在 2-5 秒内看到默认名称，然后更新为生成名称。iOS 端需平滑处理标题变更
- **[GLM 返回质量不稳定]** → 通过 low temperature (0.3) + 严格 prompt 约束降低随机性。极端情况降级
- **[多用户并发]** → 每个新 session 仅调用一次，对 Relay 而言是极轻量 HTTP 调用，无性能瓶颈

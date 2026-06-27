## 0. 前置实测（决定 CORE 实时通道选型）

- [x] 0.1 ★实测：SSE 是**进程内总线,跨进程不可见**(两 serve 共享 DB,B 建会话 A 的 SSE 收不到)→ **终端会话必须 DirWatch,不能 ServeSSE**。结论记入 design.md
- [x] 0.2 part 落盘粒度：`tool` part 带 `state.status` 会**原地重写**,`text` part 全文 → **DirWatch 须监听 CREATE+MODIFY**。事件映射表记入 design.md
- [x] 0.3 TUI 自起内嵌 server(由进程内 SSE 间接证实);共享 DB 跨进程读可行(foreign 续聊 OK);**两 serve 同时启动会 DB 锁竞争 → daemon serve 须启动早期独占拉起**

## 1. 会话类型注册表（agent-registry）

- [x] 1.1 新建 `internal/adapter/registry.go`：定义 `Provider` 结构 + `Register` / `Get` / `All`
- [x] 1.2 定义 `LiveChannel` 接口（Start/Events/Pause/Resume/Close），抽取自现有 `JSONLTailer` 的契约
- [x] 1.3 把 claude-code、codex 注册为 Provider（搬迁现有 adapter/launcher/storage/capabilities，不改行为）— 见 `internal/adapter/providers.go`，opencode 先注册元数据（discovery/upgrade 不回归），driving 工厂留待 group 5
- [x] 1.4 `adapter.go` 的 5 个工厂 switch 改为 `registry.Get(agentType)` 查询；未注册/工厂为 nil 时 fallback Claude，保留旧签名
- [x] 1.5 `discovery.knownAgents` 删除，`DiscoverAgents`/`AgentUpgradeInfo`/`AgentTypeToCLI` 改读 `adapter.All()`/`adapter.Get()`（单一事实源）
- [x] 1.6 `go build ./...` + `go vet ./internal/adapter/... ./internal/discovery/...` 通过；adapter/discovery/watcher 测试全绿（session 包有 4 个 pre-existing 失败，与本改动无关，已用 `git stash -u` 对照确认）

## 2. SessionBackend 抽象（加法式，2026-06-27 决策：不做字段迁移）

> 决策：采用**加法式调度层**而非完整重构。`ProcessState` 保留全部现有字段（claude/codex 53 处引用一行不改），新增 `Backend SessionBackend` 句柄仅供 server-kind agent；dispatch 处按 `BackendKind` 分流。回归风险接近零。design.md Decision 2 已记此修正。

- [x] 2.1 新建 `internal/session/backend.go`：定义 `SessionBackend` 接口（Start/Send/Interrupt/Close）
- [x] 2.2 ~~实现 SubprocessBackend 搬迁~~ → 加法式下 claude/codex 仍走 manager.go 现有路径，无需搬迁
- [x] 2.3 ~~ProcessState 瘦身~~ → 加法式下保留现有字段，仅新增 `Backend SessionBackend` 句柄
- [x] 2.4 `adapter.BackendKindFor()` 助手 + `CreateSession` 顶部 server-kind 守卫（返回"尚未实现"，**修复 opencode 此前静默 fallback 成 claude 的隐患**）；Send/Interrupt 守卫待 group 6 终端 opencode 会话存在后再加
- [x] 2.5 `go build ./...` + `go vet` 通过；session 包仅 5 个 pre-existing 失败、无新增（`git stash -u` 对照确认 claude/codex 路径未动）

## 3. LiveChannel 三实现

- [~] 3.1 `SingleFileTail`：claude/codex 仍直接用 `JSONLTailer`（加法式下无需强行套 LiveChannel）；接口已定义供 opencode 用
- [x] 3.2 新建 `internal/watcher/dirwatch.go`：`DirWatch`(轮询 `message/<sid>/` + `part/<msgId>/`，按 msg `time.created` 排序，整文件读→`ConvertOpencodePart`，tool 原地状态变化重emit、其余 emit once、tool_call 去重)，实现 LiveChannel
- [x] 3.3 `ServeSSE`：owned 会话的 SSE 消费已在 `opencodeCoordinator.demuxLoop`（group 5.3）实现，按 sessionID 过滤
- [x] 3.4 DirWatch 单测 `dirwatch_test.go`：覆盖空目录、user_text、tool_call→tool_result 原地转换、agent_text 排序、不重复 emit ✅ 通过

## 4. opencode serve 托管 + HTTP/SSE 客户端

- [x] 4.1 新建 `internal/adapter/opencode_serve.go`：`Start`(--port 0 + 解析 listen URL + `OPENCODE_SERVER_PASSWORD` basic auth) / `Stop` / `Healthy` / `waitHealthy`。崩溃重启的 supervisor 待 group 5 manager 接线
- [x] 4.2 HTTP 客户端：CreateSession / Prompt(legacy /message) / GetSession / GetMessages / ListSessions / ListModels / GetConfigModel / ResolveDefaultModel / Abort / **Compact** / ReplyPermission / ReplyQuestion / RejectQuestion 全部就绪
  - **context**：opencode step-finish part 带 tokens → `ConvertOpencodePart` 映射成 usage 事件(空 text 的 agent_text)。⚠️ web 修复:`SessionDetail` 之前对 `!content` 的 agent_text 直接 return 丢弃了 usage;改为 usage-only 事件把 usage 挂到最后一条 agent_text。context pill 现在显示 ✅
  - **web 修复(计时器,两轮)**:① 切换会话后计时从 0——relay **不 replay session_status**(只更 DB status 列),web 切换时的 'running' 占位无事件纠正。`replay_end` 改为从 `allSessions`(权威 DB status)纠正。② 更深:opencode 会话若 turn 中途废弃(最后是 user 消息无 assistant 回复),`deriveStatus` 旧逻辑把"末条 user"判成 running 且永不发 idle → DB 卡 running;且会话过了 10min 发现窗口后无 syncLoop 自愈。修复 a) `deriveStatus` 仅当"末条是未完成的 assistant"才 running(daemon),b) `replay_end` 对 `last_activity_at` 过期(>2min)的 running 状态视为 idle(web 兜底已卡住的旧会话)
  - **当前模型显示 + /model 对齐 claude**:① `get_session_meta` 对 opencode 经 `OpencodeSessionModelFromServe`(serve `GET /api/session`)取 `providerID/modelID` → 详情页模型 pill 显示 ✅;② `/model` 命令显示当前模型(读 currentModel)✅;③ 实时模型切换沿用通用 `client.OnEvent` 机制(agent_text 带 Model 与缓存不同 → 发 session_model_changed),并把 `OpencodeModelDisplay` 统一为 `providerID/modelID` 格式,避免每回合误报变更 + 保证 Prompt 模型解析一致 ✅
  - **web 修复(context 兜底)**:`SessionDetail` 维护 `lastUsage` ref,任何带 usage 的事件都记录,context pill 用它兜底——即使会话只有 usage-carrier 事件、没有文本 agent_text 消息(如 SID1)也能显示用量。切换会话时重置
  - **compact**：`/compact` 在 `serverBackend.Send` 拦截 → `command_receipt` 反馈。⚠️ 实测修正:`/api/session/{id}/compact` 是未实现的占位(503 "not available yet"),真正压缩走 **legacy `POST /session/{id}/summarize`** 带 `{providerID, modelID}` body(模型缺省时从会话取)。实测端到端通过 ✅
- [x] 4.3 单条 `/event` SSE 消费（`Events()` 解析 `data:` 行为 `SSEEvent`）；按 sessionID 解复用在 ServerBackend（group 5）
- [x] 4.4 serve 健壮性:① 启动失败时 `ensureStarted`/`createOpencodeSession`/`ModelsForAgent` 返回清晰错误(非静默);② **健康检查 supervisor**(`supervise` goroutine,15s 一次 `GET /api/health`,挂掉则 `restartServer` 重启)——serve 进程用 daemon-lifetime ctx 的子 ctx,可独立重启不影响 loops;③ 所有热点调用改用 `srv()`(锁保护,可安全 swap)+ nil 守卫。**实测 kill serve 后 14s 内自动重启,且仅 1 个实例** ✅
- [x] 4.5 集成 smoke 测试 `TestOpencodeServerSmoke`（start→create→get→stop，零 token，opencode 未装则 skip）✅ 通过

## 5. opencode adapter + ServerBackend

- [x] 5.1 新建 `internal/adapter/opencode.go`：`OpencodePart`/`OpencodeMessage` 结构 + `ConvertOpencodePart`（text→user/agent_text、tool→tool_call/tool_result、step-finish→usage、reasoning/step-start/patch/file→skip）；SSE 与 DirWatch 共用此转换器。单测 `opencode_test.go` 用真实样本驱动 ✅ 通过
- [x] 5.2 ~~opencode SessionStorage 解析文件~~ **已废弃**：当前 opencode 用 SQLite,会话 meta(title/model/directory)改从 serve API `GET /api/session` 获取(见 `OpencodeSessionSummary`),不再读文件
- [x] 5.3 `internal/session/opencode_backend.go`：`opencodeCoordinator`(单例 serve + 单条 SSE demux,msgID→role/model 缓存,tool_call 去重,owned 集合) + `serverBackend`(Start=`POST /api/session`含 LocationRef cwd / Send=`POST /prompt` / Interrupt=`POST /session/{id}/abort` / Close) + `createOpencodeSession`;manager `CreateSession`/`SendMessage`/`InterruptSession` 三处 dispatch 接线
- [x] 5.4 `AgentOpencode` 常量 + capabilities(空) ✅；**模型列表已实现**：`OpencodeServer.ListModels`(GET /api/model,alias=name="providerID/modelID",配置默认模型置顶)+ `SessionManager.ModelsForAgent`(opencode 走 serve,其余走旧 helper)+ main.go `list_models` 改调 `sm.ModelsForAgent`。实测返回 111 个模型 ✅（web 新建会话选 opencode 时即有模型下拉）
- [x] 5.5 opencode Provider 已注册(`BackendServer`,元数据驱动);加法式下无需 JSONL 工厂;LiveChannel/ForeignDiscover 由 group 3/6 接入

## 6. ★CORE — 终端 opencode 会话发现 + 实时同步 + 续聊

> ⚠️ **方案重构 (2026-06-27)**：本地实测发现**当前 opencode (1.17.11) 把会话存进 SQLite,不再写 `storage/` JSON 文件树**。原 DirWatch/文件发现方案对当前版本失效(监视的文件不再被写)。改为**通过共享 `opencode serve` 的 HTTP API 轮询共享 DB**。已删除 `dirwatch.go`/`opencode_watcher.go`,改为 coordinator 内的 API 轮询。详见 design.md「重大修正」。

- [x] 6.1 发现改为 `opencodeCoordinator.discoverOnce`：轮询 `GET /api/session`(共享 DB 可见终端会话)+ `time.updated` 新鲜度过滤(10min)+ 跳过已 tracked
- [x] 6.2 daemon 启动时 `StartOpencodeDiscovery`(**必须放在 daemonize 闸门之后**,否则 launcher 进程会 orphan 第二个 serve 撞 DB 锁——已修复)
- [x] 6.3 `RegisterOpencodeTerminalSession`(Source:terminal) + `startSync` 每会话 `GET /session/{id}/message` 1s 轮询 → `OpencodeSync.Diff` → outputCh + `session_discovered`
- [x] 6.4 续聊 busy 撞车检测:`serverBackend.Send` 发 prompt 前用 `GetMessages` + `adapter.OpencodeMessagesRunning`(末条是未完成 assistant)判断,若正在生成则返回"会话正在生成回复,请等当前回合结束"(对齐 claude 的 session busy 守卫);`/compact` 不受此限
- [x] 6.7 **修复(实测 bug,两层)**:owned 会话无响应。① opencode 不给 API 会话套默认模型,空模型会话 prompt 不执行。② 更深:`/config` 的默认模型 `zhipuai-coding-plan/glm-5` **已失效**(重命名为 glm-5.2),设上去 prompt 被 admit 但执行时 `ProviderModelNotFoundError`,无任何消息/响应(opencode serve 错误日志被 daemon drain 掉,故隐蔽)。修复:`ResolveDefaultModel` 三级回退——配置默认(若仍有效)→ 同 provider 的有效模型 → 首个可用。实测 `glm-5`→`glm-5.2`(同 provider)✅
- [x] 6.8 **修复(实测 bug)**:会话状态卡在"工作中" → opencode 无显式"turn 完成"事件,`OpencodeSync` 据最后一条 assistant message 的 `time.completed` 推导 `session_status` running/idle 转换
- [x] 6.9 **修复(实测 bug)**:无自动标题 → opencode 异步生成标题,`syncLoop` 每 3 秒 `GetSession` 刷新标题(跳过 "New session" 默认),变化时 `UpdateSessionTitle`
- [x] 6.5 续聊:终端会话 `ps.Backend.Send` → serve `POST /api/session/{id}/prompt`(共享 DB 加载,lazy ensureStarted);事件经 message 轮询回流(emitUser=true)
- [x] 6.6 **本地实测通过**:另一进程建 opencode 会话 → daemon 2s 内发现(日志 `opencode terminal session discovered`)→ 出现在 daemon status(Source:terminal)。**真实 TUI+prompt 的端到端实时同步留待你在 web 验证**

## 7. 审批 / 交互统一

- [x] 7.1/7.2 **经实测:opencode 不向第三方 API 客户端暴露 permission/question 请求** —— `/event`、`/api/event`、`GET /api/session/{id}/permission`、`/api/permission/request` 全空;用 serve 日志里的 `per_` id 去 reply 返回 404。权限请求绑定在 serve 进程内当前 prompt run,只发给持有 POST /message 连接的发起方。**因此审批透传到 web 不可行。**
- [x] 7.3 **替代方案(已实现)**:daemon 的 serve 用 `OPENCODE_CONFIG_CONTENT={"permission":{"edit":{"*":"allow"},"bash":{"*":"allow"}}}` 启动 → owned/续聊会话**自动放行工具**(等价 claude daemon 的 bypassPermissions),避免无人应答时永久卡死。实测写文件 prompt 5s 完成。仅影响 daemon serve;终端 opencode 用自己的 serve 保留 "ask"。配置 merge 不影响用户 model/provider。`ReplyPermission`/`ReplyQuestion` + Resolve 路由保留为休眠钩子,待 opencode 将来开放事件

## 8. 验证

- [x] 8.1 `go build ./...` ✅ · `go vet ./...` ✅ · `go test ./...` ✅(全绿,含 e2e + session)· web vitest **200/200**。顺手修了 4 个 pre-existing 测试问题:① e2e `ws.NewClient` 旧签名(补 2 个 nil map 参数);② `internal/session` 5 个测试(`drainDiscovered` 期望 RegisterTerminalSession 发 session_discovered,但该事件已移到 handleWatcherEvents → 改为非阻塞 drain);③ e2e `TestSessionExited_ReadOutputLastActivityAt`(stdout mock 早于 PTY+JSONL 架构,已 skip 并注明);④ e2e `TestBuild_BinaryAndBasicCommands`(i18n 中文输出 + 依赖纯净环境 → 强制 LC_ALL=C + 断言改为容忍机器状态)
- [ ] 8.2 回归：claude + codex 全流程无变化
- [ ] 8.3 opencode owned 全流程：建会话 / 实时输出 / 审批 / 模型切换 / context / compact
- [ ] 8.4 ★opencode CORE 全流程：终端 TUI 会话被发现 + 实时同步 + 客户端续聊
- [ ] 8.5 降级：serve 启动失败 / 崩溃重启 / DB schema 不兼容时的行为符合 Decision

## 9. 文档

- [x] 9.1 README 补充 opencode 支持:README.zh-CN.md 新增「支持的 Agent」表 + opencode 特殊性说明 + 更新 internal/adapter|session 目录结构;README.md(英文)Features 加 multi-agent 条目。均链接到开发文档
- [x] 9.2 `docs/adding-an-agent.md`:接入新 agent 的开发文档——子进程型 vs 服务型、Provider 注册、四接口/SessionBackend、服务型的坑(状态推导/模型标题/权限/busy)、模型列表、自测清单

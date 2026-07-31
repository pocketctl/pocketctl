import Foundation

@Observable
@MainActor
final class SessionDetailViewModel {
    var messages: [ChatMessage] = []
    var subAgents: [String: SubAgent] = [:]
    /// Available slash commands for autocomplete (filled by command_list event)
    var commands: [CommandItem] = []
    var sessionAgents: [OpenCodeSessionAgent] = []
    var currentSessionAgent: String?
    var sessionAgentCapabilities = Set<String>()
    var sessionAgentsLoading = false
    var sessionAgentSubmitting = false
    var sessionAgentError: String?
    private var pendingSessionAgentName: String?
    private var interactionResolutions: [String: OpenCodeInteractionResolution] = [:]
    private var interactionRequestIDs = Set<String>()
    var status: String
    var title: String?
    var exitReason: String?
    /// Resolved model name for this session (live-updated on /model switch).
    var currentModel: String?
    /// Actual reasoning effort reported by the daemon for Claude Code or Codex.
    var currentEffort: String?
    var currentPermission: AgentPermissionConfig?
    var pendingPermission: AgentPermissionConfig?
    var permissionMutable = false
    var permissionMutableModes: [String] = []
    var lastPermissionError: String?
    var permissionEffectNotice: String?
    /// 最近一次携带 usage 的事件的 token 用量（与 web `lastUsage` 对齐）。
    /// 任何 agent_text 事件携带 usage 都会更新它，包括无文本的纯 usage 载体
    /// （opencode step-finish / codex token_count）。会话切换时重置。
    /// `contextUsageTokens` 优先用它，回退到反向扫描 messages。
    private var lastUsage: TokenUsage?
    var isLoading = true
    /// Incremented when initial replay completes — triggers scroll-to-bottom
    var scrollTick = 0
    /// Bumped every second while the agent is executing — drives the
    /// "Agent 执行中... mm:ss" elapsed-time label in the footer.
    var executionTick = 0
    /// Wall-clock instant when the current execution run began.
    private var executionStartDate: Date?
    /// Frozen elapsed-time string captured when execution ends — drives the
    /// "已完成 · <duration>" status bar. Reset to nil on the next run.
    var lastTurnDuration: String?
    /// Relay signaled older events exist beyond the loaded page
    var hasMore = false
    /// A backward-pagination (scroll-up) request is in flight
    var isLoadingBackward = false
    /// User-visible send failure message surfaced by ack/nack or local offline checks.
    var sendFailureMessage: String?
    /// Exposed to the view to open the local /help sheet after /help command.
    var shouldShowLocalHelp: Bool = false

    var session: Session  // var to support session_id_changed updates
    private let focusedSubAgent: SubAgent?
    private let wsService: WebSocketService
    private let apiClient: APIClient
    private var msgCounter = 0
    private var eventListenerId: String?
    /// Page size for replay pagination. Tuned down from 50 → 20 so the first
    /// page renders faster (fewer messages to decode + render on entry); older
    /// history loads on scroll-up via `loadOlder()`.
    private let pageSize = 20
    /// Oldest loaded event seq — backward pagination cursor
    private var loadedMinId = 0
    /// Out-of-order tool results: relay persists events fire-and-forget, so a
    /// tool_result can land before its tool_call (DB id ≠ send order). Buffer
    /// orphan results and apply them when the matching tool_call is created.
    private var pendingToolResults: [String: (output: String, streaming: Bool)] = [:]
    /// Shared bounded chunk reducer for live, replay, and subagent content.
    private var contentStreams = ContentStreamAssembler()
    /// True while processing a replay_batch — suppresses per-event scrollTick updates
    private var isBatchProcessing = false
    /// Outbound messages remain tracked after Relay forwarding when managed
    /// Codex advertises an app-server acceptance receipt.
    private var pendingUserMessages = PendingUserMessageTracker()
    /// A new detail screen can receive the same daemon event through both the
    /// initial replay and the live subscription. Track daemon sequence identity
    /// so that overlap is applied exactly once.
    private var eventDeduplicator = EventDeliveryDeduplicator()
    /// Bridges the local send → daemon status round-trip so the UI can show
    /// working feedback immediately without mutating the authoritative status.
    private var turnActivityState = TurnActivityState()

    init(session: Session, wsService: WebSocketService, apiClient: APIClient, focusedSubAgent: SubAgent? = nil) {
        self.session = session
        self.focusedSubAgent = focusedSubAgent
        self.status = session.status
        self.title = session.title
        self.exitReason = session.exitReason
        self.currentSessionAgent = session.activeAgent
        self.sessionAgentCapabilities = Set(session.capabilities)
        self.wsService = wsService
        self.apiClient = apiClient
        applyDaemonSnapshot()

        // 从内存缓存恢复消息，实现秒开 + 保留滚动位置
        if let cached = Self.messagesCache[session.sessionId] {
            self.messages = cached.messages
            self.subAgents = cached.subAgents
            self.msgCounter = cached.msgCounter
            self.isLoading = false
            self.interactionRequestIDs = Set(cached.messages.compactMap { $0.requestId })
        }

        // 若进入时已在执行，从 last_activity_at 恢复真实开始时间，
        // 避免重新进入会话详情时计时从 0 开始。
        if isExecuting {
            executionStartDate = parseDate(session.turnStartedAt) ?? Date()
            startExecutionTimer()
        }

        // 同步 session.children 的 token/title 到 subAgents（relay 不转发
        // subagent_usage，children 是 token 的权威来源）。若 subAgents 来自
        // 缓存，用 children 值覆盖（缓存可能过时）；若 subAgents 为空则创建。
        syncChildrenTokens()
        if let focusedSubAgent {
            if let existing = subAgents[focusedSubAgent.agentId] {
                subAgents[focusedSubAgent.agentId] = SubAgent(
                    agentId: focusedSubAgent.agentId,
                    description: focusedSubAgent.description,
                    agentType: focusedSubAgent.agentType,
                    messages: existing.messages,
                    status: focusedSubAgent.status,
                    tokenIn: focusedSubAgent.tokenIn,
                    tokenOut: focusedSubAgent.tokenOut,
                    tokenCache: focusedSubAgent.tokenCache,
                    tokenCacheCreate: focusedSubAgent.tokenCacheCreate,
                    title: focusedSubAgent.title
                )
            } else {
                subAgents[focusedSubAgent.agentId] = focusedSubAgent
            }
        }
    }

    /// Whether the session is actively executing (running/busy/retry)
    var isExecuting: Bool {
        ["running", "busy", "retry"].contains(status)
    }

    var isAwaitingTurnStart: Bool {
        turnActivityState.isAwaitingStart
    }

    var isWorking: Bool {
        turnActivityState.isWorking(status: status)
    }

    var shouldShowEffort: Bool {
        guard ["claude-code", "codex"].contains(session.agentType) else { return false }
        return !(currentEffort?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true)
    }

    var effortDisplayLabel: String? {
        guard let raw = currentEffort?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else {
            return nil
        }
        let labels = [
            "minimal": "最低",
            "low": "低",
            "medium": "中",
            "high": "高",
            "xhigh": "极高",
            "max": "最大",
            "ultracode": "Ultracode",
        ]
        return labels[raw.lowercased()] ?? raw
    }

    var hostDisplayName: String {
        if let alias = session.daemonAlias, !alias.isEmpty { return alias }
        if let alias = wsService.daemons[session.daemonId]?.alias, !alias.isEmpty { return alias }
        if let alias = KeychainStorage.daemonAliases[session.daemonId], !alias.isEmpty { return alias }
        if let hostname = session.hostname, !hostname.isEmpty { return hostname }
        if let hostname = wsService.daemons[session.daemonId]?.hostname, !hostname.isEmpty { return hostname }
        return String(session.daemonId.prefix(8))
    }

    /// Human-readable elapsed time of the current execution run.
    /// Format: < 60s → "Ns"; < 1h → "M:SS"; otherwise → "H:MM:SS".
    /// Returns nil when not executing.
    var executionElapsedString: String? {
        guard let start = executionStartDate else { return nil }
        var interval = Date().timeIntervalSince(start)
        if interval < 0 { interval = 0 }
        let total = Int(interval)
        let hours = total / 3600
        let minutes = (total % 3600) / 60
        let seconds = total % 60
        if hours > 0 {
            return String(format: "%d:%02d:%02d", hours, minutes, seconds)
        } else if minutes > 0 {
            return String(format: "%d:%02d", minutes, seconds)
        } else {
            return "\(seconds)s"
        }
    }

    /// Whether the session is still in a state that may produce new tool
    /// events. Terminal states (`completed`/`exited`/`error`/`killed`/`crashed`)
    /// return false — used to stop orphan tool_calls from showing as running.
    var isSessionActive: Bool {
        ["running", "busy", "retry", "idle", "waiting", "waiting_approval", "waiting_question"].contains(status)
    }

    /// Whether this session is a sub-agent (read-only — no input allowed).
    var isSubagent: Bool { session.isSubagent || focusedSubAgent != nil }

    var showsSessionAgentPicker: Bool {
        session.agentType == "opencode" && sessionAgentCapabilities.contains("agent_switch") && focusedSubAgent == nil && !session.isSubagent
    }

    var canSwitchSessionAgent: Bool {
        showsSessionAgentPicker
            && !["running", "busy", "retry", "waiting", "waiting_approval", "waiting_question"].contains(status)
            && !sessionAgentSubmitting
            && !wsService.isDaemonKnownOffline(session.daemonId, initialOnline: session.daemonOnline)
    }

    var interactionControlsDisabled: Bool {
        isSubagent
            || wsService.isDaemonKnownOffline(session.daemonId, initialOnline: session.daemonOnline)
            || (session.agentType == "opencode" && (!isManagedOpenCodeSession || !sessionAgentCapabilities.contains("terminal_coapproval")))
    }

    var isManagedOpenCodeSession: Bool {
        session.agentType == "opencode"
            && session.controlMode == "managed"
            && sessionAgentCapabilities.contains("shared_runtime")
    }

    var isLegacyOpenCodeSession: Bool {
        session.agentType == "opencode" && !isManagedOpenCodeSession
    }

    // MARK: - "已完成" status bar support

    /// Most recent token usage across messages (reverse scan, like the web
    /// client's `lastAgentUsage`). Drives the "输出 X tokens" label.
    var lastAgentUsage: TokenUsage? {
        for message in messages.reversed() {
            if let usage = message.usage { return usage }
        }
        return nil
    }

    /// Context 使用量（输入侧总 token = 输入 + 缓存读取 + 缓存写入），与 web 客户端
    /// `contextTokens` 一致。优先用 `lastUsage`（覆盖纯 usage 载体事件），回退到
    /// 反向扫描 messages。无 usage 记录时返回 nil（不渲染）。
    var contextUsageTokens: Int? {
        let usage = lastUsage ?? lastAgentUsage
        guard let usage, usage.contextTokens > 0 else { return nil }
        return usage.contextTokens
    }

    /// Whether any agent_text reply exists (gates the copy button).
    var hasLastAgentReply: Bool {
        messages.contains { $0.type == .agentText }
    }

    /// Whether a retryable user prompt exists (gates the retry button).
    var hasLastUserPrompt: Bool {
        messages.contains { $0.role == .user && !$0.content.isEmpty }
    }

    /// Content of the last agent_text reply (for copy-to-clipboard).
    var lastAgentReplyContent: String? {
        for message in messages.reversed() where message.type == .agentText {
            return message.content
        }
        return nil
    }

    /// Whether the "已完成" status bar should show. Visible when not executing
    /// and the session is in an idle/terminal state with at least one agent
    /// reply. On a fresh replay (no frozen `lastTurnDuration`) the bar still
    /// renders — just without the duration, matching the web client's
    /// `completedBarVisible` refresh-recovery behavior.
    var completedBarVisible: Bool {
        if isWorking { return false }
        if lastTurnDuration != nil { return true }
        let finishedStates: Set<String> = ["idle", "completed", "exited", "error", "killed"]
        return finishedStates.contains(status) && hasLastAgentReply
    }

    /// Format a token count for compact display: > 1000 → "1.2K".
    func fmtTokens(_ n: Int) -> String {
        if n > 1000 { return String(format: "%.1fK", Double(n) / 1000) }
        return String(n)
    }

    /// Copy the last agent reply to the pasteboard. Returns the copied text
    /// (nil if nothing to copy). Call site handles the UI feedback state.
    @discardableResult
    func copyLastReply() -> String? {
        lastAgentReplyContent
    }

    /// Retry: re-send the last user prompt verbatim. Gated by `canRetry`
    /// (daemon sessions stay retryable after completion), matching the web
    /// client's `retryLastPrompt` + `canInput` behavior.
    func retryLastPrompt() {
        guard canRetry else { return }
        for message in messages.reversed() where message.role == .user && !message.content.isEmpty {
            sendMessage(message.content)
            return
        }
    }

    private var canWriteWhenConnected: Bool {
        let basePolicyAllowsSend = SessionInputPolicy.canSend(
            status: status,
            source: session.source,
            daemonOnline: true,
            isSubagent: session.isSubagent,
            isManagedSession: session.controlMode == "managed",
            agentType: session.agentType,
            capabilities: sessionAgentCapabilities
        )
        return basePolicyAllowsSend && (session.agentType != "opencode" || isManagedOpenCodeSession)
    }

    var composerState: SessionComposerState {
        let connectivity: SessionComposerConnectivity
        if !session.daemonOnline || !wsService.isDaemonOnline(session.daemonId) {
            connectivity = .offline
        } else if isLoading {
            connectivity = .syncing
        } else {
            connectivity = .ready
        }
        return SessionComposerPolicy.resolve(
            writableWhenConnected: canWriteWhenConnected,
            connectivity: connectivity,
            isTerminal: SessionComposerPolicy.isTerminalStatus(status)
        )
    }

    /// Whether the current transport and session state allow sending now.
    var canSendMessage: Bool {
        composerState.canSend
    }

    /// Whether a completed turn can be retried. Mirrors the web client's
    /// `canInput`: a daemon-sourced session stays retryable in any terminal
    /// state (`completed`/`error`/`killed`) as long as the daemon is online,
    /// since it can be resumed. Disconnected sessions are never retryable.
    var canRetry: Bool {
        return canSendMessage
    }

    /// Apply a status transition and start/stop the execution timer.
    /// - Parameter lastActivityAt: ISO8601 timestamp of the last activity,
    ///   carried by `session_status` events. When resuming a running turn
    ///   (replay / re-entry), it anchors the timer to the real turn start so
    ///   the elapsed doesn't restart from zero.
    private func applyStatus(_ newStatus: String, lastActivityAt: String? = nil) {
        let wasWorking = isWorking
        status = newStatus
        turnActivityState.apply(.status(newStatus))
        reconcileWorkingTransition(wasWorking: wasWorking, lastActivityAt: lastActivityAt)
    }

    private func applyTurnSignal(_ signal: TurnActivitySignal) {
        let wasWorking = isWorking
        turnActivityState.apply(signal)
        reconcileWorkingTransition(wasWorking: wasWorking)
    }

    private func reconcileWorkingTransition(wasWorking: Bool, lastActivityAt: String? = nil) {
        if isWorking && !wasWorking {
            // Execution just started. Recover the real turn start from the
            // event's last_activity_at when present (replay/live resume),
            // otherwise stamp "now" for a fresh turn triggered by sendMessage.
            executionStartDate = parseDate(lastActivityAt) ?? Date()
            lastTurnDuration = nil
            executionTick &+= 1
            startExecutionTimer()
        } else if !isWorking && wasWorking {
            // Execution ended — freeze the label at the final elapsed value.
            lastTurnDuration = executionElapsedString
            executionStartDate = nil
            stopExecutionTimer()
        }
    }

    private static let isoFormatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private static let isoFormatterNoFraction: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    /// Parse an ISO8601 string (with or without fractional seconds) to Date.
    private func parseDate(_ s: String?) -> Date? {
        guard let s, !s.isEmpty else { return nil }
        return Self.isoFormatter.date(from: s) ?? Self.isoFormatterNoFraction.date(from: s)
    }

    private func applyDaemonSnapshot(event: WebSocketEvent? = nil) {
        if let hostname = event?.hostname, !hostname.isEmpty {
            session.hostname = hostname
        } else if let hostname = wsService.daemons[session.daemonId]?.hostname, !hostname.isEmpty {
            session.hostname = hostname
        }

        let eventAlias = event?.raw["alias"] as? String
        if let alias = eventAlias, !alias.isEmpty {
            session.daemonAlias = alias
        } else if let alias = wsService.daemons[session.daemonId]?.alias, !alias.isEmpty {
            session.daemonAlias = alias
        } else if let alias = KeychainStorage.daemonAliases[session.daemonId], !alias.isEmpty {
            session.daemonAlias = alias
        }

        if let status = event?.status {
            session.daemonOnline = status == "online"
        } else if let daemon = wsService.daemons[session.daemonId] {
            session.daemonOnline = daemon.online
        }
    }

    private var executionTimer: Task<Void, Never>?

    private func startExecutionTimer() {
        executionTimer?.cancel()
        executionTimer = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(1))
                guard let self, !Task.isCancelled else { return }
                self.executionTick &+= 1
            }
        }
    }

    private func stopExecutionTimer() {
        executionTimer?.cancel()
        executionTimer = nil
    }

    var inputPlaceholder: String {
        if status == "exited" { return "输入消息以恢复 Session..." }
        return "发送消息..."
    }

    // MARK: - Connect / Refresh

    /// Connect and replay history using incremental replay.
    /// No polling — relay sends `replay_end` when done.
    func connect() async {
        guard KeychainStorage.accessToken != nil else { return }

        // 重置会话级运行时状态（对应 web 切换会话时 lastUsage.value = null）。
        lastUsage = nil

        // ── Stage 1: register the event listener up front so no replay batch
        // is dropped while we wait for the handshake / token refresh below.
        eventListenerId = wsService.addEventListener { [weak self] dict in
            self?.handleEvent(dict)
        }

        // ── Stage 2: ensure the socket is connected before replay.
        // When SessionList already owns a live WebSocket, do not wait for an
        // access-token refresh here. Subagent detail is read-only and only
        // needs to send replay_subagent over the existing authenticated socket;
        // waiting on refresh adds an avoidable RTT before the first page loads.
        let wsURL = RelayEnvironmentManager.shared.current.wsBaseURL
        if !wsService.isConnected {
            _ = await resolveConnectToken()
            await ensureWebSocketConnected(url: wsURL)
        }

        guard wsService.isConnected else {
            isLoading = false
            return
        }

        // Backward pagination: load the most recent page (matches web client).
        // If messages were restored from cache, skip replay (秒开); live events
        // will append new messages after connect.
        if let focusedSubAgent {
            if subAgents[focusedSubAgent.agentId]?.messages.isEmpty ?? true {
                loadedMinId = 0
                hasMore = false
                wsService.send([
                    "type": "replay_subagent",
                    "session_id": session.sessionId,
                    "agent_id": focusedSubAgent.agentId,
                    "limit": pageSize,
                ])
            } else {
                isLoading = false
            }
        } else if messages.isEmpty {
            loadedMinId = 0
            hasMore = false
            wsService.send([
                "type": "replay",
                "session_id": session.sessionId,
                "direction": "backward",
                "limit": pageSize,
            ])
        } else {
            isLoading = false
        }

        // Request the available slash commands for autocomplete (one-time per connect).
        if focusedSubAgent == nil {
            wsService.send([
                "type": "list_commands",
                "session_id": session.sessionId,
            ])
            requestSessionMeta()
        }

        // isLoading will be set to false when replay_end arrives

        // Safety timeout: if replay_end never arrives (network drop, relay crash),
        // unblock the UI after 10 seconds so the user isn't stuck forever.
        Task {
            try? await Task.sleep(for: .seconds(10))
            if isLoading {
                isLoading = false
                scrollTick += 1
            }
        }
    }

    /// Resolve the access token to use for this session, refreshing it if a
    /// refresh token is available. Runs concurrently with the WebSocket
    /// handshake in `connect()`.
    private func resolveConnectToken() async -> String {
        if KeychainStorage.refreshToken != nil {
            if case let .success(resp) = await AuthRefreshCoordinator.shared.refresh(using: apiClient) {
                return resp.access_token
            }
        }
        return KeychainStorage.accessToken ?? ""
    }

    /// Ensure the shared WebSocket is connected. If it is already up (the
    /// SessionList typically holds a long-lived socket), this is a no-op that
    /// resolves immediately — the old 20×200ms poll loop is gone. Otherwise it
    /// drives the handshake via the ping callback (event-driven, no polling).
    private func ensureWebSocketConnected(url: String) async {
        if wsService.isConnected { return }
        let token = KeychainStorage.accessToken ?? ""
        guard !token.isEmpty else { return }
        await wsService.connectAsync(url: url, token: token)
    }

    func disconnect() {
        if let id = eventListenerId {
            wsService.removeEventListener(id)
            eventListenerId = nil
        }
        stopExecutionTimer()
    }

    /// Incremental refresh — called on .onAppear when returning to this view.
    func onReturn() {
        if eventListenerId == nil {
            eventListenerId = wsService.addEventListener { [weak self] dict in
                self?.handleEvent(dict)
            }
        }
        guard !messages.isEmpty else {
            forceRefresh()
            return
        }
        // 有缓存消息 → 秒开（用户可下拉 forceRefresh 刷新最新页）
    }

    /// 向上滚到顶 → 加载更早一页历史（backward 分页，对齐 web）
    func loadOlder() {
        guard hasMore, !isLoadingBackward, loadedMinId > 0 else { return }
        isLoadingBackward = true
        if let focusedSubAgent {
            wsService.send([
                "type": "replay_subagent",
                "session_id": session.sessionId,
                "agent_id": focusedSubAgent.agentId,
                "last_seq": loadedMinId,
                "limit": pageSize,
            ])
        } else {
            wsService.send([
                "type": "replay",
                "session_id": session.sessionId,
                "direction": "backward",
                "last_seq": loadedMinId,
                "limit": pageSize,
            ])
        }
    }

    /// Full refresh — clears all messages and reloads the latest page.
    func forceRefresh() {
        if eventListenerId == nil {
            eventListenerId = wsService.addEventListener { [weak self] dict in
                self?.handleEvent(dict)
            }
        }
        messages.removeAll(keepingCapacity: true)
        subAgents.removeAll(keepingCapacity: true)
        if let focusedSubAgent {
            subAgents[focusedSubAgent.agentId] = focusedSubAgent
        }
        msgCounter = 0
        loadedMinId = 0
        hasMore = false
        isLoadingBackward = false
        isLoading = true
        eventDeduplicator.reset()
        contentStreams.reset()
        interactionResolutions.removeAll(keepingCapacity: true)
        interactionRequestIDs.removeAll(keepingCapacity: true)
        applyTurnSignal(.reset)

        if let focusedSubAgent {
            wsService.send([
                "type": "replay_subagent",
                "session_id": session.sessionId,
                "agent_id": focusedSubAgent.agentId,
                "limit": pageSize,
            ])
        } else {
            wsService.send([
                "type": "replay",
                "session_id": session.sessionId,
                "direction": "backward",
                "limit": pageSize,
            ])
        }
    }

    /// Send a user message (will appear when relay echoes it back as userText).
    /// Returns false when the message is rejected locally before reaching relay.
    @discardableResult
    func sendMessage(_ text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        guard canSendMessage else { return false }
        shouldShowLocalHelp = false
        if handleLocalCommand(trimmed) { return true }
        guard !wsService.isDaemonKnownOffline(session.daemonId, initialOnline: session.daemonOnline) else {
            sendFailureMessage = "主机离线，消息未发送"
            return false
        }
        let msgId = UUID().uuidString
        let expectsAcceptanceReceipt =
            session.agentType == "codex"
            && session.controlMode == "managed"
            && sessionAgentCapabilities.contains("message_acceptance_receipt")
        pendingUserMessages.begin(
            id: msgId,
            expectsAcceptanceReceipt: expectsAcceptanceReceipt
        )
        wsService.send([
            "type": "user_message",
            "session_id": session.sessionId,
            "content": text,
            "msg_id": msgId,
        ])
        applyTurnSignal(.sendAccepted)
        return true
    }

    var canChangePermission: Bool {
        permissionMutable && !isExecuting && focusedSubAgent == nil && !wsService.isDaemonKnownOffline(session.daemonId, initialOnline: session.daemonOnline) && pendingPermission == nil
    }

    var permissionChangeUnavailableReason: String? {
        guard !canChangePermission else { return nil }
        if isExecuting { return "Agent 执行中，完成后可修改权限" }
        if focusedSubAgent != nil { return "子 Agent 会话不支持修改权限" }
        if wsService.isDaemonKnownOffline(session.daemonId, initialOnline: session.daemonOnline) {
            return "主机离线，暂时无法修改权限"
        }
        if pendingPermission != nil { return "正在修改权限，请稍候" }
        if !permissionMutable { return "当前会话不支持修改权限" }
        return nil
    }

    func requestPermissionChange(_ permission: AgentPermissionConfig) {
        guard canChangePermission else { return }
        pendingPermission = permission
        lastPermissionError = nil
        wsService.send(["type": "set_permission_config", "session_id": session.sessionId, "permission": permission.dictionary])
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(10))
            guard let self, self.pendingPermission != nil else { return }
            self.pendingPermission = nil
            self.lastPermissionError = "权限修改超时"
            self.requestSessionMeta()
        }
    }

    func requestSessionMeta() {
        wsService.send(["type": "get_session_meta", "session_id": session.sessionId])
    }

    func requestSessionAgents() {
        guard showsSessionAgentPicker, !sessionAgentsLoading else { return }
        sessionAgentsLoading = true
        sessionAgentError = nil
        wsService.send(["type": "list_session_agents", "session_id": session.sessionId])
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(10))
            guard let self, self.sessionAgentsLoading else { return }
            self.sessionAgentsLoading = false
            self.sessionAgentError = "Agent 列表加载超时"
        }
    }

    func switchSessionAgent(to name: String) {
        guard canSwitchSessionAgent,
              name != currentSessionAgent,
              sessionAgents.contains(where: { $0.name == name }) else { return }
        sessionAgentSubmitting = true
        sessionAgentError = nil
        pendingSessionAgentName = name
        wsService.send([
            "type": "set_session_agent",
            "session_id": session.sessionId,
            "agent_name": name,
            "request_id": UUID().uuidString,
        ])
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(15))
            guard let self, self.sessionAgentSubmitting, self.pendingSessionAgentName == name else { return }
            self.sessionAgentSubmitting = false
            self.pendingSessionAgentName = nil
            self.sessionAgentError = "Agent 切换超时"
        }
    }

    /// Handle Pocketctl local slash commands directly without daemon routing.
    private func handleLocalCommand(_ trimmed: String) -> Bool {
        guard trimmed.hasPrefix("/") else { return false }
        let args = trimmed.dropFirst().split(separator: " ")
        guard let rawName = args.first else { return false }

        let cmd = String(rawName).lowercased()
        let arg = args.dropFirst().joined(separator: " ").trimmingCharacters(in: .whitespacesAndNewlines)

        switch cmd {
        case "help":
            appendLocalUserMessage(trimmed)
            shouldShowLocalHelp = true
            return true
        case "cost":
            appendLocalCommandResult(
                userText: trimmed,
                command: "/cost",
                message: buildLocalCostMessage()
            )
            return true
        case "status":
            appendLocalCommandResult(
                userText: trimmed,
                command: "/status",
                message: buildLocalStatusMessage()
            )
            return true
        case "model":
            appendLocalCommandResult(
                userText: trimmed,
                command: "/model",
                message: buildLocalModelMessage(argument: arg)
            )
            return true
        default:
            return false
        }
    }

    /// Append local command feedback and broadcast via local_command_log for
    /// cross-device history sync (no daemon round-trip).
    private func appendLocalCommandResult(userText: String, command: String, message: String, receiptStatus: String = "success") {
        appendLocalUserMessage(userText)
        msgCounter += 1
        messages.append(ChatMessage(
            id: msgCounter,
            role: .agent,
            type: .commandReceipt,
            content: message,
            streaming: false,
            command: command,
            receiptStatus: receiptStatus
        ))
        if !isBatchProcessing { scrollTick += 1 }

        wsService.send([
            "type": "local_command_log",
            "session_id": session.sessionId,
            "user_text": userText,
            "command": command,
            "receipt_status": receiptStatus,
            "message": message,
        ])
    }

    /// Append only the user-side message (for /help).
    private func appendLocalUserMessage(_ text: String) {
        msgCounter += 1
        messages.append(ChatMessage(
            id: msgCounter,
            role: .user,
            type: nil,
            content: text,
            streaming: false
        ))
        if !isBatchProcessing { scrollTick += 1 }
    }

    func respondApproval(requestId: String, action: String) {
        guard ["once", "always", "reject", "cancel"].contains(action),
              let message = messages.last(where: { $0.type == .approvalRequest && $0.requestId == requestId }),
              markInteractionSubmitting(requestId: requestId, type: .approvalRequest) else { return }
        if sessionAgentCapabilities.contains("permission_actions") || !message.availableDecisions.isEmpty {
            wsService.send(["type": "approval_response", "session_id": session.sessionId, "request_id": requestId, "action": action])
        } else {
            wsService.send(["type": "approval_response", "session_id": session.sessionId, "request_id": requestId, "approved": action != "reject" && action != "cancel"])
        }
        armInteractionTimeout(requestId: requestId)
    }

    func respondQuestion(requestId: String, answers: [[String]]) {
        guard !answers.isEmpty, answers.allSatisfy({ !$0.isEmpty }), markInteractionSubmitting(requestId: requestId, type: .openCodeQuestion) else { return }
        wsService.send(["type": "question_response", "session_id": session.sessionId, "request_id": requestId, "answers": answers])
        armInteractionTimeout(requestId: requestId)
    }

    func rejectQuestion(requestId: String) {
        guard markInteractionSubmitting(requestId: requestId, type: .openCodeQuestion) else { return }
        wsService.send(["type": "question_reject", "session_id": session.sessionId, "request_id": requestId])
        armInteractionTimeout(requestId: requestId)
    }

    func respondMcpElicitation(requestId: String, action: String, content: [String: Any]? = nil) {
        guard ["accept", "decline", "cancel"].contains(action),
              markInteractionSubmitting(requestId: requestId, type: .mcpElicitation) else { return }
        var payload: [String: Any] = [
            "type": "mcp_elicitation_response", "session_id": session.sessionId,
            "request_id": requestId, "elicitation_action": action,
        ]
        if let content { payload["elicitation_content"] = content }
        wsService.send(payload)
        armInteractionTimeout(requestId: requestId)
    }

    private func markInteractionSubmitting(requestId: String, type: ChatMessageType) -> Bool {
        guard let index = messages.lastIndex(where: { $0.type == type && $0.requestId == requestId }), !messages[index].interactionSubmitting else { return false }
        messages[index].interactionSubmitting = true
        messages[index].interactionError = nil
        return true
    }

    private func armInteractionTimeout(requestId: String) {
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(15))
            guard let self, let index = self.messages.lastIndex(where: { $0.requestId == requestId && $0.interactionSubmitting }) else { return }
            self.messages[index].interactionSubmitting = false
            self.messages[index].interactionError = "操作超时，请重试"
        }
    }

    /// Send the user's menu choice back to the daemon. The matching card is
    /// optimistically marked so its chosen option highlights and the rest dim;
    /// the daemon writes the chosen index to the agent's PTY so the blocking
    /// selection prompt proceeds.
    func respondChoice(requestId: String, choice: String) {
        if let idx = messages.lastIndex(where: { $0.type == .interactiveChoice && $0.requestId == requestId }) {
            messages[idx].selectedChoice = choice
        }
        wsService.send([
            "type": "interactive_response",
            "session_id": session.sessionId,
            "request_id": requestId,
            "choice": choice,
        ])
    }

    /// Local /cost output: prefer in-memory usage totals when available; fallback
    /// to session totals from session_list.
    private func buildLocalCostMessage() -> String {
        if let usage = lastUsage ?? lastAgentUsage {
            let input = usage.inputTokens
            let output = usage.outputTokens
            let cacheRead = usage.cacheReadTokens
            let cacheCreate = usage.cacheCreateTokens
            let total = input + output + cacheRead + cacheCreate
            return "累计 \(fmtTokens(total)) tokens（输入 \(fmtTokens(input)) · 输出 \(fmtTokens(output)) · 缓存 \(fmtTokens(cacheRead + cacheCreate))）"
        }
        if session.totalTokens > 0 {
            return "累计 \(fmtTokens(Int(session.totalTokens))) tokens（来源：会话数据库汇总）"
        }
        return "当前会话暂无 token 用量记录"
    }

    /// Local /status output from cached session/daemon metadata.
    private func buildLocalStatusMessage() -> String {
        let daemonName = hostDisplayName
        let online = wsService.isDaemonOnline(session.daemonId) ? "在线" : (session.daemonOnline ? "离线（历史）" : "离线")
        let agent = displayAgentName(session.agentType)
        var parts: [String] = []
        parts.append("主机 \(daemonName) · \(online)")
        if let daemon = wsService.daemons[session.daemonId] {
            if let info = daemon.agents.first(where: { $0.type == session.agentType }), !info.version.isEmpty {
                parts.append("\(agent) v\(info.version)")
            } else if !daemon.agents.isEmpty {
                let versions = daemon.agents.compactMap { info -> String? in
                    guard !info.version.isEmpty else { return nil }
                    return "\(displayAgentName(info.type)) v\(info.version)"
                }
                if !versions.isEmpty {
                    parts.append(versions.joined(separator: " / "))
                }
            }
        }
        if let model = currentModel, !model.isEmpty {
            parts.append("当前模型 \(model)")
        }
        parts.append("账户状态请在终端运行 pocketctl status 查看")
        return parts.joined(separator: " · ")
    }

    /// Local /model output. With argument, keep behavior unchanged and instruct
    /// users to switch in terminal.
    private func buildLocalModelMessage(argument: String) -> String {
        if !argument.isEmpty {
            return "请在终端使用 /model 切换模型，切换后将在下一条回复生效并自动同步到此处。"
        }
        if let model = currentModel, !model.isEmpty {
            return "当前模型：\(model)"
        }
        return "当前会话未上报模型信息"
    }

    private func displayAgentName(_ type: String) -> String {
        switch type {
        case "claude-code":
            return "Claude"
        case "codex":
            return "Codex"
        case "opencode":
            return "OpenCode"
        default:
            return type.isEmpty ? "Agent" : type
        }
    }

    // MARK: - Event handling

    private func handleEvent(_ dict: [String: Any]) {
        guard var event = WebSocketEvent(dict: dict) else { return }

        // ── Replay control events (no session ID filter) ──

        if event.type == .replayBatch {
            let isBackward = event.direction == "backward"
            var bufMessages = messages
            var bufSubAgents = subAgents

            isBatchProcessing = true
            // backward batches arrive id DESC; reverse to ASC for chronological prepend
            let ordered = isBackward ? (event.events ?? []).reversed() : (event.events ?? [])

            if let focusedSubAgent {
                // 子智能体详情与主会话保持同一分页语义：
                // 首次 replay_subagent 返回最新一页（backward），客户端按时间正序 append；
                // 向上滚动加载 older page 时 prepend 到当前子智能体消息前面。
                var pageMessages: [ChatMessage] = []
                var pageSubAgents = [focusedSubAgent.agentId: focusedSubagentSeed(focusedSubAgent)]
                for evtDict in ordered {
                    handleEventDirect(evtDict, messages: &pageMessages, subAgents: &pageSubAgents)
                }
                if var current = bufSubAgents[focusedSubAgent.agentId],
                   let page = pageSubAgents[focusedSubAgent.agentId] {
                    current.messages = (isLoadingBackward && isBackward)
                        ? page.messages + current.messages
                        : current.messages + page.messages
                    bufSubAgents[focusedSubAgent.agentId] = current
                } else if let page = pageSubAgents[focusedSubAgent.agentId] {
                    bufSubAgents[focusedSubAgent.agentId] = page
                }
            } else if isLoadingBackward && isBackward {
                // 向上滚分页：prepend 更早一页消息（对齐 web）
                let newerTodoExists = bufMessages.contains(where: { $0.type == .openCodeTodo })
                var prependMsgs: [ChatMessage] = []
                for evtDict in ordered {
                    handleEventDirect(evtDict, messages: &prependMsgs, subAgents: &bufSubAgents)
                }
                if newerTodoExists {
                    prependMsgs.removeAll(where: { $0.type == .openCodeTodo })
                }
                bufMessages = prependMsgs + bufMessages
            } else {
                // 初始加载 / forward：append
                for evtDict in ordered {
                    handleEventDirect(evtDict, messages: &bufMessages, subAgents: &bufSubAgents)
                }
            }
            isBatchProcessing = false

            messages = bufMessages
            subAgents = bufSubAgents
            scrollTick += 1
            return
        }

        if event.type == .replayEnd {
            if let currentStatus = event.status {
                var reconciledStatus = currentStatus
                if ["running", "busy", "retry"].contains(currentStatus),
                   let lastActivity = event.lastActivityAt.flatMap(parseDate),
                   Date().timeIntervalSince(lastActivity) > 120 {
                    reconciledStatus = "idle"
                }
                applyStatus(reconciledStatus, lastActivityAt: event.turnStartedAt)
            }
            isLoading = false
            isLoadingBackward = false
            if let hasMoreVal = event.hasMore {
                hasMore = hasMoreVal
            }
            // backward: last_seq is the oldest id of the returned page → next cursor
            if let seq = event.lastSeq, loadedMinId == 0 || seq < loadedMinId {
                loadedMinId = seq
            }
            // replay 中 subagent_discovered 创建的 SubAgent token=0；
            // 用 session.children（DB 权威值）覆盖，确保 token 数据正确。
            syncChildrenTokens()
            scrollTick += 1
            return
        }

        if event.type == .userMessageAck {
            if let msgId = event.msgId {
                _ = pendingUserMessages.acknowledge(id: msgId)
            }
            applyTurnSignal(.acknowledged)
            return
        }

        if event.type == .userMessageNack {
            if let msgId = event.msgId {
                _ = pendingUserMessages.reject(id: msgId)
            }
            switch event.reason {
            case "daemon_offline":
                sendFailureMessage = "主机离线，消息未发送"
            case "session_not_found":
                sendFailureMessage = "会话不存在，消息未发送"
            default:
                sendFailureMessage = "消息未发送"
            }
            applyTurnSignal(.rejected)
            return
        }

        if event.type == .userMessageReceipt {
            guard event.sessionId == session.sessionId,
                  let msgId = event.msgId,
                  let delivery = pendingUserMessages.resolve(
                    id: msgId,
                    status: event.status ?? "rejected"
                  ) else { return }
            if delivery == .accepted {
                applyTurnSignal(.acknowledged)
            } else {
                sendFailureMessage = event.reason ?? "消息未被 Codex 接受"
                applyTurnSignal(.rejected)
            }
            return
        }

        if event.type == .daemonStatus, event.daemonId == session.daemonId {
            applyDaemonSnapshot(event: event)
            if event.status != "online" {
                applyTurnSignal(.rejected)
            }
            return
        }

        // ── Session ID change (must be handled before the filter) ──

        if event.type == .sessionIdChanged {
            if let newId = event.sessionId,
               let oldId = dict["old_session_id"] as? String,
               oldId == session.sessionId {
                session.sessionId = newId
            }
            return
        }

        // ── Session-scoped events ──
        // Skip session ID filter during batch replay — DB payloads may carry
        // old pre-change session IDs that don't match the current session.
        if !isBatchProcessing {
            guard event.sessionId == session.sessionId else { return }
        }

        // Sub-agent events
        guard eventDeduplicator.shouldAccept(dict) else { return }
        guard let normalizedEvent = normalizeContentStreamEvent(event) else { return }
        event = normalizedEvent

        if let agentId = event.agentId {
            handleSubAgentEvent(agentId: agentId, event: event, dict: dict)
            return
        }

        switch event.type {
        case .agentText:
            handleAgentText(event)

        case .agentReasoning:
            handleAgentReasoning(event, messages: &messages)

        case .agentRetry:
            handleOpenCodeNotice(event, type: .retryNotice, messages: &messages)

        case .agentCompaction:
            handleOpenCodeNotice(event, type: .compactionNotice, messages: &messages)

        case .agentFile, .agentPatch, .agentTodo, .agentSubtask, .agentProfile:
            handleOpenCodeStructured(event, messages: &messages)

        case .userText:
            handleUserText(event)

        case .toolCall:
            handleToolCall(event, dict: dict)

        case .toolResult:
            handleToolResult(event)

        case .subagentDiscovered:
            handleSubagentDiscovered(event, dict: dict)

        case .sessionStatus:
            if SessionStatusEventPolicy.isConnectivityOverlay(event.status) {
                // Relays predating the lifecycle split used a synthetic session
                // status for daemon loss. Keep the last authoritative lifecycle
                // state so reconnect can restore its composer instead of ending it.
                session.daemonOnline = false
                applyTurnSignal(.rejected)
            } else {
                applyStatus(event.status ?? status, lastActivityAt: event.turnStartedAt)
                exitReason = event.exitReason ?? exitReason
            }

        case .sessionTitleUpdate:
            title = event.title

        case .sessionMeta:
            if let model = event.resolvedModel, !model.isEmpty {
                currentModel = model
            }
            if let effort = event.effort?.trimmingCharacters(in: .whitespacesAndNewlines), !effort.isEmpty {
                currentEffort = effort
            }
            currentPermission = event.permission
            permissionMutable = event.permissionMutable
            permissionMutableModes = event.permissionMutableModes
            pendingPermission = nil
            sessionAgentCapabilities = Set(event.capabilities)
            session.capabilities = event.capabilities
            if let controlMode = event.controlMode {
                session.controlMode = controlMode
            }
            if let currentAgent = event.currentAgent, !currentAgent.isEmpty {
                currentSessionAgent = currentAgent
                session.activeAgent = currentAgent
            }
            if showsSessionAgentPicker && sessionAgents.isEmpty { requestSessionAgents() }

        case .sessionAgentList:
            sessionAgents = event.sessionAgents
            sessionAgentsLoading = false
            sessionAgentError = nil

        case .sessionAgentChanged:
            currentSessionAgent = event.currentAgent
            session.activeAgent = event.currentAgent
            sessionAgentSubmitting = false
            pendingSessionAgentName = nil
            sessionAgentError = nil

        case .permissionConfigChanged:
            currentPermission = event.permission
            pendingPermission = nil
            lastPermissionError = nil
            permissionEffectNotice = event.permissionEffective == "next_turn" ? "下一次执行生效" : nil

        case .sessionModelChanged:
            if let model = event.resolvedModel, !model.isEmpty {
                currentModel = model
            }

        case .commandReceipt:
            handleCommandReceipt(event)

        case .commandList:
            handleCommandList(event)

        case .approvalRequest:
            handleApprovalRequest(event)

        case .approvalResolved:
            resolveApprovalCard(requestId: event.requestId, action: event.action ?? (event.approved ? "once" : "reject"), reason: event.reason, messages: &messages)

        case .questionRequest:
            upsertQuestionRequest(event, messages: &messages)

        case .questionResolved:
            resolveQuestionCard(requestId: event.requestId, answers: event.answers, rejected: event.rejected, reason: event.reason, redacted: event.redacted, messages: &messages)

        case .mcpElicitationRequest:
            upsertMcpElicitation(event, messages: &messages)

        case .mcpElicitationResolved:
            resolveMcpElicitation(requestId: event.requestId, action: event.action ?? "cancel", reason: event.reason, redacted: event.redacted, messages: &messages)

        case .interactionResult:
            guard event.status == "resolved_elsewhere" else { break }
            if event.operation == "approval_response" {
                resolveApprovalCard(requestId: event.requestId, action: "elsewhere", reason: "resolved_elsewhere", messages: &messages)
            } else if ["question_response", "question_reject"].contains(event.operation ?? "") {
                resolveQuestionCard(requestId: event.requestId, answers: [], rejected: false, reason: "resolved_elsewhere", messages: &messages)
            } else if event.operation == "mcp_elicitation_response" {
                resolveMcpElicitation(requestId: event.requestId, action: "elsewhere", reason: "resolved_elsewhere", redacted: true, messages: &messages)
            }

        case .interactivePrompt:
            handleInteractivePrompt(event)

        case .error:
            if ["approval_response", "question_response", "question_reject", "mcp_elicitation_response"].contains(event.operation ?? ""),
               let requestId = event.requestId,
               let index = messages.lastIndex(where: { $0.requestId == requestId }) {
                messages[index].interactionSubmitting = false
                messages[index].interactionError = event.error ?? "操作失败"
                break
            }
            if event.operation == "list_session_agents" || event.operation == "set_session_agent" {
                sessionAgentsLoading = false
                sessionAgentSubmitting = false
                pendingSessionAgentName = nil
                sessionAgentError = event.error ?? "Agent 操作失败"
                break
            }
            if pendingPermission != nil {
                pendingPermission = nil
                lastPermissionError = event.error ?? "权限修改失败"
                requestSessionMeta()
                break
            }
            msgCounter += 1
            messages.append(ChatMessage(
                id: msgCounter,
                role: .agent,
                type: .error,
                content: event.error ?? "未知错误",
                streaming: false
            ))

        default:
            break
        }
    }

    // MARK: - Direct event handling (batch mode — operates on inout buffers)

    private func handleEventDirect(_ dict: [String: Any], messages: inout [ChatMessage], subAgents: inout [String: SubAgent]) {
        guard var event = WebSocketEvent(dict: dict) else { return }
        guard eventDeduplicator.shouldAccept(dict) else { return }
        guard let normalizedEvent = normalizeContentStreamEvent(event) else { return }
        event = normalizedEvent

        // Sub-agent events
        if let agentId = event.agentId {
            handleSubAgentEventDirect(agentId: agentId, event: event, dict: dict, messages: &messages, subAgents: &subAgents)
            return
        }

        switch event.type {
        case .agentText:
            handleAgentTextDirect(event, messages: &messages)

        case .agentReasoning:
            handleAgentReasoning(event, messages: &messages)

        case .agentRetry:
            handleOpenCodeNotice(event, type: .retryNotice, messages: &messages)

        case .agentCompaction:
            handleOpenCodeNotice(event, type: .compactionNotice, messages: &messages)

        case .agentFile, .agentPatch, .agentTodo, .agentSubtask, .agentProfile:
            handleOpenCodeStructured(event, messages: &messages)

        case .userText:
            handleUserTextDirect(event, messages: &messages)

        case .toolCall:
            handleToolCallDirect(event, dict: dict, messages: &messages)

        case .toolResult:
            handleToolResultDirect(event, messages: &messages)

        case .subagentDiscovered:
            handleSubagentDiscoveredDirect(event, dict: dict, messages: &messages, subAgents: &subAgents)

        case .sessionStatus:
            if SessionStatusEventPolicy.isConnectivityOverlay(event.status) {
                session.daemonOnline = false
                applyTurnSignal(.rejected)
            } else {
                applyStatus(event.status ?? status, lastActivityAt: event.lastActivityAt)
                exitReason = event.exitReason ?? exitReason
            }

        case .sessionTitleUpdate:
            title = event.title

        case .commandReceipt:
            handleCommandReceiptDirect(event, messages: &messages)

        case .approvalRequest:
            handleApprovalRequestDirect(event, messages: &messages)

        case .approvalResolved:
            resolveApprovalCard(requestId: event.requestId, action: event.action ?? (event.approved ? "once" : "reject"), reason: event.reason, messages: &messages)

        case .questionRequest:
            upsertQuestionRequest(event, messages: &messages)

        case .questionResolved:
            resolveQuestionCard(requestId: event.requestId, answers: event.answers, rejected: event.rejected, reason: event.reason, redacted: event.redacted, messages: &messages)

        case .mcpElicitationRequest:
            upsertMcpElicitation(event, messages: &messages)

        case .mcpElicitationResolved:
            resolveMcpElicitation(requestId: event.requestId, action: event.action ?? "cancel", reason: event.reason, redacted: event.redacted, messages: &messages)

        case .sessionAgentChanged:
            currentSessionAgent = event.currentAgent
            session.activeAgent = event.currentAgent
            sessionAgentSubmitting = false
            pendingSessionAgentName = nil
            sessionAgentError = nil

        case .interactivePrompt:
            handleInteractivePromptDirect(event, messages: &messages)

        case .error:
            msgCounter += 1
            messages.append(ChatMessage(
                id: msgCounter,
                role: .agent,
                type: .error,
                content: event.error ?? "未知错误",
                streaming: false
            ))

        default:
            break
        }
    }

    private func focusedSubagentSeed(_ subAgent: SubAgent) -> SubAgent {
        SubAgent(
            agentId: subAgent.agentId,
            description: subAgent.description,
            agentType: subAgent.agentType,
            messages: [],
            status: subAgent.status,
            tokenIn: subAgent.tokenIn,
            tokenOut: subAgent.tokenOut,
            tokenCache: subAgent.tokenCache,
            tokenCacheCreate: subAgent.tokenCacheCreate,
            title: subAgent.title
        )
    }

    private func normalizeContentStreamEvent(_ event: WebSocketEvent) -> WebSocketEvent? {
        guard let streamId = event.streamId else { return event }
        guard [.agentText, .agentReasoning, .toolResult].contains(event.type),
              let sequence = event.chunkSequence,
              let byteOffset = event.byteOffset else {
            return nil
        }
        let chunkContent: String
        switch event.type {
        case .toolResult:
            chunkContent = event.output ?? ""
        case .agentText, .agentReasoning:
            chunkContent = event.text ?? ""
        default:
            return event
        }
        guard let update = contentStreams.accept(ContentStreamChunk(
            streamId: streamId,
            sequence: sequence,
            byteOffset: byteOffset,
            content: chunkContent,
            final: event.streamFinal,
            totalBytes: event.totalBytes
        )), update.changed || update.transitionedToComplete else {
            return nil
        }

        var raw = event.raw
        raw["streaming"] = !update.completed
        raw["final"] = update.completed
        raw["truncated"] = event.streamTruncated == true || update.truncated
        raw["received_bytes"] = update.receivedBytes
        raw["stream_incomplete"] = update.incomplete
        switch event.type {
        case .toolResult:
            raw["output"] = update.content
        case .agentText, .agentReasoning:
            raw["text"] = update.content
            raw["part_id"] = "stream:\(streamId)"
        default:
            break
        }
        return WebSocketEvent(dict: raw)
    }

    @discardableResult
    private func applyStreamedPart(
        _ event: WebSocketEvent,
        type: ChatMessageType,
        text: String,
        messages: inout [ChatMessage]
    ) -> Bool {
        guard let streamId = event.streamId else { return false }
        let partId = "stream:\(streamId)"
        if let index = messages.firstIndex(where: { $0.type == type && $0.partId == partId }) {
            messages[index].content = text
            messages[index].streaming = event.streaming
            if let usage = event.usage { messages[index].usage = usage }
            return true
        }
        msgCounter += 1
        messages.append(ChatMessage(
            id: msgCounter,
            role: .agent,
            type: type,
            content: text,
            streaming: event.streaming,
            partId: partId,
            usage: event.usage
        ))
        return true
    }

    // MARK: - Individual event handlers (direct mode for batch)

    private func handleAgentTextDirect(_ event: WebSocketEvent, messages: inout [ChatMessage]) {
        // 与 web 对齐：任何 agent_text 事件携带 usage 都先更新 lastUsage。
        if let usage = event.usage {
            lastUsage = usage
        }
        // 纯 usage 载体（opencode step-finish / codex token_count）：无文本，
        // 仅 token 统计。挂到最后一条 agent_text 上，不创建新消息。
        guard let text = event.text, !text.isEmpty else {
            if let usage = event.usage, let lastIdx = messages.lastIndex(where: { $0.type == .agentText }) {
                messages[lastIdx].usage = usage
            }
            return
        }

        if applyStreamedPart(event, type: .agentText, text: text, messages: &messages) {
            return
        }
        if applyRevisionedPart(event, type: .agentText, text: text, messages: &messages) {
            return
        }

        if MessageAppendPolicy.isImmediateDuplicate(
            role: .agent,
            type: .agentText,
            content: text,
            in: messages
        ) {
            if let usage = event.usage {
                messages[messages.count - 1].usage = usage
            }
            if !event.streaming {
                messages[messages.count - 1].streaming = false
            }
            return
        }

        if event.streaming,
           let last = messages.last,
           last.type == .agentText,
           last.streaming {
            messages[messages.count - 1].content += text
            if let usage = event.usage {
                messages[messages.count - 1].usage = usage
            }
        } else {
            msgCounter += 1
            messages.append(ChatMessage(
                id: msgCounter,
                role: .agent,
                type: .agentText,
                content: text,
                streaming: event.streaming,
                usage: event.usage
            ))
        }

        if !event.streaming, let last = messages.last, last.streaming {
            messages[messages.count - 1].streaming = false
            if let usage = event.usage {
                messages[messages.count - 1].usage = usage
            }
        }
        // No scrollTick during batch — handled by caller
    }

    private func handleUserTextDirect(_ event: WebSocketEvent, messages: inout [ChatMessage]) {
        guard var text = event.text, !text.isEmpty else { return }

        text = sanitizeUserMessage(text)
        guard !text.isEmpty else { return }

        if MessageAppendPolicy.isImmediateDuplicate(
            role: .user,
            type: nil,
            content: text,
            in: messages
        ) {
            return
        }

        msgCounter += 1
        messages.append(ChatMessage(
            id: msgCounter,
            role: .user,
            type: nil,
            content: text,
            streaming: false
        ))
    }

    private func handleToolCallDirect(_ event: WebSocketEvent, dict: [String: Any], messages: inout [ChatMessage]) {
        let inputDesc = formatToolInput(tool: event.tool, input: event.input)
        if let callId = event.callId,
           let index = messages.firstIndex(where: { $0.type == .toolCall && $0.callId == callId }) {
            messages[index].tool = event.tool
            messages[index].inputDescription = inputDesc
            messages[index].rawInputJSON = Self.encodeInput(event.input)
            if let pending = pendingToolResults.removeValue(forKey: callId) {
                messages[index].output = pending.output
                messages[index].streaming = pending.streaming
            }
            return
        }
        msgCounter += 1
        messages.append(ChatMessage(
            id: msgCounter,
            role: .agent,
            type: .toolCall,
            content: "",
            streaming: false,
            tool: event.tool,
            callId: event.callId,
            inputDescription: inputDesc,
            rawInputJSON: Self.encodeInput(event.input)
        ))
        // Apply buffered out-of-order tool_result if present (result may precede call in DB id order)
        if let callId = event.callId, let pending = pendingToolResults.removeValue(forKey: callId) {
            messages[messages.count - 1].output = pending.output
            messages[messages.count - 1].streaming = pending.streaming
        }
    }

    private func handleToolResultDirect(_ event: WebSocketEvent, messages: inout [ChatMessage]) {
        guard let callId = event.callId else { return }
        if let index = messages.lastIndex(where: { $0.type == .toolCall && $0.callId == callId }) {
            messages[index].output = event.output ?? ""
            messages[index].streaming = event.streaming

            if !event.streaming && messages[index].tool == "Agent" && messages[index].subAgentId != nil {
                messages[index].output = "子智能体已完成"
            }
        } else {
            // Out-of-order: tool_result arrived before tool_call — buffer for later
            pendingToolResults[callId] = (event.output ?? "", event.streaming)
        }
    }

    private func handleSubagentDiscoveredDirect(_ event: WebSocketEvent, dict: [String: Any], messages: inout [ChatMessage], subAgents: inout [String: SubAgent]) {
        guard let agentId = event.agentId else { return }
        let subAgent = SubAgent(
            agentId: agentId,
            description: event.subagentDesc ?? "",
            agentType: event.subagentType ?? "",
            messages: [],
            status: "completed"
        )
        subAgents[agentId] = subAgent

        if let callId = event.callId,
           let index = messages.lastIndex(where: { $0.type == .toolCall && $0.callId == callId }) {
            messages[index].subAgentId = agentId
        }
    }

    private func handleSubAgentEventDirect(agentId: String, event: WebSocketEvent, dict: [String: Any], messages: inout [ChatMessage], subAgents: inout [String: SubAgent]) {
        // subagent_discovered 需要创建 SubAgent 条目，必须在 guard 之前处理。
        if event.type == .subagentDiscovered {
            handleSubagentDiscoveredDirect(event, dict: dict, messages: &messages, subAgents: &subAgents)
            return
        }
        // subagent_usage：累加 token（前向兼容 — 当前 relay 不转发此事件）。
        if event.type == .subagentUsage {
            guard let usage = event.subagentUsage, subAgents[agentId] != nil else { return }
            var agent = subAgents[agentId]!
            agent.tokenIn += Int64(usage.inputTokens)
            agent.tokenOut += Int64(usage.outputTokens)
            agent.tokenCache += Int64(usage.cacheReadTokens)
            agent.tokenCacheCreate += Int64(usage.cacheCreateTokens)
            subAgents[agentId] = agent
            return
        }
        // subagent_title_update：更新标题（P1b 广播给订阅客户端，实时生效）。
        if event.type == .subagentTitleUpdate {
            guard let title = event.subagentTitle, subAgents[agentId] != nil else { return }
            subAgents[agentId]?.title = title
            return
        }

        guard subAgents[agentId] != nil else { return }

        switch event.type {
        case .userText:
            guard var text = event.text, !text.isEmpty else { return }
            text = sanitizeUserMessage(text)
            guard !text.isEmpty else { return }
            var agent = subAgents[agentId]!
            if let last = agent.messages.last, last.role == .user, last.content == text {
                return
            }
            msgCounter += 1
            agent.messages.append(ChatMessage(
                id: msgCounter,
                role: .user,
                type: nil,
                content: text,
                streaming: false
            ))
            subAgents[agentId] = agent

        case .agentText:
            if let usage = event.usage {
                lastUsage = usage
            }
            var agent = subAgents[agentId]!
            guard let text = event.text, !text.isEmpty else {
                if let usage = event.usage,
                   let lastIdx = agent.messages.lastIndex(where: { $0.type == .agentText }) {
                    agent.messages[lastIdx].usage = usage
                }
                subAgents[agentId] = agent
                return
            }
            if applyStreamedPart(event, type: .agentText, text: text, messages: &agent.messages) {
                subAgents[agentId] = agent
                return
            }
            if event.streaming, let last = agent.messages.last, last.streaming {
                agent.messages[agent.messages.count - 1].content += text
                if let usage = event.usage {
                    agent.messages[agent.messages.count - 1].usage = usage
                }
            } else {
                msgCounter += 1
                agent.messages.append(ChatMessage(
                    id: msgCounter,
                    role: .agent,
                    type: .agentText,
                    content: text,
                    streaming: event.streaming,
                    usage: event.usage
                ))
            }
            if !event.streaming, let last = agent.messages.last, last.streaming {
                agent.messages[agent.messages.count - 1].streaming = false
                if let usage = event.usage {
                    agent.messages[agent.messages.count - 1].usage = usage
                }
            }
            subAgents[agentId] = agent

        case .agentReasoning:
            var agent = subAgents[agentId]!
            handleAgentReasoning(event, messages: &agent.messages)
            subAgents[agentId] = agent

        case .toolCall:
            var agent = subAgents[agentId]!
            if let callId = event.callId,
               let index = agent.messages.firstIndex(where: { $0.type == .toolCall && $0.callId == callId }) {
                agent.messages[index].tool = event.tool
                agent.messages[index].inputDescription = formatToolInput(tool: event.tool, input: event.input)
                agent.messages[index].rawInputJSON = Self.encodeInput(event.input)
                subAgents[agentId] = agent
                break
            }
            msgCounter += 1
            agent.messages.append(ChatMessage(
                id: msgCounter,
                role: .agent,
                type: .toolCall,
                content: "",
                streaming: false,
                tool: event.tool,
                callId: event.callId,
                inputDescription: formatToolInput(tool: event.tool, input: event.input),
                rawInputJSON: Self.encodeInput(event.input)
            ))
            subAgents[agentId] = agent

        case .toolResult:
            var agent = subAgents[agentId]!
            if let callId = event.callId,
               let index = agent.messages.lastIndex(where: { $0.type == .toolCall && $0.callId == callId }) {
                agent.messages[index].output = event.output ?? ""
                agent.messages[index].streaming = event.streaming
            }
            subAgents[agentId] = agent

        default:
            break
        }
    }

    // MARK: - Individual event handlers (live mode — operates on self)

    private func handleAgentText(_ event: WebSocketEvent) {
        // 与 web 对齐：任何 agent_text 事件携带 usage 都先更新 lastUsage。
        if let usage = event.usage {
            lastUsage = usage
        }
        // 纯 usage 载体（opencode step-finish / codex token_count）：无文本，
        // 仅 token 统计。挂到最后一条 agent_text 上（让反向扫描也能命中），
        // 不创建新消息。（对应 web SessionDetail.vue:1173-1179）
        guard let text = event.text, !text.isEmpty else {
            if let usage = event.usage, let lastIdx = messages.lastIndex(where: { $0.type == .agentText }) {
                messages[lastIdx].usage = usage
            }
            return
        }

        if applyStreamedPart(event, type: .agentText, text: text, messages: &messages) {
            if !isBatchProcessing { scrollTick += 1 }
            return
        }
        if applyRevisionedPart(event, type: .agentText, text: text, messages: &messages) {
            if !isBatchProcessing { scrollTick += 1 }
            return
        }

        if MessageAppendPolicy.isImmediateDuplicate(
            role: .agent,
            type: .agentText,
            content: text,
            in: messages
        ) {
            if let usage = event.usage {
                messages[messages.count - 1].usage = usage
            }
            if !event.streaming {
                messages[messages.count - 1].streaming = false
            }
            return
        }

        if event.streaming,
           let last = messages.last,
           last.type == .agentText,
           last.streaming {
            // Append to existing streaming message
            messages[messages.count - 1].content += text
            if let usage = event.usage {
                messages[messages.count - 1].usage = usage
            }
        } else {
            // New message
            msgCounter += 1
            messages.append(ChatMessage(
                id: msgCounter,
                role: .agent,
                type: .agentText,
                content: text,
                streaming: event.streaming,
                usage: event.usage
            ))
        }

        // Mark as complete if not streaming
        if !event.streaming, let last = messages.last, last.streaming {
            messages[messages.count - 1].streaming = false
            // Final non-streaming chunk may carry usage even when text repeats
            if let usage = event.usage {
                messages[messages.count - 1].usage = usage
            }
        }
        if !isBatchProcessing { scrollTick += 1 }
    }

    /// Applies an OpenCode mutable Part by identity. Returning true means the
    /// event used the revisioned path (including a stale event that was safely
    /// ignored); false lets legacy daemon events use adjacency-based behavior.
    @discardableResult
    private func applyRevisionedPart(
        _ event: WebSocketEvent,
        type: ChatMessageType,
        text: String,
        messages: inout [ChatMessage]
    ) -> Bool {
        guard let partId = event.partId, let revision = event.revision, revision > 0 else {
            return false
        }

        if let index = messages.firstIndex(where: { $0.partId == partId }) {
            var existing = messages[index]
            if existing.revision >= revision { return true }
            existing.content = event.replace ? text : existing.content + text
            existing.revision = revision
            existing.streaming = event.streaming
            existing.messageId = event.messageId ?? existing.messageId
            if let usage = event.usage { existing.usage = usage }
            messages[index] = existing
            return true
        }

        msgCounter += 1
        messages.append(ChatMessage(
            id: msgCounter,
            role: .agent,
            type: type,
            content: text,
            streaming: event.streaming,
            messageId: event.messageId,
            partId: partId,
            revision: revision,
            usage: event.usage
        ))
        return true
    }

    private func handleAgentReasoning(_ event: WebSocketEvent, messages: inout [ChatMessage]) {
        guard let text = event.text, !text.isEmpty else { return }
        if applyStreamedPart(event, type: .reasoning, text: text, messages: &messages) { return }
        if applyRevisionedPart(event, type: .reasoning, text: text, messages: &messages) { return }
        if MessageAppendPolicy.isImmediateDuplicate(role: .agent, type: .reasoning, content: text, in: messages) { return }
        msgCounter += 1
        messages.append(ChatMessage(
            id: msgCounter,
            role: .agent,
            type: .reasoning,
            content: text,
            streaming: event.streaming
        ))
    }

    private func handleOpenCodeNotice(
        _ event: WebSocketEvent,
        type: ChatMessageType,
        messages: inout [ChatMessage]
    ) {
        if let partId = event.partId,
           messages.contains(where: { $0.type == type && $0.partId == partId }) {
            return
        }
        msgCounter += 1
        messages.append(ChatMessage(
            id: msgCounter,
            role: .agent,
            type: type,
            content: event.error ?? "",
            streaming: false,
            partId: event.partId,
            attempt: event.attempt ?? 0,
            retryAt: event.retryAt,
            automatic: event.compactionAuto,
            overflow: event.overflow
        ))
    }

    private func handleOpenCodeStructured(_ event: WebSocketEvent, messages: inout [ChatMessage]) {
        let messageType: ChatMessageType
        switch event.type {
        case .agentFile: messageType = .openCodeFile
        case .agentPatch: messageType = .openCodePatch
        case .agentTodo: messageType = .openCodeTodo
        case .agentSubtask: messageType = .openCodeSubtask
        case .agentProfile: messageType = .openCodeAgent
        default: return
        }

        let existingIndex: Int?
        if messageType == .openCodeTodo {
            existingIndex = messages.firstIndex(where: { $0.type == .openCodeTodo })
        } else if let partId = event.partId {
            existingIndex = messages.firstIndex(where: { $0.type == messageType && $0.partId == partId })
        } else {
            existingIndex = nil
        }

        if let index = existingIndex {
            guard messageType == .openCodeTodo else { return }
            messages[index].todos = event.todos
            return
        }

        msgCounter += 1
        var message = ChatMessage(
            id: msgCounter,
            role: .agent,
            type: messageType,
            content: "",
            streaming: false,
            messageId: event.messageId,
            partId: event.partId
        )
        message.mime = event.mime ?? ""
        message.filename = event.filename ?? ""
        message.url = event.url ?? ""
        message.partSource = event.partSource ?? ""
        message.patchHash = event.patchHash ?? ""
        message.files = event.files
        message.prompt = event.prompt ?? ""
        message.partDescription = event.partDescription ?? ""
        message.partAgent = event.partAgent ?? ""
        message.partModel = event.partModel ?? ""
        message.partCommand = event.partCommand ?? ""
        message.profileName = event.profileName ?? ""
        message.todos = event.todos
        messages.append(message)
    }

    private func handleUserText(_ event: WebSocketEvent) {
        guard var text = event.text, !text.isEmpty else { return }

        // Sanitize command tags for clean display
        text = sanitizeUserMessage(text)
        guard !text.isEmpty else { return }

        // Deduplicate: skip if last message has identical content
        if MessageAppendPolicy.isImmediateDuplicate(
            role: .user,
            type: nil,
            content: text,
            in: messages
        ) {
            return
        }

        msgCounter += 1
        messages.append(ChatMessage(
            id: msgCounter,
            role: .user,
            type: nil,
            content: text,
            streaming: false
        ))
        if !isBatchProcessing { scrollTick += 1 }
    }

    private func handleToolCall(_ event: WebSocketEvent, dict: [String: Any]) {
        let inputDesc = formatToolInput(tool: event.tool, input: event.input)
        if let callId = event.callId,
           let index = messages.firstIndex(where: { $0.type == .toolCall && $0.callId == callId }) {
            messages[index].tool = event.tool
            messages[index].inputDescription = inputDesc
            messages[index].rawInputJSON = Self.encodeInput(event.input)
            if let pending = pendingToolResults.removeValue(forKey: callId) {
                messages[index].output = pending.output
                messages[index].streaming = pending.streaming
            }
            return
        }
        msgCounter += 1
        messages.append(ChatMessage(
            id: msgCounter,
            role: .agent,
            type: .toolCall,
            content: "",
            streaming: false,
            tool: event.tool,
            callId: event.callId,
            inputDescription: inputDesc,
            rawInputJSON: Self.encodeInput(event.input)
        ))
        // Apply buffered out-of-order tool_result if present
        if let callId = event.callId, let pending = pendingToolResults.removeValue(forKey: callId) {
            messages[messages.count - 1].output = pending.output
            messages[messages.count - 1].streaming = pending.streaming
        }
    }

    private func handleToolResult(_ event: WebSocketEvent) {
        guard let callId = event.callId else { return }
        // Find matching tool call (reverse search)
        if let index = messages.lastIndex(where: { $0.type == .toolCall && $0.callId == callId }) {
            messages[index].output = event.output ?? ""
            messages[index].streaming = event.streaming

            // If this is an Agent tool with sub-agent, replace output
            if !event.streaming && messages[index].tool == "Agent" && messages[index].subAgentId != nil {
                messages[index].output = "子智能体已完成"
            }
        } else {
            // Out-of-order: tool_result arrived before tool_call — buffer for later
            pendingToolResults[callId] = (event.output ?? "", event.streaming)
        }
    }

    private func handleSubagentDiscovered(_ event: WebSocketEvent, dict: [String: Any]) {
        guard let agentId = event.agentId else { return }
        let subAgent = SubAgent(
            agentId: agentId,
            description: event.subagentDesc ?? "",
            agentType: event.subagentType ?? "",
            messages: [],
            status: "completed"
        )
        subAgents[agentId] = subAgent

        // Link to parent Agent tool_call
        if let callId = event.callId,
           let index = messages.lastIndex(where: { $0.type == .toolCall && $0.callId == callId }) {
            messages[index].subAgentId = agentId
        }
    }

    // MARK: - Slash command handlers

    private func handleCommandReceipt(_ event: WebSocketEvent) {
        msgCounter += 1
        messages.append(ChatMessage(
            id: msgCounter,
            role: .agent,
            type: .commandReceipt,
            content: event.receiptMessage ?? "",
            streaming: false,
            command: event.command ?? "",
            receiptStatus: event.receiptStatus ?? "success"
        ))
        if !isBatchProcessing { scrollTick += 1 }
    }

    private func handleCommandList(_ event: WebSocketEvent) {
        var merged: [String: CommandItem] = [:]
        if let cmds = event.commands {
            for item in cmds.compactMap({ CommandItem(dict: $0) }) {
                merged[item.name] = item
            }
        }
        // Local Pocketctl commands are injected for every session type and always
        // available in the input prompt.
        for item in CommandItem.localCommands {
            merged[item.name] = merged[item.name] ?? item
        }
        commands = merged.values
            .sorted { lhs, rhs in
                lhs.source == "pocketctl" && rhs.source != "pocketctl" ? false
                    : lhs.source != "pocketctl" && rhs.source == "pocketctl" ? true
                    : lhs.name.lowercased() < rhs.name.lowercased()
            }
    }

    /// Tool-use approval request — daemon surfaced a PreToolUse hook approval
    /// (non-bypass session). Appends an inline Yes/No card.
    private func handleApprovalRequest(_ event: WebSocketEvent) {
        upsertApprovalRequest(event, messages: &messages)
        if !isBatchProcessing { scrollTick += 1 }
    }

    private func handleCommandReceiptDirect(_ event: WebSocketEvent, messages: inout [ChatMessage]) {
        msgCounter += 1
        messages.append(ChatMessage(
            id: msgCounter,
            role: .agent,
            type: .commandReceipt,
            content: event.receiptMessage ?? "",
            streaming: false,
            command: event.command ?? "",
            receiptStatus: event.receiptStatus ?? "success"
        ))
    }

    /// Pending approval was answered ELSEWHERE — the user typed [y/n] in the
    /// terminal that owns this session. Flip the matching card out of "pending"
    /// so its Yes/No buttons disappear and it shows the terminal-side result,
    /// instead of lingering as a stale, re-answerable prompt on this device.
    /// Shared by live and batch dispatch (operates on the supplied buffer).
    private func resolveApprovalCard(requestId: String?, action: String, reason: String? = nil, messages: inout [ChatMessage]) {
        guard let requestId else { return }
        interactionResolutions[requestId] = .approval(action: action, reason: reason)
        if let index = messages.lastIndex(where: { $0.type == .approvalRequest && $0.requestId == requestId }) {
            let neutralReasons: Set<String> = ["resolved_elsewhere", "timed_out", "daemon_restarted", "hook_disconnected", "session_drained", "server_shutdown"]
            messages[index].approvalStatus = reason.map(neutralReasons.contains) == true ? "resolved" : (["reject", "cancel"].contains(action) ? "denied" : "allowed")
            messages[index].approvalAction = action
            messages[index].interactionResolutionReason = reason
            messages[index].interactionSubmitting = false
            messages[index].interactionError = nil
        }
    }

    private func handleApprovalRequestDirect(_ event: WebSocketEvent, messages: inout [ChatMessage]) {
        upsertApprovalRequest(event, messages: &messages)
    }

    private func upsertApprovalRequest(_ event: WebSocketEvent, messages: inout [ChatMessage]) {
        guard let requestId = event.requestId else { return }
        if let index = messages.lastIndex(where: { $0.type == .approvalRequest && $0.requestId == requestId }) {
            guard messages[index].approvalStatus == "pending" else { return }
            messages[index].tool = event.tool
            messages[index].callId = event.callId
            messages[index].inputDescription = event.partCommand ?? event.partDescription ?? formatToolInput(tool: event.tool, input: event.input)
            messages[index].rawInputJSON = Self.encodeInput(event.input)
            messages[index].permissionName = event.permissionName ?? ""
            messages[index].permissionPatterns = event.patterns
            messages[index].permissionAlways = event.alwaysRules
            messages[index].permissionMetadata = event.metadata
            messages[index].permissionVersion = event.permissionVersion
            messages[index].approvalKind = event.approvalKind
            messages[index].availableDecisions = event.availableDecisions
            if case let .approval(action, reason)? = interactionResolutions[requestId] {
                resolveApprovalCard(requestId: requestId, action: action, reason: reason, messages: &messages)
            }
            return
        }
        // Older replay pages must not duplicate a request already present in
        // the current stream. The first sighting owns the stable card identity.
        if interactionRequestIDs.contains(requestId) { return }
        interactionRequestIDs.insert(requestId)
        msgCounter += 1
        messages.append(ChatMessage(
            id: msgCounter,
            role: .agent,
            type: .approvalRequest,
            content: "",
            streaming: false,
            tool: event.tool,
            callId: event.callId,
            inputDescription: event.partCommand ?? event.partDescription ?? formatToolInput(tool: event.tool, input: event.input),
            rawInputJSON: Self.encodeInput(event.input),
            requestId: requestId,
            approvalStatus: "pending",
            permissionName: event.permissionName ?? "",
            permissionPatterns: event.patterns,
            permissionAlways: event.alwaysRules,
            permissionMetadata: event.metadata,
            permissionVersion: event.permissionVersion,
            approvalKind: event.approvalKind,
            availableDecisions: event.availableDecisions
        ))
        if case let .approval(action, reason)? = interactionResolutions[requestId] {
            resolveApprovalCard(requestId: requestId, action: action, reason: reason, messages: &messages)
        }
    }

    private func upsertQuestionRequest(_ event: WebSocketEvent, messages: inout [ChatMessage]) {
        guard let requestId = event.requestId, !event.questions.isEmpty else { return }
        if let index = messages.lastIndex(where: { $0.type == .openCodeQuestion && $0.requestId == requestId }) {
            guard messages[index].approvalStatus == "pending" else { return }
            messages[index].questions = event.questions
            messages[index].questionAutoResolutionMs = event.autoResolutionMs
            if case let .question(answers, rejected, reason, redacted)? = interactionResolutions[requestId] {
                resolveQuestionCard(requestId: requestId, answers: answers, rejected: rejected, reason: reason, redacted: redacted, messages: &messages)
            }
            return
        }
        if interactionRequestIDs.contains(requestId) { return }
        interactionRequestIDs.insert(requestId)
        msgCounter += 1
        messages.append(ChatMessage(
            id: msgCounter,
            role: .agent,
            type: .openCodeQuestion,
            content: "",
            streaming: false,
            requestId: requestId,
            approvalStatus: "pending",
            questions: event.questions,
            questionAutoResolutionMs: event.autoResolutionMs
        ))
        if case let .question(answers, rejected, reason, redacted)? = interactionResolutions[requestId] {
            resolveQuestionCard(requestId: requestId, answers: answers, rejected: rejected, reason: reason, redacted: redacted, messages: &messages)
        }
    }

    private func resolveQuestionCard(requestId: String?, answers: [[String]], rejected: Bool, reason: String? = nil, redacted: Bool = false, messages: inout [ChatMessage]) {
        guard let requestId else { return }
        interactionResolutions[requestId] = .question(answers: answers, rejected: rejected, reason: reason, redacted: redacted)
        if let index = messages.lastIndex(where: { $0.type == .openCodeQuestion && $0.requestId == requestId }) {
            messages[index].approvalStatus = "resolved"
            messages[index].questionAnswers = answers
            messages[index].questionRejected = rejected
            messages[index].questionRedacted = redacted
            messages[index].interactionResolutionReason = reason
            messages[index].interactionSubmitting = false
            messages[index].interactionError = nil
        }
    }

    private func upsertMcpElicitation(_ event: WebSocketEvent, messages: inout [ChatMessage]) {
        guard let requestId = event.requestId, let mode = event.elicitationMode else { return }
        if let index = messages.lastIndex(where: { $0.type == .mcpElicitation && $0.requestId == requestId }) {
            guard messages[index].approvalStatus == "pending" else { return }
            messages[index].mcpServer = event.mcpServer ?? ""
            messages[index].elicitationMode = mode
            messages[index].elicitationSchema = event.elicitationSchema ?? ""
            messages[index].elicitationURL = event.url ?? ""
            messages[index].elicitationMessage = event.elicitationMessage ?? ""
            if case let .elicitation(action, reason, redacted)? = interactionResolutions[requestId] {
                resolveMcpElicitation(requestId: requestId, action: action, reason: reason, redacted: redacted, messages: &messages)
            }
            return
        }
        if interactionRequestIDs.contains(requestId) { return }
        interactionRequestIDs.insert(requestId)
        msgCounter += 1
        messages.append(ChatMessage(
            id: msgCounter, role: .agent, type: .mcpElicitation, content: "", streaming: false,
            requestId: requestId, approvalStatus: "pending", mcpServer: event.mcpServer ?? "",
            elicitationMode: mode, elicitationId: event.elicitationId ?? "",
            elicitationSchema: event.elicitationSchema ?? "", elicitationURL: event.url ?? "",
            elicitationMessage: event.elicitationMessage ?? ""
        ))
        if case let .elicitation(action, reason, redacted)? = interactionResolutions[requestId] {
            resolveMcpElicitation(requestId: requestId, action: action, reason: reason, redacted: redacted, messages: &messages)
        }
    }

    private func resolveMcpElicitation(requestId: String?, action: String, reason: String? = nil, redacted: Bool = false, messages: inout [ChatMessage]) {
        guard let requestId else { return }
        interactionResolutions[requestId] = .elicitation(action: action, reason: reason, redacted: redacted)
        if let index = messages.lastIndex(where: { $0.type == .mcpElicitation && $0.requestId == requestId }) {
            messages[index].approvalStatus = "resolved"
            messages[index].elicitationAction = action
            messages[index].questionRedacted = redacted
            messages[index].interactionResolutionReason = reason
            messages[index].interactionSubmitting = false
            messages[index].interactionError = nil
        }
    }

    /// PTY selection menu — daemon scanned a menu the agent's TUI drew to the
    /// PTY (e.g. a host PreToolUse hook's "❯1.Yes 2.No" prompt that never
    /// reaches JSONL). Appends an inline numbered-choice card.
    private func handleInteractivePrompt(_ event: WebSocketEvent) {
        guard let requestId = event.requestId else { return }
        if messages.contains(where: { $0.type == .interactiveChoice && $0.requestId == requestId }) {
            return
        }
        msgCounter += 1
        messages.append(ChatMessage(
            id: msgCounter,
            role: .agent,
            type: .interactiveChoice,
            content: "",
            streaming: false,
            requestId: requestId,
            promptText: event.promptText ?? "",
            promptOptions: event.promptOptions,
            selectedChoice: nil
        ))
        if !isBatchProcessing { scrollTick += 1 }
    }

    private func handleInteractivePromptDirect(_ event: WebSocketEvent, messages: inout [ChatMessage]) {
        guard let requestId = event.requestId else { return }
        if messages.contains(where: { $0.type == .interactiveChoice && $0.requestId == requestId }) {
            return
        }
        msgCounter += 1
        messages.append(ChatMessage(
            id: msgCounter,
            role: .agent,
            type: .interactiveChoice,
            content: "",
            streaming: false,
            requestId: requestId,
            promptText: event.promptText ?? "",
            promptOptions: event.promptOptions,
            selectedChoice: nil
        ))
    }


    private func handleSubAgentEvent(agentId: String, event: WebSocketEvent, dict: [String: Any]) {
        // subagent_discovered 需要创建 SubAgent 条目，必须在 guard 之前处理。
        if event.type == .subagentDiscovered {
            handleSubagentDiscovered(event, dict: dict)
            return
        }
        // subagent_usage：累加 token（前向兼容 — 当前 relay 不转发此事件）。
        if event.type == .subagentUsage {
            guard let usage = event.subagentUsage, subAgents[agentId] != nil else { return }
            subAgents[agentId]?.tokenIn += Int64(usage.inputTokens)
            subAgents[agentId]?.tokenOut += Int64(usage.outputTokens)
            subAgents[agentId]?.tokenCache += Int64(usage.cacheReadTokens)
            subAgents[agentId]?.tokenCacheCreate += Int64(usage.cacheCreateTokens)
            return
        }
        // subagent_title_update：更新标题（P1b 广播给订阅客户端，实时生效）。
        if event.type == .subagentTitleUpdate {
            guard let title = event.subagentTitle, subAgents[agentId] != nil else { return }
            subAgents[agentId]?.title = title
            return
        }

        guard subAgents[agentId] != nil else { return }

        switch event.type {
        case .userText:
            guard var text = event.text, !text.isEmpty else { return }
            text = sanitizeUserMessage(text)
            guard !text.isEmpty else { return }
            var agent = subAgents[agentId]!
            if let last = agent.messages.last, last.role == .user, last.content == text {
                return
            }
            msgCounter += 1
            agent.messages.append(ChatMessage(
                id: msgCounter,
                role: .user,
                type: nil,
                content: text,
                streaming: false
            ))
            subAgents[agentId] = agent
            if !isBatchProcessing { scrollTick += 1 }

        case .agentText:
            if let usage = event.usage {
                lastUsage = usage
            }
            var agent = subAgents[agentId]!
            guard let text = event.text, !text.isEmpty else {
                if let usage = event.usage,
                   let lastIdx = agent.messages.lastIndex(where: { $0.type == .agentText }) {
                    agent.messages[lastIdx].usage = usage
                }
                subAgents[agentId] = agent
                return
            }
            if applyStreamedPart(event, type: .agentText, text: text, messages: &agent.messages) {
                subAgents[agentId] = agent
                if !isBatchProcessing { scrollTick += 1 }
                return
            }
            if event.streaming, let last = agent.messages.last, last.streaming {
                agent.messages[agent.messages.count - 1].content += text
                if let usage = event.usage {
                    agent.messages[agent.messages.count - 1].usage = usage
                }
            } else {
                msgCounter += 1
                agent.messages.append(ChatMessage(
                    id: msgCounter,
                    role: .agent,
                    type: .agentText,
                    content: text,
                    streaming: event.streaming,
                    usage: event.usage
                ))
            }
            if !event.streaming, let last = agent.messages.last, last.streaming {
                agent.messages[agent.messages.count - 1].streaming = false
                if let usage = event.usage {
                    agent.messages[agent.messages.count - 1].usage = usage
                }
            }
            subAgents[agentId] = agent
            if !isBatchProcessing { scrollTick += 1 }

        case .agentReasoning:
            var agent = subAgents[agentId]!
            handleAgentReasoning(event, messages: &agent.messages)
            subAgents[agentId] = agent
            if !isBatchProcessing { scrollTick += 1 }

        case .toolCall:
            var agent = subAgents[agentId]!
            if let callId = event.callId,
               let index = agent.messages.firstIndex(where: { $0.type == .toolCall && $0.callId == callId }) {
                agent.messages[index].tool = event.tool
                agent.messages[index].inputDescription = formatToolInput(tool: event.tool, input: event.input)
                agent.messages[index].rawInputJSON = Self.encodeInput(event.input)
                subAgents[agentId] = agent
                break
            }
            msgCounter += 1
            agent.messages.append(ChatMessage(
                id: msgCounter,
                role: .agent,
                type: .toolCall,
                content: "",
                streaming: false,
                tool: event.tool,
                callId: event.callId,
                inputDescription: formatToolInput(tool: event.tool, input: event.input),
                rawInputJSON: Self.encodeInput(event.input)
            ))
            subAgents[agentId] = agent

        case .toolResult:
            var agent = subAgents[agentId]!
            if let callId = event.callId,
               let index = agent.messages.lastIndex(where: { $0.type == .toolCall && $0.callId == callId }) {
                agent.messages[index].output = event.output ?? ""
                agent.messages[index].streaming = event.streaming
            }
            subAgents[agentId] = agent

        default:
            break
        }
    }

    // MARK: - User message sanitization

    /// Sanitize user message content: extract slash command name or strip XML tags
    private func sanitizeUserMessage(_ text: String) -> String {
        // Fast path: skip regex if no XML tags present
        guard text.contains("<command-") || text.contains("<local-command") else { return text }

        // Check if this is a slash command message
        if let cmdName = extractTagContent(text, tag: "command-name") {
            // Show only command-name (e.g. "/model"). command-message is a redundant
            // command identifier (e.g. "model"), not a useful description — appending
            // it produced "/model\nmodel". Aligns with web cleanContent.
            return cmdName
        }

        // Not a command — strip all command-related tags
        return stripAllCommandTags(text)
    }

    /// Extract the inner content of the first occurrence of an XML tag
    private func extractTagContent(_ text: String, tag: String) -> String? {
        let pattern = #"<\#(tag)[^>]*>(.*?)</\#(tag)>"#
        guard let range = text.range(of: pattern, options: .regularExpression) else { return nil }
        let match = String(text[range])
        // Strip all XML tags from the match to get inner content
        let content = match.replacingOccurrences(of: #"<[^>]+>"#, with: "", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return content.isEmpty ? nil : content
    }

    /// Strip all command-related XML tags, keeping the text content
    private func stripAllCommandTags(_ text: String) -> String {
        var result = text
        for tag in ["local-command-caveat", "local-command-stdout", "command-name", "command-message"] {
            result = result.replacingOccurrences(of: #"<\#(tag)[^>]*>"#, with: "", options: .regularExpression)
            result = result.replacingOccurrences(of: #"</\#(tag)>"#, with: "", options: .regularExpression)
        }
        result = result.replacingOccurrences(of: #"<command-args>.*?</command-args>"#, with: "", options: .regularExpression)
        result = result.replacingOccurrences(of: #"\n{3,}"#, with: "\n\n", options: .regularExpression)
        return result.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // MARK: - Children → subAgents token sync

    /// 将 session.children 的 token/title 同步到 subAgents 字典。
    /// relay 不转发 subagent_usage，children（来自 session_list DB 查询）是
    /// token 的权威来源。已存在的 SubAgent 保留其 messages/status，仅更新
    /// token/title；不存在的 child 则创建新条目。
    private func syncChildrenTokens() {
        guard !session.children.isEmpty else { return }
        for child in session.children {
            if var agent = subAgents[child.agentId] {
                // 保留 messages/status，更新 token + title
                if agent.tokenIn != child.tokenIn || agent.tokenOut != child.tokenOut
                    || agent.tokenCache != child.tokenCache || agent.tokenCacheCreate != child.tokenCacheCreate
                    || agent.title != child.title {
                    agent.tokenIn = child.tokenIn
                    agent.tokenOut = child.tokenOut
                    agent.tokenCache = child.tokenCache
                    agent.tokenCacheCreate = child.tokenCacheCreate
                    agent.title = child.title
                    subAgents[child.agentId] = agent
                }
            } else {
                // 不存在于 subAgents → 从 children 创建（无 messages）
                subAgents[child.agentId] = SubAgent(
                    agentId: child.agentId,
                    description: child.description,
                    agentType: child.agentType,
                    messages: [],
                    status: child.status,
                    tokenIn: child.tokenIn,
                    tokenOut: child.tokenOut,
                    tokenCache: child.tokenCache,
                    tokenCacheCreate: child.tokenCacheCreate,
                    title: child.title
                )
            }
        }
    }

    // MARK: - Last sequence persistence (UserDefaults)

    private static let seqDefaultsKey = "pocketctl_last_event_seq"

    static func loadLastSeq(for sessionId: String) -> Int {
        let dict = UserDefaults.standard.dictionary(forKey: seqDefaultsKey) as? [String: Int] ?? [:]
        return dict[sessionId] ?? 0
    }

    static func saveLastSeq(_ seq: Int, for sessionId: String) {
        var dict = UserDefaults.standard.dictionary(forKey: seqDefaultsKey) as? [String: Int] ?? [:]
        dict[sessionId] = seq
        UserDefaults.standard.set(dict, forKey: seqDefaultsKey)
    }

    static func removeLastSeq(for sessionId: String) {
        var dict = UserDefaults.standard.dictionary(forKey: seqDefaultsKey) as? [String: Int] ?? [:]
        dict.removeValue(forKey: sessionId)
        UserDefaults.standard.set(dict, forKey: seqDefaultsKey)
    }

    // MARK: - Helpers

    // MARK: - Messages memory cache (preserves scroll position across navigation)

    private static var messagesCache: [String: (messages: [ChatMessage], subAgents: [String: SubAgent], msgCounter: Int)] = [:]

    static func saveToCache(_ sessionId: String, messages: [ChatMessage], subAgents: [String: SubAgent], msgCounter: Int) {
        messagesCache[sessionId] = (messages, subAgents, msgCounter)
    }

    /// 保存当前 ViewModel 的消息到内存缓存
    func persistToCache() {
        Self.messagesCache[session.sessionId] = (messages, subAgents, msgCounter)
    }

    static func clearCache(_ sessionId: String) {
        messagesCache.removeValue(forKey: sessionId)
    }

    /// Encode an Any? input to a JSON string (for rawInputJSON storage).
    nonisolated private static func encodeInput(_ input: Any?) -> String? {
        guard let input = input else { return nil }
        if let str = input as? String {
            return str
        }
        if JSONSerialization.isValidJSONObject(input),
           let data = try? JSONSerialization.data(withJSONObject: input, options: []),
           let str = String(data: data, encoding: .utf8) {
            return str
        }
        return nil
    }

    private func formatToolInput(tool: String?, input: Any?) -> String {
        guard let input else { return "" }
        if let dict = input as? [String: Any] {
            switch tool {
            case "Read", "Write", "Edit":
                if let path = dict["file_path"] as? String ?? dict["path"] as? String {
                    let line = dict["offset"] as? Int
                    if let line { return "\(path):\(line)" }
                    return path
                }
            case "Bash":
                if let cmd = dict["command"] as? String {
                    return cmd
                }
            case "Glob", "Grep":
                if let pattern = dict["pattern"] as? String ?? dict["query"] as? String {
                    let path = dict["path"] as? String ?? ""
                    return path.isEmpty ? pattern : "\(pattern) \(path)"
                }
            case "Agent":
                if let prompt = dict["prompt"] as? String {
                    return String(prompt.prefix(60))
                }
            default:
                break
            }
            // Fallback: first string value
            if let first = dict.values.compactMap({ $0 as? String }).first {
                return String(first.prefix(60))
            }
        }
        return String(describing: input).prefix(60).description
    }
}

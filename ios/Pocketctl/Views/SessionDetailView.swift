import SwiftUI

/// Tracks the top sentinel's Y offset within the scroll view (for backward pagination).
private struct ScrollTopOffsetKey: PreferenceKey {
    static let defaultValue: CGFloat = .infinity
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = min(value, nextValue())
    }
}

struct SessionDetailView: View {
    let session: Session

    @Environment(\.dismiss) private var dismiss
    @State private var viewModel: SessionDetailViewModel?
    private let apiClient: APIClient
    private let wsService: WebSocketService
    @State private var inputText = ""

    init(session: Session, wsService: WebSocketService, apiClient: APIClient) {
        self.session = session
        self.wsService = wsService
        self.apiClient = apiClient
    }
    @FocusState private var isInputFocused: Bool
    @State private var showScrollToBottom = false
    // Slash command autocomplete state
    @State private var selectedCommandIndex = 0
    @State private var popoverDismissed = false
    // "已完成" status bar — brief checkmark feedback after copying the reply
    @State private var replyCopied = false
    /// 键盘正在升起/收起的过渡期。此期间内冻结自动滚动的 withAnimation，
    /// 避免滚动动画与键盘动画争抢主线程时间，造成内容上移卡顿。
    @State private var isKeyboardAnimating = false
    /// 推送深链携带的 request_id(approval/interactive)。进入会话后定位到
    /// 对应审批卡片并滚动 + 高亮。消息未加载完时缓存 pending。
    @State private var pendingScrollRequestId: String?
    /// 当前高亮的 request_id,滚动到目标卡片后短暂高亮 2s 提示用户。
    @State private var highlightRequestId: String?
    /// 敏感内容发送确认:命中时暂存待发送内容,弹确认框。
    @State private var pendingSensitiveSend: String?
    @State private var sensitiveMatchReason: String = ""

    var body: some View {
        VStack(spacing: 0) {
            // Nav bar
            navBar

            // Messages
            if let vm = viewModel {
                ZStack(alignment: .bottomTrailing) {
                    ScrollViewReader { proxy in
                        ScrollView {
                            LazyVStack(alignment: .leading, spacing: PCSpacing.md) {
                                // Top sentinel: detect scroll-to-top for backward pagination
                                GeometryReader { geo in
                                    Color.clear.preference(
                                        key: ScrollTopOffsetKey.self,
                                        value: geo.frame(in: .named("sessionScroll")).minY
                                    )
                                }
                                .frame(height: 0)

                                // 首次加载骨架屏：replay 返回前避免整页空白，给出即时反馈。
                                // 命中内存缓存时 messages 非空，不会走到这里。
                                if vm.isLoading && vm.messages.isEmpty {
                                    loadingSkeleton
                                }

                                ForEach(Array(vm.messages.enumerated()), id: \.element.id) { index, message in
                                    messageView(message: message, index: index, vm: vm)
                                        .id(message.id)
                                }

                                // Sub-agents
                                ForEach(Array(vm.subAgents.values)) { subAgent in
                                    SubAgentCard(
                                        subAgent: subAgent,
                                        messages: Binding(
                                            get: { vm.subAgents[subAgent.agentId]?.messages ?? [] },
                                            set: { vm.subAgents[subAgent.agentId]?.messages = $0 }
                                        ),
                                        sessionActive: vm.isSessionActive
                                    )
                                    .id("subagent-\(subAgent.agentId)")
                                }

                                // "已完成" status bar — left-aligned, inside the
                                // message stream (mirrors web's turn-status-bar).
                                if vm.completedBarVisible {
                                    completedStatusBar(vm: vm)
                                        .padding(.top, PCSpacing.xs)
                                        .transition(.opacity)
                                }

                                // Bottom anchor: scroll-to-bottom target + visibility detector
                                Color.clear
                                    .frame(height: 1)
                                    .id("bottom-anchor")
                                    .onAppear { showScrollToBottom = false }
                                    .onDisappear { showScrollToBottom = true }
                            }
                            .padding(.horizontal, PCSpacing.lg)
                            .padding(.top, PCSpacing.md)
                            .padding(.bottom, PCSpacing.md)
                        }
                        .coordinateSpace(name: "sessionScroll")
                        // 让系统接管键盘交互：下拉可 interactive 地收起键盘，避免
                        // 自定义焦点逻辑与布局抖动叠加导致的卡顿。
                        .scrollDismissesKeyboard(.interactively)
                        .onPreferenceChange(ScrollTopOffsetKey.self) { offset in
                            // offset = sentinel minY in scroll space; near top when > -50
                            if offset > -50 { vm.loadOlder() }
                        }
                        .defaultScrollAnchor(.bottom)
                        .onChange(of: vm.scrollTick) { _, _ in
                            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                                // 键盘过渡期间用无动画滚动，避免与键盘动画竞争主线程。
                                if isKeyboardAnimating {
                                    proxy.scrollTo("bottom-anchor", anchor: .bottom)
                                } else {
                                    withAnimation {
                                        proxy.scrollTo("bottom-anchor", anchor: .bottom)
                                    }
                                }
                            }
                        }
                        .onChange(of: vm.messages.count) { _, _ in
                            // Auto-scroll for new messages during live streaming (not initial load)
                            if !vm.isLoading, let last = vm.messages.last {
                                if isKeyboardAnimating {
                                    proxy.scrollTo(last.id, anchor: .bottom)
                                } else {
                                    withAnimation {
                                        proxy.scrollTo(last.id, anchor: .bottom)
                                    }
                                }
                            }
                            // 推送深链兜底:消息加载完成后,定位到目标审批卡片。
                            if let reqId = pendingScrollRequestId {
                                tryScrollToRequestCard(reqId, in: vm, proxy: proxy)
                            }
                        }
                        .onChange(of: notificationRouter.pendingRequestId) { _, reqId in
                            // 热启动:会话已打开时收到审批/交互推送,立即定位。
                            if let reqId, !reqId.isEmpty, let vm = viewModel {
                                pendingScrollRequestId = reqId
                                tryScrollToRequestCard(reqId, in: vm, proxy: proxy)
                            }
                        }
                    }

                    // Scroll to bottom button — inside the messages ZStack
                    if showScrollToBottom {
                        Button {
                            withAnimation {
                                if let vm = viewModel {
                                    vm.scrollTick += 1
                                }
                                showScrollToBottom = false
                            }
                        } label: {
                            Image(systemName: "chevron.down")
                                .font(.system(size: 14, weight: .semibold))
                                .foregroundStyle(Color.pcFgSecondary)
                                .padding(10)
                                .background(.ultraThinMaterial)
                                .clipShape(Circle())
                                .overlay(
                                    Circle().stroke(Color.pcBorder, lineWidth: 0.5)
                                )
                                .shadow(color: .black.opacity(0.15), radius: 4, y: 2)
                        }
                        .padding(.trailing, PCSpacing.lg)
                        .padding(.bottom, PCSpacing.md)
                        .transition(.opacity.combined(with: .scale(scale: 0.8)))
                    }
                }
                .frame(maxHeight: .infinity)
                // 底部输入栏作为安全区的一部分承载，键盘上抬时系统对 ScrollView
                // 内容区做 content-inset 调整而非高度重算，减少 LazyVStack 重排。
                .safeAreaInset(edge: .bottom, spacing: 0) {
                    bottomBar(vm: vm)
                }
            }
        }
        .background(Color.pcBackground.ignoresSafeArea())
        .navigationBarHidden(true)
        .swipeToPop()
        // 监听键盘过渡：标记动画窗口，期间冻结自动滚动动画，抚平上移卡顿。
        .onReceive(
            NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)
        ) { _ in
            isKeyboardAnimating = true
        }
        .onReceive(
            NotificationCenter.default.publisher(for: UIResponder.keyboardDidShowNotification)
        ) { _ in
            isKeyboardAnimating = false
        }
        .onReceive(
            NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)
        ) { _ in
            isKeyboardAnimating = true
        }
        .onReceive(
            NotificationCenter.default.publisher(for: UIResponder.keyboardDidHideNotification)
        ) { _ in
            isKeyboardAnimating = false
        }
        .task {
            let vm = SessionDetailViewModel(session: session, wsService: wsService, apiClient: apiClient)
            viewModel = vm
            await vm.connect()
            // 推送深链:从审批/交互推送进入会话时,定位到对应卡片。
            if let reqId = notificationRouter.pendingRequestId, !reqId.isEmpty {
                pendingScrollRequestId = reqId
            }
        }
        .onAppear {
            if let vm = viewModel {
                vm.onReturn()
            }
        }
        .onDisappear {
            if let vm = viewModel {
                vm.persistToCache()
                vm.disconnect()
            }
            // 清理深链状态,避免下次进入其它会话时误触发。
            pendingScrollRequestId = nil
            highlightRequestId = nil
            notificationRouter.pendingRequestId = nil
            notificationRouter.pendingNotificationType = nil
        }
        // 敏感内容发送确认:命中疑似密码/密钥/token 时,要求用户二次确认。
        .alert("⚠️ 检测到敏感内容", isPresented: Binding(
            get: { pendingSensitiveSend != nil },
            set: { if !$0 { pendingSensitiveSend = nil } }
        )) {
            Button("仍然发送", role: .destructive) {
                if let text = pendingSensitiveSend {
                    viewModel?.sendMessage(text)
                    inputText = ""
                    popoverDismissed = false
                }
                pendingSensitiveSend = nil
            }
            Button("取消", role: .cancel) { pendingSensitiveSend = nil }
        } message: {
            Text("消息中包含\(sensitiveMatchReason),发送给 AI 可能导致敏感信息泄露。确认要发送吗?")
        }
    }

    // MARK: - Send with sensitive check

    /// 发送前做敏感内容检测。命中则暂存内容弹确认,否则直接发送。
    private func attemptSend(_ text: String) {
        if let match = SensitiveContentDetector.detect(text) {
            pendingSensitiveSend = text
            sensitiveMatchReason = match.reason
        } else {
            guard let vm = viewModel else { return }
            vm.sendMessage(text)
            inputText = ""
            popoverDismissed = false
        }
    }

    // MARK: - Nav bar

    private var navBar: some View {
        HStack(spacing: 8) {
            // Back
            Button { dismiss() } label: {
                HStack(spacing: 4) {
                    Image(systemName: "chevron.left")
                        .font(.system(size: 15, weight: .medium))
                    Text(session.hostDisplayName ?? "")
                        .font(PCFont.body(15))
                }
                .foregroundStyle(Color.pcAccent)
            }

            Spacer()

            // Title
            if let title = viewModel?.title ?? session.title {
                Text(title)
                    .font(PCFont.mono(12))
                    .foregroundStyle(Color.pcAccent)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }

            Spacer()

            // Status pill
            HStack(spacing: 4) {
                StatusDot(status: viewModel?.status ?? session.status, size: 6)
                Text(statusText)
                    .font(PCFont.body(12, weight: .semibold))
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
            .background(statusColor.opacity(0.15))
            .cornerRadius(PCRadius.full)

            // Model pill — reflects terminal /model switches live
            if let model = viewModel?.currentModel, !model.isEmpty {
                Text(model)
                    .font(PCFont.body(12, weight: .semibold))
                    .foregroundStyle(Color.pcAccent)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 4)
                    .background(Color.pcAccent.opacity(0.12))
                    .cornerRadius(PCRadius.full)
            }
        }
        .padding(.horizontal, PCSpacing.md)
        .padding(.vertical, PCSpacing.sm)
    }

    // MARK: - Messages

    /// 首屏加载占位：交替的 user/agent 气泡骨架，用 redacted 给出即时反馈，
    /// 避免空白等待。replay 返回后 vm.messages 非空，骨架自动消失。
    private var loadingSkeleton: some View {
        VStack(alignment: .leading, spacing: PCSpacing.md) {
            ForEach(0..<4, id: \.self) { i in
                skeletonBubble(isUser: i % 2 == 1)
            }
        }
        .padding(.top, PCSpacing.sm)
    }

    private func skeletonBubble(isUser: Bool) -> some View {
        HStack {
            if isUser { Spacer(minLength: 60) }
            VStack(alignment: .leading, spacing: 6) {
                RoundedRectangle(cornerRadius: PCRadius.sm)
                    .fill(Color.pcSurface)
                    .frame(width: isUser ? 140 : 200, height: 12)
                RoundedRectangle(cornerRadius: PCRadius.sm)
                    .fill(Color.pcSurface)
                    .frame(width: isUser ? 100 : 160, height: 12)
            }
            .padding(PCSpacing.sm)
            .background(Color.pcSurface.opacity(0.6))
            .cornerRadius(PCRadius.lg)
            .redacted(reason: .placeholder)
            if !isUser { Spacer(minLength: 60) }
        }
    }

    @ViewBuilder
    private func messageView(message: ChatMessage, index: Int, vm: SessionDetailViewModel) -> some View {
        switch message.type {
        case .agentText:
            ChatBubble(message: message)

        case .toolCall:
            if message.tool == "AskUserQuestion" {
                QuestionCard(message: message)
            } else if let subId = message.subAgentId, vm.subAgents[subId] != nil {
                // Sub-agent card is rendered separately
                EmptyView()
            } else if isDiffTool(message.tool) {
                // Edit/MultiEdit/Write → line-level diff view
                DiffCard(
                    message: message,
                    messages: Binding(
                        get: { vm.messages },
                        set: { vm.messages = $0 }
                    ),
                    messageIndex: index,
                    sessionActive: vm.isSessionActive
                )
            } else {
                ToolCallCard(
                    message: message,
                    messages: Binding(
                        get: { vm.messages },
                        set: { vm.messages = $0 }
                    ),
                    messageIndex: index,
                    sessionActive: vm.isSessionActive
                )
            }

        case .error:
            ChatBubble(message: message)

        case .commandReceipt:
            CommandReceiptCard(message: message)

        case .approvalRequest:
            ApprovalCard(message: message) { requestId, approved in
                vm.respondApproval(requestId: requestId, approved: approved)
            }
            .pushHighlight(messageId: message.requestId, activeId: highlightRequestId)

        case .interactiveChoice:
            InteractiveChoiceCard(message: message) { requestId, choice in
                vm.respondChoice(requestId: requestId, choice: choice)
            }
            .pushHighlight(messageId: message.requestId, activeId: highlightRequestId)

        default:
            // User message
            ChatBubble(message: message)
        }
    }

    // MARK: - Bottom bar (input / executing indicator)

    /// Bottom bar 承载在 `.safeAreaInset(.bottom)` 中：可发送时显示输入栏，
    /// 执行态显示进度指示器，其它情况（如已完成）返回空。原实现把这部分作为
    /// VStack 的流式子视图，键盘上抬时会触发整页高度重算 + LazyVStack 重排，
    /// 改为 safeAreaInset 后系统对内容区做 content-inset 调整，显著减少重排。
    @ViewBuilder
    private func bottomBar(vm: SessionDetailViewModel) -> some View {
        if vm.canSendMessage {
            inputBar(vm: vm)
        } else if vm.isExecuting {
            executingIndicator
        }
    }

    // MARK: - Input bar

    private func inputBar(vm: SessionDetailViewModel) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            // Slash command autocomplete popover (shown above the input)
            if showCommandPopover(vm: vm) {
                CommandPopoverView(
                    commands: filteredCommands(vm: vm),
                    selectedIndex: $selectedCommandIndex,
                    onSelect: { cmd in applyCommand(cmd) }
                )
                .padding(.horizontal, PCSpacing.lg)
                .padding(.bottom, 4)
            }

            HStack(spacing: PCSpacing.sm) {
                HStack {
                    TextField(vm.inputPlaceholder, text: $inputText, axis: .vertical)
                        .font(PCFont.body(15))
                        .foregroundStyle(Color.pcFg)
                        .lineLimit(1...5)
                        .focused($isInputFocused)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .background(Color.pcSurface)
                .cornerRadius(PCRadius.xl)
                .overlay(
                    RoundedRectangle(cornerRadius: PCRadius.xl)
                        .stroke(Color.pcBorder, lineWidth: 1)
                )

                Button {
                    attemptSend(inputText)
                } label: {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(Color.pcBackground)
                        .frame(width: 32, height: 32)
                        .background(Color.pcAccent)
                        .clipShape(Circle())
                }
                .disabled(inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            .onChange(of: inputText) { _, _ in
                selectedCommandIndex = 0
                popoverDismissed = false
            }
        }
        .padding(.horizontal, PCSpacing.lg)
        .padding(.vertical, PCSpacing.sm)
        .background(Color.pcBackground)
        .overlay(
            Rectangle()
                .fill(Color.pcBorder)
                .frame(height: 1),
            alignment: .top
        )
    }

    // MARK: - Slash command autocomplete helpers

    /// Commands matching the current input prefix (e.g. "/co" → compact/cost).
    private func filteredCommands(vm: SessionDetailViewModel) -> [CommandItem] {
        guard inputText.hasPrefix("/") else { return [] }
        let prefix = inputText.dropFirst().lowercased()
        let pool = vm.commands
        if prefix.isEmpty { return Array(pool.prefix(50)) }
        return Array(pool.filter { $0.name.lowercased().hasPrefix(prefix) }.prefix(50))
    }

    /// Whether the autocomplete popover should be visible.
    private func showCommandPopover(vm: SessionDetailViewModel) -> Bool {
        !popoverDismissed && !filteredCommands(vm: vm).isEmpty
    }

    /// Insert "/<name> " into the input and keep focus.
    private func applyCommand(_ cmd: CommandItem) {
        inputText = "/" + cmd.name + " "
        popoverDismissed = true
        isInputFocused = true
    }

    // MARK: - Executing indicator

    private var executingIndicator: some View {
        HStack(spacing: 8) {
            ProgressView()
                .tint(.pcAccent)
                .scaleEffect(0.8)

            Text("Agent 执行中...")
                .font(PCFont.body(14))
                .foregroundStyle(Color.pcFgSecondary)

            if let elapsed = viewModel?.executionElapsedString {
                Text("· \(elapsed)")
                    .font(PCFont.mono(14))
                    .foregroundStyle(Color.pcFgSecondary)
                    .monospacedDigit()
                    // Re-evaluate every tick while executing.
                    .id(viewModel?.executionTick ?? 0)
            }

            Spacer()

            // Context 使用量（输入侧总 token），右对齐，与计时同一行。
            // 运行中显示「上一轮」的 context 用量作为参考。
            if let ctx = viewModel?.contextUsageTokens {
                Text("ctx \(viewModel?.fmtTokens(ctx) ?? "")")
                    .font(PCFont.mono(12))
                    .foregroundStyle(Color.pcFgTertiary)
                    .monospacedDigit()
            }
        }
        .padding(.horizontal, PCSpacing.lg)
        .padding(.vertical, PCSpacing.sm)
        .background(Color.pcBackground)
        .overlay(
            Rectangle()
                .fill(Color.pcBorder)
                .frame(height: 1),
            alignment: .top
        )
    }

    // MARK: - "已完成" status bar

    /// Mirrors the web client's `turn-status-bar` (done state): a left-aligned
    /// row with a checkmark, "已完成", the frozen turn duration, output token
    /// count, and icon-only copy / retry buttons.
    @ViewBuilder
    private func completedStatusBar(vm: SessionDetailViewModel) -> some View {
        HStack(spacing: 4) {
            Image(systemName: "checkmark")
                .font(.system(size: 10, weight: .bold))
                .foregroundStyle(Color.pcAccent)

            Text("已完成")
                .font(PCFont.body(12, weight: .medium))
                .foregroundStyle(Color.pcFgSecondary)

            if let duration = vm.lastTurnDuration {
                Text("· \(duration)")
                    .font(PCFont.mono(12))
                    .foregroundStyle(Color.pcFgTertiary)
                    .monospacedDigit()
            }

            if let usage = vm.lastAgentUsage, usage.outputTokens > 0 {
                Text("· \(vm.fmtTokens(usage.outputTokens)) out")
                    .font(PCFont.mono(12))
                    .foregroundStyle(Color.pcFgTertiary)
                    .monospacedDigit()
            }

            // Context 使用量（输入侧总 token），紧随输出 token 量右侧。
            if let ctx = vm.contextUsageTokens {
                Text("· \(vm.fmtTokens(ctx)) ctx")
                    .font(PCFont.mono(12))
                    .foregroundStyle(Color.pcFgTertiary)
                    .monospacedDigit()
            }

            Spacer(minLength: 4)

            // Copy last reply — icon only
            Button {
                if let text = vm.copyLastReply() {
                    UIPasteboard.general.string = text
                    replyCopied = true
                    DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                        replyCopied = false
                    }
                }
            } label: {
                Image(systemName: replyCopied ? "checkmark" : "doc.on.doc")
                    .font(.system(size: 13))
                    .foregroundStyle(replyCopied ? Color.pcAccent : Color.pcFgTertiary)
            }
            .buttonStyle(.plain)
            .disabled(!vm.hasLastAgentReply)

            // Retry last prompt — icon only, gated by canRetry
            if vm.canRetry && vm.hasLastUserPrompt {
                Button {
                    vm.retryLastPrompt()
                } label: {
                    Image(systemName: "arrow.clockwise")
                        .font(.system(size: 13))
                        .foregroundStyle(Color.pcFgTertiary)
                }
                .buttonStyle(.plain)
            }
        }
    }

    // MARK: - Helpers

    private var statusText: String {
        let s = viewModel?.status ?? session.status
        switch s {
        case "running": return "运行中"
        case "busy": return "运行中"
        case "waiting_approval": return "等待审批"
        case "idle": return "空闲"
        case "completed": return "已完成"
        case "error": return "出错"
        case "killed": return "已终止"
        case "exited": return "已退出"
        case "disconnected": return "已断开"
        default: return s
        }
    }

    private var statusColor: Color {
        let s = viewModel?.status ?? session.status
        switch s {
        case "running", "busy": return .pcSuccess
        case "idle": return .pcIdle
        case "completed": return .pcAccent
        case "error": return .pcError
        case "killed", "exited": return .pcWarning
        case "disconnected": return .pcFgTertiary
        default: return .pcFgSecondary
        }
    }

    // MARK: - Push deep-link scroll

    /// 在消息列表里查找匹配 request_id 的卡片,滚动到该位置并短暂高亮。
    /// 消息尚未加载(approval 还没到)时静默返回,由 messages.count 变化兜底重试。
    private func tryScrollToRequestCard(_ requestId: String, in vm: SessionDetailViewModel, proxy: ScrollViewProxy) {
        guard let target = vm.messages.first(where: { $0.requestId == requestId }) else {
            return
        }
        pendingScrollRequestId = nil
        withAnimation(.easeInOut(duration: 0.35)) {
            proxy.scrollTo(target.id, anchor: .center)
        }
        // 触发高亮,2s 后淡出。
        highlightRequestId = requestId
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
            if highlightRequestId == requestId {
                withAnimation(.easeOut(duration: 0.4)) {
                    highlightRequestId = nil
                }
            }
        }
    }
}

// MARK: - Push deep-link highlight modifier

/// 推送深链命中卡片时短暂高亮(强调色描边),2s 后由调用方清空 activeId 淡出。
private struct PushHighlight: ViewModifier {
    let messageId: String?
    let activeId: String?

    func body(content: Content) -> some View {
        if let mid = messageId, let aid = activeId, mid == aid {
            content
                .padding(.vertical, 2)
                .background(
                    RoundedRectangle(cornerRadius: PCRadius.lg)
                        .stroke(Color.pcAccent.opacity(0.7), lineWidth: 1.5)
                )
        } else {
            content
        }
    }
}

extension View {
    /// 推送深链高亮:当 messageId 命中 activeId 时给卡片加强调色描边。
    fileprivate func pushHighlight(messageId: String?, activeId: String?) -> some View {
        modifier(PushHighlight(messageId: messageId, activeId: activeId))
    }
}

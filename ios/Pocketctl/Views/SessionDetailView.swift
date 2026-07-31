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
    private let focusedSubAgent: SubAgent?

    @Environment(\.dismiss) private var dismiss
    @State private var viewModel: SessionDetailViewModel?
    private let apiClient: APIClient
    private let wsService: WebSocketService
    @State private var inputText = ""

    init(session: Session, wsService: WebSocketService, apiClient: APIClient, focusedSubAgent: SubAgent? = nil) {
        self.session = session
        self.wsService = wsService
        self.apiClient = apiClient
        self.focusedSubAgent = focusedSubAgent
    }
    @FocusState private var isInputFocused: Bool
    @State private var showScrollToBottom = false
    // Slash command autocomplete state
    @State private var selectedCommandIndex = 0
    @State private var popoverDismissed = false
    @State private var showLocalHelp = false
    // "已完成" status bar — brief checkmark feedback after copying the reply
    @State private var replyCopied = false
    /// 键盘正在升起/收起的过渡期。此期间内冻结自动滚动的 withAnimation，
    /// 避免滚动动画与键盘动画争抢主线程时间，造成内容上移卡顿。
    @State private var isKeyboardAnimating = false
    @State private var isKeyboardVisible = false
    /// 推送深链携带的 request_id(approval/interactive)。进入会话后定位到
    /// 对应审批卡片并滚动 + 高亮。消息未加载完时缓存 pending。
    @State private var pendingScrollRequestId: String?
    /// 当前高亮的 request_id,滚动到目标卡片后短暂高亮 2s 提示用户。
    @State private var highlightRequestId: String?
    /// 敏感内容发送确认:命中时暂存待发送内容,弹确认框。
    @State private var pendingSensitiveSend: String?
    @State private var sensitiveMatchReason: String = ""
    @State private var showPermissionPanel = false
    @State private var dangerousPermission: AgentPermissionConfig?
    @State private var showSubagentList = false

    var body: some View {
        VStack(spacing: 0) {
            // Nav bar
            navBar

            // Messages
            if let vm = viewModel {
                ZStack(alignment: .bottom) {
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

                                if vm.isLegacyOpenCodeSession {
                                    Label(
                                        "此会话由启用 Pocketctl 前的终端进程运行。请退出该进程后，用 opencode -c 重新进入，即可在终端和远端共同操作。",
                                        systemImage: "info.circle"
                                    )
                                    .font(PCFont.body(12))
                                    .foregroundStyle(Color.pcFgSecondary)
                                    .padding(PCSpacing.sm)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .background(Color.pcSurface)
                                    .clipShape(RoundedRectangle(cornerRadius: PCRadius.md))
                                    .overlay(RoundedRectangle(cornerRadius: PCRadius.md).stroke(Color.pcBorder))
                                }

                                // 首次加载骨架屏：replay 返回前避免整页空白，给出即时反馈。
                                // 命中内存缓存时 messages 非空，不会走到这里。
                                if vm.isLoading && vm.messages.isEmpty {
                                    loadingSkeleton
                                }

                                if let focusedSubAgent {
                                    let messages = focusedSubagentMessages(vm: vm)
                                    if !vm.isLoading && messages.isEmpty {
                                        subagentEmptyState(focusedSubAgent)
                                    }
                                    ForEach(Array(messages.enumerated()), id: \.element.id) { index, message in
                                        subagentMessageView(message: message, index: index, vm: vm)
                                            .id(message.id)
                                    }
                                } else {
                                    ForEach(Array(vm.messages.enumerated()), id: \.element.id) { index, message in
                                        messageView(message: message, index: index, vm: vm)
                                            .id(message.id)
                                    }

                                    // Sub-agents
                                    let subAgents = Array(vm.subAgents.values)
                                    ForEach(Array(subAgents.prefix(3))) { subAgent in
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

                                    if subAgents.count > 3 {
                                        Button {
                                            showSubagentList = true
                                        } label: {
                                            HStack(spacing: PCSpacing.xs) {
                                                Text("查看全部")
                                                Text("\(subAgents.count)")
                                                    .font(PCFont.mono(12, weight: .semibold))
                                                Spacer()
                                                Image(systemName: "chevron.right")
                                                    .font(.system(size: 11, weight: .semibold))
                                            }
                                            .font(PCFont.body(13, weight: .semibold))
                                            .foregroundStyle(Color.pcSubAgent)
                                            .padding(.horizontal, PCSpacing.md)
                                            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                                            .background(Color.pcSubAgentBg.opacity(0.65))
                                            .clipShape(RoundedRectangle(cornerRadius: PCRadius.md))
                                            .overlay(
                                                RoundedRectangle(cornerRadius: PCRadius.md)
                                                    .stroke(Color.pcSubAgent.opacity(0.2), lineWidth: 1)
                                            )
                                        }
                                        .buttonStyle(.plain)
                                    }
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
                        .simultaneousGesture(TapGesture().onEnded {
                            dismissKeyboard()
                        })
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
                        .padding(.bottom, PCSpacing.md)
                        .transition(.opacity.combined(with: .scale(scale: 0.8)))
                    }
                }
                .frame(maxHeight: .infinity)
                // 底部输入栏作为安全区的一部分承载，键盘上抬时系统对 ScrollView
                // 内容区做 content-inset 调整而非高度重算，减少 LazyVStack 重排。
                .safeAreaInset(edge: .bottom, spacing: -PCSpacing.md) {
                    bottomBar(vm: vm)
                }
            }
        }
        .background(Color.pcBackground.ignoresSafeArea())
        .navigationBarHidden(true)
        .navigationDestination(isPresented: $showSubagentList) {
            SubAgentListView(
                parentSession: session,
                wsService: wsService,
                apiClient: apiClient,
                subAgents: viewModel.map { Array($0.subAgents.values) } ?? []
            )
        }
        .swipeToPop {
            guard KeyboardBackNavigationPolicy.shouldDismissKeyboard(
                keyboardVisible: isKeyboardVisible,
                inputFocused: isInputFocused
            ) else { return false }
            dismissKeyboard()
            return true
        }
        // 监听键盘过渡：标记动画窗口，期间冻结自动滚动动画，抚平上移卡顿。
        .onReceive(
            NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)
        ) { _ in
            isKeyboardAnimating = true
            isKeyboardVisible = true
        }
        .onReceive(
            NotificationCenter.default.publisher(for: UIResponder.keyboardDidShowNotification)
        ) { _ in
            isKeyboardAnimating = false
            isKeyboardVisible = true
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
            isKeyboardVisible = false
        }
        .task {
            let vm = SessionDetailViewModel(session: session, wsService: wsService, apiClient: apiClient, focusedSubAgent: focusedSubAgent)
            viewModel = vm
            await vm.connect()
            // 推送深链:从审批/交互推送进入会话时,定位到对应卡片。
            if let reqId = notificationRouter.pendingRequestId, !reqId.isEmpty {
                pendingScrollRequestId = reqId
            }
        }
        .onAppear {
            KeyboardWarmup.prewarm(.default)
            if let vm = viewModel {
                vm.onReturn()
            }
        }
        .onChange(of: viewModel?.shouldShowLocalHelp) { _, shouldShow in
            if shouldShow == true {
                showLocalHelp = true
                viewModel?.shouldShowLocalHelp = false
            }
        }
        .sheet(isPresented: $showLocalHelp) {
            localCommandHelpView
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
                if let text = pendingSensitiveSend,
                   viewModel?.sendMessage(text) == true {
                    inputText = ""
                    popoverDismissed = false
                }
                pendingSensitiveSend = nil
            }
            Button("取消", role: .cancel) { pendingSensitiveSend = nil }
        } message: {
            Text("消息中包含\(sensitiveMatchReason),发送给 AI 可能导致敏感信息泄露。确认要发送吗?")
        }
        .alert("消息未发送", isPresented: Binding(
            get: { viewModel?.sendFailureMessage != nil },
            set: { if !$0 { viewModel?.sendFailureMessage = nil } }
        )) {
            Button("知道了", role: .cancel) {
                viewModel?.sendFailureMessage = nil
            }
        } message: {
            Text(viewModel?.sendFailureMessage ?? "")
        }
        .alert("允许完全访问？", isPresented: Binding(get: { dangerousPermission != nil }, set: { if !$0 { dangerousPermission = nil } })) {
            Button("确认", role: .destructive) {
                if let permission = dangerousPermission { viewModel?.requestPermissionChange(permission) }
                dangerousPermission = nil
                showPermissionPanel = false
            }
            Button("取消", role: .cancel) { dangerousPermission = nil }
        } message: { Text("此权限可访问工作区外文件或整个计算机，请确认你了解风险。") }
    }

    private func dismissKeyboard() {
        guard isKeyboardVisible || isInputFocused else { return }
        isInputFocused = false
        KeyboardDismiss.call()
    }

    // MARK: - Send with sensitive check

    /// 发送前做敏感内容检测。命中则暂存内容弹确认,否则直接发送。
    private func attemptSend(_ text: String) {
        if let match = SensitiveContentDetector.detect(text) {
            pendingSensitiveSend = text
            sensitiveMatchReason = match.reason
        } else {
            guard let vm = viewModel else { return }
            if vm.sendMessage(text) {
                inputText = ""
                popoverDismissed = false
            }
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
                    Text(viewModel?.hostDisplayName ?? session.hostDisplayName ?? "")
                        .font(PCFont.body(15))
                }
                .foregroundStyle(Color.pcAccent)
            }

            Spacer()

            // Title
            if let title = focusedSubAgent?.title ?? viewModel?.title ?? session.title {
                Text(title)
                    .font(PCFont.mono(12))
                    .foregroundStyle(Color.pcAccent)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }

            Spacer()

            // Status pill
            HStack(spacing: 4) {
                StatusDot(status: focusedSubAgent?.status ?? viewModel?.status ?? session.status, size: 6)
                Text(statusText)
                    .font(PCFont.body(12, weight: .semibold))
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
            .background(statusColor.opacity(0.15))
            .cornerRadius(PCRadius.full)

        }
        .padding(.horizontal, PCSpacing.md)
        .padding(.top, PCSpacing.xs)
        .padding(.bottom, 0)
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

        case .reasoning:
            DisclosureGroup {
                Text(message.content)
                    .font(.system(size: 13))
                    .foregroundStyle(Color.pcFgSecondary)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, PCSpacing.xs)
            } label: {
                Label("思考过程", systemImage: "brain.head.profile")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Color.pcFgTertiary)
            }
            .padding(PCSpacing.sm)
            .background(Color.pcSurface)
            .overlay(
                RoundedRectangle(cornerRadius: PCRadius.md)
                    .stroke(Color.pcBorder, lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: PCRadius.md))

        case .openCodeFile, .openCodePatch, .openCodeTodo, .openCodeSubtask, .openCodeAgent:
            OpenCodePartCard(message: message)

        case .retryNotice:
            Label {
                Text("正在重试请求（第 \(max(message.attempt, 1)) 次）" + (message.content.isEmpty ? "" : " · \(message.content)"))
            } icon: {
                Image(systemName: "arrow.clockwise")
            }
            .font(.system(size: 12))
            .foregroundStyle(Color.pcFgTertiary)
            .padding(.vertical, PCSpacing.xs)

        case .compactionNotice:
            Label(
                (message.automatic ? "已自动压缩上下文" : "上下文已压缩") + (message.overflow ? " · 已达到上下文限制" : ""),
                systemImage: "rectangle.compress.vertical"
            )
            .font(.system(size: 12))
            .foregroundStyle(Color.pcFgTertiary)
            .padding(.vertical, PCSpacing.xs)

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
            ApprovalCard(
                message: message,
                supportsActions: vm.sessionAgentCapabilities.contains("permission_actions") || !message.availableDecisions.isEmpty,
                disabled: vm.interactionControlsDisabled
            ) { requestId, action in
                vm.respondApproval(requestId: requestId, action: action)
            }
            .pushHighlight(messageId: message.requestId, activeId: highlightRequestId)

        case .openCodeQuestion:
            OpenCodeQuestionCard(
                message: message,
                disabled: vm.interactionControlsDisabled,
                onSubmit: { requestId, answers in vm.respondQuestion(requestId: requestId, answers: answers) },
                onReject: { requestId in vm.rejectQuestion(requestId: requestId) }
            )
            .pushHighlight(messageId: message.requestId, activeId: highlightRequestId)

        case .mcpElicitation:
            McpElicitationCard(message: message, disabled: vm.interactionControlsDisabled) { requestId, action, content in
                vm.respondMcpElicitation(requestId: requestId, action: action, content: content)
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

    @ViewBuilder
    private func subagentMessageView(message: ChatMessage, index: Int, vm: SessionDetailViewModel) -> some View {
        switch message.type {
        case .agentText, .error:
            ChatBubble(message: message)

        case .toolCall:
            if isDiffTool(message.tool) {
                DiffCard(
                    message: message,
                    messages: Binding(
                        get: { focusedSubagentMessages(vm: vm) },
                        set: { updateFocusedSubagentMessages($0, vm: vm) }
                    ),
                    messageIndex: index,
                    sessionActive: vm.isSessionActive
                )
            } else {
                ToolCallCard(
                    message: message,
                    messages: Binding(
                        get: { focusedSubagentMessages(vm: vm) },
                        set: { updateFocusedSubagentMessages($0, vm: vm) }
                    ),
                    messageIndex: index,
                    sessionActive: vm.isSessionActive
                )
            }

        case .commandReceipt:
            CommandReceiptCard(message: message)

        default:
            ChatBubble(message: message)
        }
    }

    private func focusedSubagentMessages(vm: SessionDetailViewModel) -> [ChatMessage] {
        guard let focusedSubAgent else { return [] }
        return vm.subAgents[focusedSubAgent.agentId]?.messages ?? focusedSubAgent.messages
    }

    private func updateFocusedSubagentMessages(_ messages: [ChatMessage], vm: SessionDetailViewModel) {
        guard let agentId = focusedSubAgent?.agentId,
              var agent = vm.subAgents[agentId] else { return }
        agent.messages = messages
        vm.subAgents[agentId] = agent
    }

    private func subagentEmptyState(_ subAgent: SubAgent) -> some View {
        VStack(spacing: 8) {
            Image(systemName: "scope")
                .font(.system(size: 24))
                .foregroundStyle(Color.pcSubAgent)
            Text("暂无子智能体消息")
                .font(PCFont.body(15, weight: .medium))
                .foregroundStyle(Color.pcFg)
            Text(subAgent.title ?? displayAgentName(subAgent.agentType))
                .font(PCFont.body(12))
                .foregroundStyle(Color.pcFgTertiary)
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 120)
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

    // MARK: - Bottom bar (input / executing indicator)

    /// Bottom bar 承载在 `.safeAreaInset(.bottom)` 中：可发送时显示输入栏，
    /// 执行态显示进度指示器；可恢复的 daemon 完成态仍显示输入栏，其它情况返回空。原实现把这部分作为
    /// VStack 的流式子视图，键盘上抬时会触发整页高度重算 + LazyVStack 重排，
    /// 改为 safeAreaInset 后系统对内容区做 content-inset 调整，显著减少重排。
    @ViewBuilder
    private func bottomBar(vm: SessionDetailViewModel) -> some View {
        if vm.isSubagent || focusedSubAgent != nil {
            HStack(spacing: 6) {
                Image(systemName: "scope")
                    .font(.system(size: 12))
                Text("子智能体会话 · 只读")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 8)
            .background(Color.pcBackground)
            .overlay(
                Rectangle()
                    .fill(Color.pcBorder)
                    .frame(height: 1),
                alignment: .top
            )
        } else if vm.isWorking && vm.composerState != .temporarilyUnavailable {
            executingIndicator
        } else if vm.composerState.isVisible {
            inputBar(vm: vm)
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

            VStack(spacing: 0) {
                TextField(vm.inputPlaceholder, text: $inputText, axis: .vertical)
                    .font(PCFont.body(15)).foregroundStyle(Color.pcFg)
                    .lineLimit(2...6).focused($isInputFocused)
                    .disabled(!vm.composerState.isEditable)
                    .padding(.horizontal, 14).padding(.top, 12).padding(.bottom, 4)
                composerToolbar(vm: vm)
            }
            .background(Color.pcSurface)
            .clipShape(RoundedRectangle(cornerRadius: PCRadius.xl))
            .overlay(RoundedRectangle(cornerRadius: PCRadius.xl).stroke(isInputFocused ? Color.pcAccent : Color.pcBorder, lineWidth: isInputFocused ? 1.5 : 1))
            .onChange(of: inputText) { _, _ in
                selectedCommandIndex = 0
                popoverDismissed = false
            }
        }
        .padding(.horizontal, PCSpacing.lg)
        .padding(.top, PCSpacing.xs)
        .padding(.bottom, 0)
        .background(Color.pcBackground)
    }

    private func composerToolbar(vm: SessionDetailViewModel) -> some View {
        HStack(spacing: 8) {
            Button {
                dismissKeyboard()
                showPermissionPanel = true
            } label: {
                Group { if vm.pendingPermission != nil { ProgressView() } else { Image(systemName: vm.currentPermission?.preset == .custom ? "gearshape" : "shield") } }
                    .frame(width: 44, height: 44)
            }
            .buttonStyle(.plain)
            .contentShape(Rectangle())
            .accessibilityLabel("权限配置")
            .popover(isPresented: $showPermissionPanel) {
                permissionPanel(vm: vm)
                    .padding(PCSpacing.sm)
                    .presentationCompactAdaptation(.popover)
            }
            if vm.showsSessionAgentPicker {
                SessionAgentPicker(
                    agents: vm.sessionAgents,
                    currentAgent: vm.currentSessionAgent,
                    loading: vm.sessionAgentsLoading,
                    error: vm.sessionAgentError,
                    disabled: !vm.canSwitchSessionAgent,
                    submitting: vm.sessionAgentSubmitting,
                    onSelect: { vm.switchSessionAgent(to: $0) },
                    onRetry: { vm.requestSessionAgents() }
                )
            }
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) { composerModel(vm); composerEffort(vm, full: true) }
                HStack(spacing: 6) { composerModel(vm); composerEffort(vm, full: false) }
                composerModel(vm)
            }
            Spacer(minLength: 0)
            Button { attemptSend(inputText) } label: {
                Image(systemName: "arrow.up").font(.system(size: 16, weight: .semibold)).foregroundStyle(Color.pcBackground)
                    .frame(width: 32, height: 32).background(Color.pcAccent).clipShape(Circle())
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }.disabled(!vm.canSendMessage || inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty).accessibilityLabel("发送")
        }.padding(.horizontal, 6).frame(height: 44)
    }

    private func composerModel(_ vm: SessionDetailViewModel) -> some View {
        Text(vm.currentModel ?? "默认模型").font(PCFont.body(12, weight: .semibold)).foregroundStyle(Color.pcAccent).lineLimit(1).truncationMode(.middle)
    }

    private func composerEffort(_ vm: SessionDetailViewModel, full: Bool) -> some View {
        Text(full ? "推理 · \(vm.effortDisplayLabel ?? "—")" : (vm.effortDisplayLabel ?? "—"))
            .font(PCFont.body(12, weight: .semibold)).foregroundStyle(Color.pcWarning).lineLimit(1)
    }

    private func permissionPanel(vm: SessionDetailViewModel) -> some View {
        VStack(spacing: 0) {
            if let reason = vm.permissionChangeUnavailableReason {
                Text(reason)
                    .font(PCFont.body(13))
                    .foregroundStyle(Color.pcFgSecondary)
                    .padding(PCSpacing.lg)
            } else if session.agentType == "claude-code" {
                ForEach(ClaudePermissionMode.allCases.filter { vm.permissionMutableModes.contains($0.rawValue) }) { mode in
                    permissionButton(vm, config: AgentPermissionConfig(agent: "claude-code", mode: mode), icon: mode.icon, title: mode.title, description: mode.description, dangerous: mode == .bypassPermissions)
                }
            } else if session.agentType == "codex" {
                ForEach(CodexPermissionPreset.allCases) { preset in
                    permissionButton(vm, config: AgentPermissionConfig(agent: "codex", preset: preset, dangerouslyBypass: preset == .fullAccess), icon: preset.icon, title: preset.title, description: preset.description, dangerous: preset == .fullAccess, disabled: !preset.supported)
                }
            }
            if let notice = vm.lastPermissionError ?? vm.permissionEffectNotice { Text(notice).font(PCFont.body(12)).foregroundStyle(Color.pcWarning).padding(10) }
        }
        .frame(maxWidth: 360).background(.ultraThinMaterial).clipShape(RoundedRectangle(cornerRadius: 22))
        .overlay(RoundedRectangle(cornerRadius: 22).stroke(Color.pcBorder)).shadow(color: .black.opacity(0.2), radius: 16, y: 6)
    }

    private func permissionButton(_ vm: SessionDetailViewModel, config: AgentPermissionConfig, icon: String, title: String, description: String, dangerous: Bool, disabled: Bool = false) -> some View {
        Button {
            if dangerous { dangerousPermission = config } else { vm.requestPermissionChange(config); showPermissionPanel = false }
        } label: { PermissionOptionRow(icon: icon, title: title, description: description, selected: vm.currentPermission == config, disabled: disabled) }
            .buttonStyle(.plain).disabled(disabled)
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

    @ViewBuilder
    private var localCommandHelpView: some View {
        NavigationView {
            List {
                Section("Pocketctl 本地命令") {
                    ForEach(CommandItem.localCommands) { cmd in
                        VStack(alignment: .leading, spacing: 4) {
                            HStack(spacing: 6) {
                                Text("/\(cmd.name)")
                                    .font(PCFont.mono(15, weight: .semibold))
                                    .foregroundStyle(Color.pcAccent)
                                if let hint = cmd.argHint, !hint.isEmpty {
                                    Text(hint)
                                        .font(PCFont.body(12))
                                        .foregroundStyle(Color.pcFgTertiary)
                                }
                            }
                            if let desc = cmd.description, !desc.isEmpty {
                                Text(desc)
                                    .font(PCFont.body(13))
                                    .foregroundStyle(Color.pcFgSecondary)
                            }
                        }
                        .padding(.vertical, 2)
                    }
                }
            }
            .navigationTitle("命令说明")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("完成") {
                        showLocalHelp = false
                    }
                }
            }
        }
    }

    /// Whether the autocomplete popover should be visible.
    private func showCommandPopover(vm: SessionDetailViewModel) -> Bool {
        !popoverDismissed && !filteredCommands(vm: vm).isEmpty
    }

    /// Insert "/<name> " into the input and keep focus.
    private func applyCommand(_ cmd: CommandItem) {
        inputText = "/" + cmd.name + " "
        popoverDismissed = true
        KeyboardWarmup.prewarm(.default)
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
        let s = focusedSubAgent?.status ?? viewModel?.status ?? session.status
        switch s {
        case "running": return "运行中"
        case "busy": return "运行中"
        case "retry": return "重试中"
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
        let s = focusedSubAgent?.status ?? viewModel?.status ?? session.status
        switch s {
        case "running", "busy", "retry": return .pcSuccess
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

// MARK: - OpenCode structured Parts

private struct OpenCodePartCard: View {
    let message: ChatMessage

    var body: some View {
        VStack(alignment: .leading, spacing: PCSpacing.sm) {
            HStack(alignment: .center, spacing: PCSpacing.sm) {
                Image(systemName: icon)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Color.pcAccent)
                    .frame(width: 24, height: 24)
                    .background(Color.pcAccent.opacity(0.12))
                    .clipShape(RoundedRectangle(cornerRadius: PCRadius.sm))

                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(Color.pcFg)
                    if !subtitle.isEmpty {
                        Text(subtitle)
                            .font(.system(size: 11))
                            .foregroundStyle(Color.pcFgTertiary)
                    }
                }
            }

            content
        }
        .padding(PCSpacing.sm)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.pcSurface)
        .overlay(
            RoundedRectangle(cornerRadius: PCRadius.md)
                .stroke(Color.pcBorder, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: PCRadius.md))
    }

    @ViewBuilder
    private var content: some View {
        switch message.type {
        case .openCodeFile:
            if !message.url.isEmpty { codeBlock(message.url) }
            if !message.partSource.isEmpty { codeBlock(message.partSource) }

        case .openCodePatch:
            ForEach(message.files, id: \.self) { file in
                HStack(alignment: .firstTextBaseline, spacing: PCSpacing.xs) {
                    Text("↳").foregroundStyle(Color.pcFgTertiary)
                    Text(file)
                        .font(PCFont.mono(11))
                        .foregroundStyle(Color.pcFgSecondary)
                        .textSelection(.enabled)
                }
            }
            if !message.patchHash.isEmpty { codeBlock(message.patchHash) }

        case .openCodeTodo:
            if message.todos.isEmpty {
                Text("任务清单已清空")
                    .font(.system(size: 12))
                    .foregroundStyle(Color.pcFgTertiary)
            } else {
                ForEach(Array(message.todos.enumerated()), id: \.offset) { _, todo in
                    HStack(alignment: .firstTextBaseline, spacing: PCSpacing.sm) {
                        Text(todoMark(todo.status))
                            .font(.system(size: 12, weight: .bold))
                            .foregroundStyle(todoColor(todo.status))
                            .frame(width: 14)
                        Text(todo.content)
                            .font(.system(size: 12))
                            .foregroundStyle(Color.pcFgSecondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        if !todo.priority.isEmpty {
                            Text(todo.priority)
                                .font(.system(size: 9, weight: .medium))
                                .foregroundStyle(priorityColor(todo.priority))
                                .padding(.horizontal, 5)
                                .padding(.vertical, 2)
                                .background(Color.pcHoverInput)
                                .clipShape(Capsule())
                        }
                    }
                }
            }

        case .openCodeSubtask:
            if !message.prompt.isEmpty {
                Text(message.prompt)
                    .font(.system(size: 12))
                    .foregroundStyle(Color.pcFgSecondary)
                    .textSelection(.enabled)
            }
            if !message.partCommand.isEmpty { codeBlock(message.partCommand) }

        case .openCodeAgent:
            if !message.partSource.isEmpty { codeBlock(message.partSource) }

        default:
            EmptyView()
        }
    }

    private var icon: String {
        switch message.type {
        case .openCodeFile: return "doc"
        case .openCodePatch: return "plusminus"
        case .openCodeTodo: return "checklist"
        case .openCodeSubtask: return "point.3.connected.trianglepath.dotted"
        case .openCodeAgent: return "at"
        default: return "diamond"
        }
    }

    private var title: String {
        switch message.type {
        case .openCodeFile: return message.filename.isEmpty ? "文件" : message.filename
        case .openCodePatch: return "变更文件（\(message.files.count)）"
        case .openCodeTodo: return "任务清单（\(message.todos.count)）"
        case .openCodeSubtask: return message.partDescription.isEmpty ? "子任务" : message.partDescription
        case .openCodeAgent: return message.profileName.isEmpty ? "Agent" : message.profileName
        default: return "OpenCode"
        }
    }

    private var subtitle: String {
        switch message.type {
        case .openCodeFile:
            return message.mime
        case .openCodeSubtask:
            return [message.partAgent, message.partModel].filter { !$0.isEmpty }.joined(separator: " · ")
        default:
            return ""
        }
    }

    private func codeBlock(_ text: String) -> some View {
        Text(text)
            .font(PCFont.mono(10))
            .foregroundStyle(Color.pcFgTertiary)
            .textSelection(.enabled)
            .padding(PCSpacing.xs)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.pcBackground)
            .clipShape(RoundedRectangle(cornerRadius: PCRadius.sm))
    }

    private func todoMark(_ status: String) -> String {
        switch status {
        case "completed": return "✓"
        case "in_progress": return "•"
        case "cancelled": return "×"
        default: return "○"
        }
    }

    private func todoColor(_ status: String) -> Color {
        switch status {
        case "completed": return .pcSuccess
        case "in_progress": return .pcAccent
        case "cancelled": return .pcError
        default: return .pcFgTertiary
        }
    }

    private func priorityColor(_ priority: String) -> Color {
        switch priority {
        case "high": return .pcError
        case "medium": return .pcWarning
        default: return .pcFgTertiary
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

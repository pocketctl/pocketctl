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
    private let apiClient = APIClient()
    private let wsService = WebSocketService()
    @State private var inputText = ""
    @FocusState private var isInputFocused: Bool
    @State private var showScrollToBottom = false
    // Slash command autocomplete state
    @State private var selectedCommandIndex = 0
    @State private var popoverDismissed = false

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
                        .onPreferenceChange(ScrollTopOffsetKey.self) { offset in
                            // offset = sentinel minY in scroll space; near top when > -50
                            if offset > -50 { vm.loadOlder() }
                        }
                        .defaultScrollAnchor(.bottom)
                        .onChange(of: vm.scrollTick) { _, _ in
                            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                                withAnimation {
                                    proxy.scrollTo("bottom-anchor", anchor: .bottom)
                                }
                            }
                        }
                        .onChange(of: vm.messages.count) { _, _ in
                            // Auto-scroll for new messages during live streaming (not initial load)
                            if !vm.isLoading, let last = vm.messages.last {
                                withAnimation {
                                    proxy.scrollTo(last.id, anchor: .bottom)
                                }
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
            }

            // Bottom bar: input or status indicator — in flow layout, not overlay
            if let vm = viewModel {
                if vm.canSendMessage {
                    inputBar(vm: vm)
                } else if vm.isExecuting {
                    executingIndicator
                }
            }
        }
        .background(Color.pcBackground.ignoresSafeArea())
        .navigationBarHidden(true)
        .task {
            let vm = SessionDetailViewModel(session: session, wsService: wsService, apiClient: apiClient)
            viewModel = vm
            await vm.connect()
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

        case .interactiveChoice:
            InteractiveChoiceCard(message: message) { requestId, choice in
                vm.respondChoice(requestId: requestId, choice: choice)
            }

        default:
            // User message
            ChatBubble(message: message)
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
                    vm.sendMessage(inputText)
                    inputText = ""
                    popoverDismissed = false
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

            Spacer()
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
}

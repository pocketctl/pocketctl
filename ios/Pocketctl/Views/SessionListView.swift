import SwiftUI

struct SessionListView: View {
    let daemon: Daemon
    @Binding var isLoggedIn: Bool
    let wsService: WebSocketService
    let apiClient: APIClient
    let initialSessions: [Session]

    @Environment(\.dismiss) private var dismiss
    @State private var viewModel: SessionListViewModel?
    @State private var didConnect = false
    @State private var navigateToDetail: Session?
    @State private var showNewSession = false

    var body: some View {
        ZStack {
            Color.pcBackground.ignoresSafeArea()

            VStack(spacing: 0) {
                // Nav bar
                navBar

                // Daemon status bar
                daemonStatusBar

                // Error banner
                if let vm = viewModel, vm.showError, let error = vm.error {
                    errorBanner(error)
                }

                // Content
                if let vm = viewModel {
                    if vm.filteredSessions.isEmpty && !vm.isLoading {
                        emptyState
                        Spacer()
                    } else {
                        sessionList(vm: vm)
                    }
                } else {
                    Spacer()
                }
            }
        }
        .navigationBarHidden(true)
        .navigationDestination(item: $navigateToDetail) { session in
            SessionDetailView(session: session)
        }
        .sheet(isPresented: $showNewSession) {
            NewSessionSheet(daemon: daemon) { agent, cwd, prompt in
                viewModel?.createSession(agent: agent, cwd: cwd, prompt: prompt)
                showNewSession = false
            }
        }
        .task {
            // Only create ViewModel and connect once
            guard !didConnect else { return }

            let vm = SessionListViewModel(daemon: daemon, wsService: wsService, apiClient: apiClient, initialSessions: initialSessions)
            viewModel = vm
            await vm.connect()
            didConnect = true
        }
        .onAppear {
            // Incremental refresh only — data is already showing
            if let vm = viewModel, vm.isConnected {
                vm.refresh()
            }
        }
    }

    // MARK: - Nav bar

    private var navBar: some View {
        HStack(spacing: 8) {
            // Back button
            Button { dismiss() } label: {
                HStack(spacing: 4) {
                    Image(systemName: "chevron.left")
                        .font(.system(size: 15, weight: .medium))
                    Text("我的主机")
                        .font(PCFont.body(15))
                }
                .foregroundStyle(Color.pcAccent)
            }

            Spacer()

            // Title
            Text(daemon.hostname)
                .font(PCFont.display(17, weight: .semibold))
                .foregroundStyle(Color.pcFg)

            Spacer()

            // New session button
            Button { showNewSession = true } label: {
                Image(systemName: "plus")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(Color.pcBackground)
                    .frame(width: 32, height: 32)
                    .background(Color.pcPrimaryBtn)
                    .clipShape(Circle())
            }
        }
        .padding(.horizontal, PCSpacing.lg)
        .padding(.vertical, PCSpacing.md)
    }

    // MARK: - Daemon status bar

    private var daemonStatusBar: some View {
        HStack(spacing: 6) {
            StatusDot(status: daemon.online ? "online" : "offline", size: 8)
            Text(daemon.online ? "在线 · 最后心跳 \(viewModel?.heartbeatText ?? "刚刚")" : "离线")
                .font(PCFont.body(13))
                .foregroundStyle(Color.pcFgSecondary)
            Spacer()
        }
        .padding(.horizontal, PCSpacing.lg)
        .padding(.vertical, PCSpacing.sm)
    }

    // MARK: - Session list

    private func sessionList(vm: SessionListViewModel) -> some View {
        ScrollView {
            LazyVStack(spacing: PCSpacing.sm) {
                ForEach(Array(vm.displayedSessions.enumerated()), id: \.element.sessionId) { index, session in
                    Group {
                        if session.status == "exited" || session.status == "completed" || session.status == "error" || session.status == "killed" {
                            // Swipe-to-delete for terminal sessions
                            SwipeToDelete {
                                SessionCard(session: session, daemonOnline: daemon.online) {
                                    navigateToDetail = session
                                }
                            } onDelete: {
                                vm.deleteSession(session.sessionId)
                            }
                        } else {
                            SessionCard(session: session, daemonOnline: daemon.online) {
                                navigateToDetail = session
                            }
                        }
                    }
                    .frame(height: 68)
                    .onAppear {
                        vm.loadMoreIfNeeded(currentIndex: index)
                    }

                    // Exited session banner
                    if session.status == "exited" {
                        exitedBanner(session: session)
                    }
                }
            }
            .padding(.horizontal, PCSpacing.lg)
            .padding(.top, PCSpacing.sm)
            .padding(.bottom, PCSpacing.md)
        }
        .scrollDismissesKeyboard(.interactively)
    }

    // MARK: - Session card

    private func exitedBanner(session: Session) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 16))
                .foregroundStyle(Color.pcWarning)
            Text("会话已退出：\(session.exitReason ?? "未知原因")")
                .font(PCFont.body(14))
                .foregroundStyle(Color.pcWarning)
            Spacer()
            Button {
                // Resume: navigate to detail and send message
                navigateToDetail = session
            } label: {
                Text("恢复会话")
                    .font(PCFont.body(14, weight: .medium))
                    .foregroundStyle(Color.pcAccent)
            }
        }
        .padding(PCSpacing.md)
        .background(Color.pcWarningBg)
        .cornerRadius(PCRadius.md)
        .overlay(
            RoundedRectangle(cornerRadius: PCRadius.md)
                .stroke(Color.pcWarning.opacity(0.3), lineWidth: 1)
        )
    }

    // MARK: - Error banner

    private func errorBanner(_ message: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.circle.fill")
                .foregroundStyle(Color.pcError)
            Text(message)
                .font(PCFont.body(14))
                .foregroundStyle(Color.pcError)
            Spacer()
        }
        .padding(PCSpacing.md)
        .background(Color.pcErrorBg)
        .cornerRadius(PCRadius.sm)
        .padding(.horizontal, PCSpacing.lg)
    }

    // MARK: - Empty state

    private var emptyState: some View {
        EmptyStateView(
            icon: "lock.fill",
            title: "暂无活跃会话",
            subtitle: "点击右上角 + 创建新的 AI 编程会话"
        )
    }
}

// MARK: - Session Card

struct SessionCard: View {
    let session: Session
    let daemonOnline: Bool
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: PCSpacing.md) {
                StatusDot(status: effectiveStatus)
                    .frame(width: 10, height: 10)

                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 6) {
                        Text(session.displayTitle)
                            .font(PCFont.body(16, weight: .semibold))
                            .foregroundStyle(Color.pcFg)
                            .lineLimit(1)

                        if session.source == "terminal" {
                            StatusChip(text: "终端", style: .terminal)
                        } else if session.source == "web" {
                            StatusChip(text: "Web", style: .web)
                        }

                        if session.subagentCount > 0 {
                            StatusChip(text: "\(session.subagentCount) 子智能体", style: .subAgent)
                        }
                    }

                    HStack {
                        if let hostname = session.hostname {
                            Text(hostname)
                                .font(PCFont.body(12))
                                .foregroundStyle(Color.pcFgTertiary)
                        }
                        Spacer()
                        Text(RelativeTime.format(session.lastActivityAt ?? session.createdAt))
                            .font(PCFont.body(13))
                            .foregroundStyle(Color.pcFgTertiary)
                    }
                }
            }
            .padding(PCSpacing.md)
            .background(Color.pcSurface)
            .cornerRadius(PCRadius.md)
            .overlay(
                RoundedRectangle(cornerRadius: PCRadius.md)
                    .stroke(Color.pcBorder, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
    }

    private var effectiveStatus: String {
        if !daemonOnline && !session.isTerminal { return "disconnected" }
        return session.status
    }
}

// MARK: - Swipe to Delete (WeChat-style)
//
// 增强：增加垂直方向判断，当用户上下滑动（垂直距离 > 水平距离）时
// 忽略左滑手势，避免上下滚动时触发删除按钮。

struct SwipeToDelete<Content: View>: View {
    let content: Content
    let onDelete: () -> Void

    @State private var offset: CGFloat = 0
    @State private var isOpen = false
    /// 当次拖拽是否为垂直滚动（上下滑动），是则忽略左滑
    @State private var isVerticalScroll = false

    private let buttonWidth: CGFloat = 76
    /// 垂直/水平分量判定阈值，超过此比例视为垂直滚动
    private let verticalRatioThreshold: CGFloat = 0.6
    /// 最小垂直距离（绝对值）超过此值才判定为垂直滚动，避免细微抖动误判
    private let minVerticalDistance: CGFloat = 8

    init(@ViewBuilder content: () -> Content, onDelete: @escaping () -> Void) {
        self.content = content()
        self.onDelete = onDelete
    }

    var body: some View {
        ZStack(alignment: .trailing) {
            // Delete button — always behind content
            Button {
                withAnimation(.spring(response: 0.3, dampingFraction: 1)) {
                    onDelete()
                    close()
                }
            } label: {
                Text("删除")
                    .font(PCFont.body(15, weight: .medium))
                    .foregroundStyle(.white)
                    .frame(width: buttonWidth)
                    .frame(maxHeight: .infinity)
                    .background(Color.pcError)
            }

            // Main content — slides left to reveal delete
            content
                .offset(x: offset)
                .gesture(
                    DragGesture(minimumDistance: 6)
                        .onChanged { value in
                            let h = value.translation.width
                            let v = abs(value.translation.height)

                            // 判定是否为垂直滚动
                            if !isOpen {
                                // 未打开状态下，竖向分量明显大 → 忽略
                                if v > minVerticalDistance && (h == 0 || CGFloat(v) / CGFloat(abs(h) + 0.01) > verticalRatioThreshold) {
                                    isVerticalScroll = true
                                    return
                                }
                            }

                            // 垂直滚动中，不处理水平偏移
                            guard !isVerticalScroll else { return }
                            isVerticalScroll = false

                            if isOpen {
                                // Already open: allow right swipe to close
                                offset = max(-buttonWidth + h, -buttonWidth)
                                offset = min(offset, 0)
                            } else {
                                // Closed: only allow left swipe
                                offset = min(h, 0)
                                offset = max(offset, -buttonWidth)
                            }
                        }
                        .onEnded { value in
                            // 如果是垂直滚动，不做任何事，恢复初始状态
                            if isVerticalScroll {
                                isVerticalScroll = false
                                withAnimation(.spring(response: 0.3, dampingFraction: 1)) {
                                    close()
                                }
                                return
                            }

                            let velocity = value.predictedEndLocation.x - value.location.x
                            withAnimation(.spring(response: 0.3, dampingFraction: 1)) {
                                if isOpen {
                                    // Swiping right to close
                                    if value.translation.width > 40 || velocity > 100 {
                                        close()
                                    } else {
                                        offset = -buttonWidth
                                    }
                                } else {
                                    // Swiping left to open
                                    if value.translation.width < -40 || velocity < -100 {
                                        offset = -buttonWidth
                                        isOpen = true
                                    } else {
                                        close()
                                    }
                                }
                            }
                        }
                )
                .onTapGesture {
                    if isOpen {
                        withAnimation(.spring(response: 0.3, dampingFraction: 1)) {
                            close()
                        }
                    }
                }
        }
        .clipShape(RoundedRectangle(cornerRadius: PCRadius.md))
    }

    private func close() {
        offset = 0
        isOpen = false
        isVerticalScroll = false
    }
}

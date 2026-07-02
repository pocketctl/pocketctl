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
    @State private var newSessionSheetHeight: CGFloat = 600
    /// 删除确认:左滑删除时暂存目标会话,弹确认框后再执行。
    @State private var pendingDeleteSession: Session?

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
                    if vm.sortedSessions.isEmpty && !vm.isLoading {
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
        .swipeToPop()
        .navigationDestination(item: $navigateToDetail) { session in
            SessionDetailView(session: session, wsService: wsService, apiClient: apiClient)
        }
        .sheet(isPresented: $showNewSession) {
            NewSessionSheet(daemon: daemon, wsService: wsService, onHeightChange: { newSessionSheetHeight = max($0 + 40, 400) }) { _ in
                showNewSession = false
            }
            .presentationDetents([.height(newSessionSheetHeight)])
        }
        // 删除确认:会话删除是不可逆操作,要求二次确认。
        .alert("删除会话", isPresented: Binding(
            get: { pendingDeleteSession != nil },
            set: { if !$0 { pendingDeleteSession = nil } }
        )) {
            Button("删除", role: .destructive) {
                if let s = pendingDeleteSession {
                    viewModel?.deleteSession(s.sessionId)
                }
                pendingDeleteSession = nil
            }
            Button("取消", role: .cancel) { pendingDeleteSession = nil }
        } message: {
            Text("删除后将无法恢复该会话的历史记录,确定删除?")
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
            // Incremental refresh only — data is already showing.
            // 延迟到 pop 转场动画结束后再发 list_sessions，避免回包触发的
            // sessions 重建与转场动画抢同一帧（返回时卡顿的主因）。
            // 首次进入时 didConnect 尚未置位，不会触发。
            if let vm = viewModel, vm.isConnected {
                Task { @MainActor in
                    try? await Task.sleep(for: .milliseconds(400))
                    vm.refresh()
                }
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

            // Title — alias if set, otherwise hostname
            Text(daemon.displayName)
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
                ForEach(vm.displayedSessions) { session in
                    // 主卡片 + （已退出时的）附属子卡片：立体叠放。
                    // 主卡片浮在上方并盖住副卡片顶部，投影落在副卡上，形成层叠层次。
                    VStack(spacing: 0) {
                        Group {
                            // 所有会话都支持左滑：置顶/取消置顶；已退出会话额外有删除
                            SwipeToDelete(
                                isPinned: session.pinned,
                                canDelete: session.isTerminal
                            ) {
                                SessionCard(session: session, daemonOnline: daemon.online, hostLabel: daemon.displayName) {
                                    navigateToDetail = session
                                }
                            } onPin: {
                                vm.togglePin(session.sessionId)
                            } onDelete: {
                                pendingDeleteSession = session
                            }
                        }
                        .frame(minHeight: 76)
                        .zIndex(session.status == "exited" ? 1 : 0)
                        .shadow(color: session.status == "exited"
                                ? Color.black.opacity(0.45)
                                : Color.clear,
                                radius: 5, x: 0, y: 3)
                        .onAppear {
                            vm.loadMoreIfNeeded(currentSessionId: session.sessionId)
                        }

                        // 已退出会话的附属子卡片：顶部上钻到主卡背后，被主卡盖住一部分
                        if session.status == "exited" {
                            exitedSubBanner(session: session)
                                .padding(.top, -14)
                                .zIndex(0)
                        }
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

    /// 已退出会话的附属子卡片：立体叠放在主卡下方，顶部被主卡盖住一部分。
    /// 全四角圆角 + 左右略窄于主卡 + 警告色调，形成「主卡浮于副卡之上」的层叠层次。
    private func exitedSubBanner(session: Session) -> some View {
        HStack(spacing: 8) {
            // 左侧警告色竖条（视觉锚点，强化附属关系）
            Rectangle()
                .fill(Color.pcWarning)
                .frame(width: 3)
                .padding(.vertical, -PCSpacing.sm)

            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 13))
                .foregroundStyle(Color.pcWarning)
            Text("会话已退出：\(session.exitReason ?? "未知原因")")
                .font(PCFont.body(13))
                .foregroundStyle(Color.pcWarning)
                .lineLimit(1)
            Spacer()
            Button {
                // Resume: navigate to detail and send message
                navigateToDetail = session
            } label: {
                Text("恢复会话")
                    .font(PCFont.body(13, weight: .medium))
                    .foregroundStyle(Color.pcAccent)
                    .padding(.horizontal, PCSpacing.sm)
                    .padding(.vertical, 4)
                    .background(Color.pcAccent.opacity(0.12))
                    .cornerRadius(PCRadius.full)
            }
        }
        .padding(.horizontal, PCSpacing.md)
        // 顶部多留空间，被主卡盖住后仍有足够内容区可读
        .padding(.top, PCSpacing.lg)
        .padding(.bottom, PCSpacing.sm)
        .background(Color.pcWarningBg)
        .overlay(
            // 全四角边框 + 圆角：作为独立层呈现
            RoundedRectangle(cornerRadius: PCRadius.md)
                .stroke(Color.pcWarning.opacity(0.3), lineWidth: 1)
        )
        .cornerRadius(PCRadius.md)
        // 左右内缩 6pt，比主卡略窄，强化「垫在主卡下层」的视觉
        .padding(.horizontal, 6)
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
    /// Host label to show on the card — alias if set, otherwise hostname.
    let hostLabel: String
    let onTap: () -> Void

    @State private var copied = false

    var body: some View {
        HStack(spacing: PCSpacing.md) {
            StatusDot(status: effectiveStatus)
                .frame(width: 10, height: 10)

            VStack(alignment: .leading, spacing: 3) {
                // 标题行：置顶图标 + 会话名称 + 来源标签（右对齐）
                HStack(spacing: 6) {
                    if session.pinned {
                        Image(systemName: "pin.fill")
                            .font(.system(size: 12))
                            .foregroundStyle(Color.pcAccent)
                    }
                    Text(session.displayTitle)
                        .font(PCFont.body(16, weight: .semibold))
                        .foregroundStyle(Color.pcFg)
                        .lineLimit(1)
                    Spacer(minLength: 4)
                    if session.source == "terminal" {
                        StatusChip(text: "终端", style: .terminal)
                    } else if session.source == "web" {
                        StatusChip(text: "Web", style: .web)
                    }
                }

                // 元信息行：agent 类型 · 当前模型 · 子智能体标签
                // 固定高度容器：无内容时保留等高占位（Color.clear），保证所有卡片
                // 高度严格一致，与「有 agent 类型的卡片」对齐。
                Group {
                    if hasMetaLine {
                        HStack(spacing: 6) {
                            if !session.agentType.isEmpty {
                                // agent 标签样式与主机列表（DaemonListView.agentTags）保持一致：
                                // 品牌色小圆点 + 名称 + 品牌色 12% 底色胶囊
                                HStack(spacing: 4) {
                                    Circle().fill(agentVisual(session.agentType).color).frame(width: 6, height: 6)
                                    Text(displayAgentName(session.agentType))
                                }
                                .font(PCFont.body(12, weight: .medium))
                                .foregroundStyle(agentVisual(session.agentType).color)
                                .padding(.horizontal, 8).padding(.vertical, 3)
                                .background(agentVisual(session.agentType).color.opacity(0.12))
                                .cornerRadius(PCRadius.full)
                            }
                            if let model = session.displayModel {
                                Text(model)
                                    .font(PCFont.mono(11))
                                    .foregroundStyle(Color.pcFgTertiary)
                                    .lineLimit(1)
                            }
                            if session.subagentCount > 0 {
                                StatusChip(text: "\(session.subagentCount) 子智能体", style: .subAgent)
                            }
                        }
                    } else {
                        // 占位：保留元信息行的高度，让卡片高度统一
                        Color.clear.frame(height: 18)
                    }
                }
                .frame(height: 18, alignment: .leading)

                // 时间/host 行
                HStack {
                    Text(hostLabel)
                        .font(PCFont.body(12))
                        .foregroundStyle(Color.pcFgTertiary)
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
        .overlay {
            if copied {
                Text("已复制会话 ID")
                    .font(PCFont.body(12, weight: .medium))
                    .foregroundStyle(Color.pcFg)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(Color.pcAccent)
                    .cornerRadius(PCRadius.sm)
                    .transition(.opacity.combined(with: .scale(scale: 0.9)))
            }
        }
        .contentShape(Rectangle())
        .onTapGesture(perform: onTap)
        .onLongPressGesture(minimumDuration: 0.5) {
            UIPasteboard.general.string = session.sessionId
            withAnimation { copied = true }
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
                withAnimation { copied = false }
            }
        }
        .sensoryFeedback(.success, trigger: copied)
    }

    private var effectiveStatus: String {
        if !daemonOnline && !session.isTerminal { return "disconnected" }
        return session.status
    }

    /// 是否存在元信息行（agent 类型 / 模型 / 子智能体）。全部为空则不渲染该行。
    /// 注：来源标签（终端/Web）已上移到标题行，不参与本行判断。
    private var hasMetaLine: Bool {
        !session.agentType.isEmpty ||
        session.displayModel != nil ||
        session.subagentCount > 0
    }
}

// MARK: - Swipe Actions (Pin + Delete, WeChat-style)
//
// 增强：增加垂直方向判断，当用户上下滑动（垂直距离 > 水平距离）时
// 忽略左滑手势，避免上下滚动时触发操作按钮。
//
// 支持双按钮：置顶/取消置顶（所有会话）+ 删除（仅已退出会话）。

struct SwipeToDelete<Content: View>: View {
    let content: Content
    let isPinned: Bool
    let canDelete: Bool
    let onPin: () -> Void
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
    /// 手势触发门槛。太低（6pt）会让 ScrollView 的垂直 pan 与每张卡片的左滑
    /// 手势长时间争夺事件所有权，滚动时掉帧。提到 12pt 让 ScrollView 优先
    /// 识别垂直滚动，左滑仍很灵敏。
    private let dragMinimumDistance: CGFloat = 12

    /// 操作按钮总宽度（置顶 + 可选删除）
    private var maxOffset: CGFloat {
        canDelete ? buttonWidth * 2 : buttonWidth
    }

    init(isPinned: Bool, canDelete: Bool, @ViewBuilder content: () -> Content, onPin: @escaping () -> Void, onDelete: @escaping () -> Void) {
        self.isPinned = isPinned
        self.canDelete = canDelete
        self.content = content()
        self.onPin = onPin
        self.onDelete = onDelete
    }

    var body: some View {
        ZStack(alignment: .trailing) {
            // Action buttons — behind content, revealed on swipe
            HStack(spacing: 0) {
                Spacer()
                // 置顶/取消置顶按钮（所有会话都有）
                Button {
                    withAnimation(.spring(response: 0.3, dampingFraction: 1)) {
                        onPin()
                        close()
                    }
                } label: {
                    swipeButtonContent(
                        icon: isPinned ? "pin.slash.fill" : "pin.fill",
                        text: isPinned ? "取消置顶" : "置顶",
                        color: Color.pcAccent
                    )
                }
                // 删除按钮（仅已退出会话）—— 与置顶按钮共用 swipeButtonContent，
                // 图标/文字行高完全一致，视觉重心严格对齐。
                if canDelete {
                    Button {
                        withAnimation(.spring(response: 0.3, dampingFraction: 1)) {
                            onDelete()
                            close()
                        }
                    } label: {
                        swipeButtonContent(
                            icon: "trash.fill",
                            text: "删除",
                            color: Color.pcError
                        )
                    }
                }
            }

            // Main content — slides left to reveal actions
            // 内容不再是 Button，用 .gesture() 让 DragGesture 优先于 onTapGesture
            // 拖拽时 DragGesture 赢 → 不触发 onTapGesture（不会导航）
            // 点击时 DragGesture 失败 → onTapGesture 赢 → 正常导航或关闭滑开
            content
                .frame(maxHeight: .infinity)
                .background(Color.pcBackground)
                .offset(x: offset)
                .gesture(
                    DragGesture(minimumDistance: dragMinimumDistance)
                        .onChanged { value in
                            let h = value.translation.width
                            let v = abs(value.translation.height)

                            // 判定是否为垂直滚动
                            if !isOpen {
                                if v > minVerticalDistance && (h == 0 || CGFloat(v) / CGFloat(abs(h) + 0.01) > verticalRatioThreshold) {
                                    isVerticalScroll = true
                                    return
                                }
                            }

                            guard !isVerticalScroll else { return }
                            isVerticalScroll = false

                            if isOpen {
                                offset = max(-maxOffset + h, -maxOffset)
                                offset = min(offset, 0)
                            } else {
                                offset = min(h, 0)
                                offset = max(offset, -maxOffset)
                            }
                        }
                        .onEnded { value in
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
                                    if value.translation.width > 40 || velocity > 100 {
                                        close()
                                    } else {
                                        offset = -maxOffset
                                    }
                                } else {
                                    if value.translation.width < -40 || velocity < -100 {
                                        offset = -maxOffset
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

    /// 滑动操作按钮的统一内容（置顶 / 删除共用）。
    /// 关键：图标用固定高度容器居中渲染，消除不同 SF Symbol（pin vs trash）
    /// 字形 bbox 高度差异导致的视觉错位，确保两按钮图标/文字行严格水平对齐。
    @ViewBuilder
    private func swipeButtonContent(icon: String, text: String, color: Color) -> some View {
        VStack(spacing: 4) {
            Image(systemName: icon)
                .font(.system(size: 16, weight: .regular))
                .frame(height: 20, alignment: .center)
            Text(text)
                .font(PCFont.body(12, weight: .medium))
                .lineLimit(1)
                .fixedSize(horizontal: true, vertical: false)
        }
        .foregroundStyle(.white)
        .frame(width: buttonWidth)
        .frame(maxHeight: .infinity)
        .background(color)
    }
}

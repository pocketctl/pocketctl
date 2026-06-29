import SwiftUI

struct DaemonListView: View {
    @Binding var isLoggedIn: Bool

    private let apiClient = APIClient()
    private let wsService = WebSocketService()
    @State private var viewModel: DaemonListViewModel?
    @State private var didConnect = false
    @State private var navigateToSessionList: Daemon?
    @State private var navigateToTokenUsage: Daemon?
    @State private var navigateToAgentManage: Daemon?
    @State private var showSettings = false
    @State private var newSessionDaemon: Daemon?
    @State private var actionDaemon: Daemon?
    @State private var navigateToSessionDetail: Session?
    @State private var actionSheetHeight: CGFloat = 360
    @State private var newSessionSheetHeight: CGFloat = 600
    @State private var settingsSnapshotEnv: String? = nil
    @State private var hasFinishedLoading = false
    @State private var loadingProgress: CGFloat = -120

    var body: some View {
        NavigationStack {
            ZStack {
                Color.pcBackground.ignoresSafeArea()

                // 主内容：加载完成后根据有无主机分流
                if hasFinishedLoading, let vm = viewModel {
                    if vm.daemons.isEmpty {
                        // 无连接主机 → 显示主机连接引导页
                        connectGuideView
                    } else {
                        // 有连接主机 → 显示主机列表
                        mainContentView(vm: vm)
                    }
                }

                // 加载过渡动画层（数据加载完成前覆盖在上层，淡出消失）
                if !hasFinishedLoading {
                    loadingOverlay
                        .transition(.opacity)
                }
            }
            .animation(.easeInOut(duration: 0.35), value: hasFinishedLoading)
            .navigationBarHidden(true)
            .navigationDestination(item: $navigateToSessionList) { daemon in
                let initial = viewModel?.sessions.filter { $0.daemonId == daemon.daemonId } ?? []
                SessionListView(daemon: daemon, isLoggedIn: $isLoggedIn, wsService: wsService, apiClient: apiClient, initialSessions: initial)
            }
            .navigationDestination(item: $navigateToTokenUsage) { daemon in
                TokenUsageView(daemonId: daemon.daemonId, apiClient: apiClient)
            }
            .navigationDestination(item: $navigateToAgentManage) { daemon in
                AgentManageView(
                    daemonId: daemon.daemonId,
                    wsService: wsService,
                    apiClient: apiClient,
                    activeSessionsByAgent: viewModel?.activeSessionsByAgent(for: daemon.daemonId) ?? [:]
                )
            }
            .navigationDestination(item: $navigateToSessionDetail) { session in
                SessionDetailView(session: session, wsService: wsService, apiClient: apiClient)
            }
            .sheet(isPresented: $showSettings) {
                SettingsView(isLoggedIn: $isLoggedIn, daemons: viewModel?.daemons ?? [])
                    .onAppear {
                        // 记录打开设置页时的环境快照，dismiss 后用于判断是否需要重连
                        settingsSnapshotEnv = RelayEnvironmentManager.shared.current.rawValue
                            + "|" + (RelayEnvironmentManager.shared.customStagingHost ?? "")
                    }
                    .onDisappear {
                        let now = RelayEnvironmentManager.shared.current.rawValue
                            + "|" + (RelayEnvironmentManager.shared.customStagingHost ?? "")
                        guard now != (settingsSnapshotEnv ?? "") else { return }
                        // 环境或测试地址发生变化 → 断开旧连接并用新地址重连
                        wsService.disconnect()
                        Task {
                            try? await Task.sleep(for: .milliseconds(300))
                            await viewModel?.connect()
                        }
                    }
            }
            .sheet(item: $newSessionDaemon) { daemon in
                NewSessionSheet(daemon: daemon, wsService: wsService, onHeightChange: { newSessionSheetHeight = max($0 + 40, 400) }) { _ in
                    navigateToSessionList = daemon
                }
                .presentationDetents([.height(newSessionSheetHeight)])
            }
            .sheet(item: $actionDaemon) { daemon in
                DaemonActionSheet(
                    daemon: daemon,
                    onHeightChange: { actionSheetHeight = max($0 + 40, 240) },
                    onRestart: { Task { await viewModel?.restartDaemon(daemon.daemonId) } },
                    onEditAliasConfirm: { alias in viewModel?.setAlias(daemonId: daemon.daemonId, alias: alias) },
                    onForceKick: { Task { try? await viewModel?.forceKickDaemon(daemon.daemonId) } },
                    onDelete: { Task { await viewModel?.deleteDaemon(daemon.daemonId) } }
                )
                .presentationDetents([.height(actionSheetHeight)])
            }
        }
        .task {
            // 启动加载进度动画
            withAnimation(.easeInOut(duration: 1.6).repeatForever(autoreverses: false)) {
                loadingProgress = 120
            }
            guard !didConnect else { return }
            let vm = DaemonListViewModel(wsService: wsService, apiClient: apiClient)
            vm.onAuthExpired = { isLoggedIn = false }
            viewModel = vm
            await vm.connect()
            didConnect = true
            // 给数据一点渲染时间后淡出加载层，过渡更顺滑
            try? await Task.sleep(for: .milliseconds(200))
            hasFinishedLoading = true
        }
        .onAppear {
            if let vm = viewModel, vm.isConnected { vm.refresh() }
        }
    }

    // MARK: - Loading overlay

    /// 加载过渡动画层（进入主机列表前的过渡，参照 SplashView 风格）
    private var loadingOverlay: some View {
        ZStack {
            Color.pcBackground.ignoresSafeArea()

            VStack(spacing: 12) {
                Image(systemName: "terminal.fill")
                    .font(.system(size: 44))
                    .foregroundStyle(Color.pcAccent)

                Text("pocketctl")
                    .font(PCFont.display(32, weight: .bold))
                    .foregroundStyle(Color.pcAccent)
                    .kerning(-0.5)

                Text("Your coding agents, in your pocket.")
                    .font(PCFont.body(15))
                    .foregroundStyle(Color.pcFgSecondary)
            }

            // 底部进度条
            VStack {
                Spacer()
                ZStack(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 2)
                        .fill(Color.pcBorder)
                        .frame(width: 120, height: 3)
                    RoundedRectangle(cornerRadius: 2)
                        .fill(Color.pcAccent)
                        .frame(width: 48, height: 3)
                        .offset(x: loadingProgress)
                }
                .padding(.bottom, 80)
            }
        }
    }

    // MARK: - Connect guide (no daemons)

    /// 无连接主机时显示的主机连接引导页
    private var connectGuideView: some View {
        VStack(spacing: 24) {
            // 顶部留白，把内容推到视觉居中偏上
            Spacer().frame(height: 60)

            VStack(spacing: 12) {
                Image(systemName: "desktopcomputer")
                    .font(.system(size: 56))
                    .foregroundStyle(Color.pcAccent)
                    .opacity(0.7)

                Text("连接你的第一台主机")
                    .font(PCFont.display(22, weight: .semibold))
                    .foregroundStyle(Color.pcFg)

                Text("在你的 Mac 或 Linux 开发机上运行以下命令，\n安装并启动 Daemon 守护进程")
                    .font(PCFont.body(15))
                    .foregroundStyle(Color.pcFgSecondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 300)
            }

            // 安装命令
            VStack(alignment: .leading, spacing: 6) {
                let env = RelayEnvironmentManager.shared.current
                codeLine("# 1. 安装 Daemon")
                codeLine("curl -fsSL \(env.installURL) | bash")
                codeLine("")
                codeLine("# 2. 登录（使用 App 注册的邮箱）")
                codeLine("pocketctl login")
                codeLine("")
                codeLine("# 3. 启动守护进程")
                codeLine("pocketctl daemon start")
            }
            .padding(PCSpacing.md)
            .background(Color.pcCodeBg)
            .cornerRadius(PCRadius.sm)
            .padding(.horizontal, PCSpacing.lg)

            Button {
                let env = RelayEnvironmentManager.shared.current
                UIPasteboard.general.string = "curl -fsSL \(env.installURL) | bash\npocketctl login\npocketctl daemon start"
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "doc.on.doc").font(.system(size: 14))
                    Text("复制全部命令").font(PCFont.body(14, weight: .medium))
                }
                .foregroundStyle(.white)
                .padding(.horizontal, 20).padding(.vertical, 12)
                .background(Color.pcPrimaryBtn)
                .cornerRadius(PCRadius.sm)
            }

            // 连接成功提示
            Text("启动后主机将自动出现在列表中")
                .font(PCFont.body(13))
                .foregroundStyle(Color.pcFgTertiary)

            Spacer()
        }
        .padding(.horizontal, PCSpacing.lg)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Main content (has daemons)

    /// 有连接主机时显示的主机列表内容
    private func mainContentView(vm: DaemonListViewModel) -> some View {
        ScrollView {
            VStack(spacing: 0) {
                headerSection
                    .padding(.bottom, PCSpacing.md)

                OverviewCard(
                    online: vm.onlineCount,
                    offline: max(vm.daemons.count - vm.onlineCount, 0),
                    todayTokens: vm.tokenSummary?.today,
                    activeSessions: vm.sessions.filter { !$0.isTerminal }.count
                )
                .padding(.horizontal, PCSpacing.lg)
                .padding(.bottom, PCSpacing.md)

                daemonCards(vm: vm)

                if !vm.recentSessions.isEmpty {
                    recentSessionsSection(vm: vm)
                }
            }
        }
        .scrollDismissesKeyboard(.interactively)
    }

    // MARK: - Header

    private var headerSection: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 4) {
                Text("我的主机")
                    .font(PCFont.display(34, weight: .bold))
                    .foregroundStyle(Color.pcFg)
                if let vm = viewModel {
                    Text("\(vm.daemons.count) 台主机 · \(vm.onlineCount) 台在线")
                        .font(PCFont.body(13))
                        .foregroundStyle(Color.pcFgSecondary)
                }
            }
            Spacer()
            Button { showSettings = true } label: {
                let user = KeychainStorage.currentUser
                let name = KeychainStorage.localDisplayName ?? user?.displayName ?? user?.phone
                let initial: String = {
                    if let name, !name.isEmpty { return String(name.prefix(1)).uppercased() }
                    return "?"
                }()
                Text(initial)
                    .font(PCFont.body(16, weight: .semibold))
                    .foregroundStyle(Color.pcFgSecondary)
                    .frame(width: 36, height: 36)
                    .background(Color.pcSurface)
                    .clipShape(Circle())
                    .overlay(Circle().stroke(Color.pcBorder, lineWidth: 1))
            }
        }
        .padding(.horizontal, PCSpacing.lg)
        .padding(.top, PCSpacing.md)
    }

    // MARK: - Daemon cards

    private func daemonCards(vm: DaemonListViewModel) -> some View {
        VStack(spacing: PCSpacing.sm) {
            ForEach(vm.daemons) { daemon in
                DaemonCard(
                    daemon: daemon,
                    activeSessions: vm.activeSessionCount(for: daemon.daemonId),
                    totalSessions: vm.sessions.filter { $0.daemonId == daemon.daemonId }.count,
                    lastActivity: vm.lastActivity(for: daemon.daemonId),
                    onTapSession: { navigateToSessionList = daemon },
                    onTapNewSession: { newSessionDaemon = daemon },
                    onTapToken: { navigateToTokenUsage = daemon },
                    onTapAgent: { navigateToAgentManage = daemon },
                    onMore: { actionDaemon = daemon },
                    onSetAlias: { vm.setAlias(daemonId: daemon.daemonId, alias: $0) }
                )
            }
        }
        .padding(.horizontal, PCSpacing.lg)
    }

    // MARK: - Recent sessions

    private func recentSessionsSection(vm: DaemonListViewModel) -> some View {
        VStack(alignment: .leading, spacing: PCSpacing.sm) {
            Text("最近会话")
                .font(PCFont.body(13, weight: .semibold))
                .foregroundStyle(Color.pcFgSecondary)
            ForEach(Array(vm.recentSessions.prefix(3).enumerated()), id: \.offset) { _, session in
                Button { navigateToSessionDetail = session } label: {
                    HStack(spacing: 10) {
                        Circle()
                            .fill(session.isTerminal ? Color.pcAccent : Color.pcSuccess)
                            .frame(width: 7, height: 7)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(session.displayTitle)
                                .font(PCFont.body(15, weight: .medium))
                                .foregroundStyle(Color.pcFg)
                                .lineLimit(1)
                            Text("\(session.hostname ?? String(session.daemonId.prefix(8))) · \(RelativeTime.format(session.lastActivityAt ?? session.createdAt))")
                                .font(PCFont.body(12))
                                .foregroundStyle(Color.pcFgTertiary)
                        }
                        Spacer()
                    }
                    .padding(.horizontal, PCSpacing.lg)
                    .padding(.vertical, 12)
                    .background(Color.pcSurface)
                    .overlay(RoundedRectangle(cornerRadius: PCRadius.md).stroke(Color.pcBorder, lineWidth: 1))
                    .cornerRadius(PCRadius.md)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, PCSpacing.lg)
        .padding(.top, PCSpacing.lg)
    }

    private func codeLine(_ text: String) -> some View {
        Text(text).font(PCFont.mono(12)).foregroundStyle(Color.pcSuccess).textSelection(.enabled)
    }
}

// MARK: - Daemon Action Sheet (bottom sheet, restores daemon-list.html action-sheet)

/// Measures the action sheet's intrinsic content height so the presenting
/// sheet can size its detent to fit (auto-adapts between action list & edit-alias).
private struct ActionSheetHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

private struct DaemonActionSheet: View {
    let daemon: Daemon
    let onHeightChange: (CGFloat) -> Void
    let onRestart: () -> Void
    let onEditAliasConfirm: (String?) -> Void
    let onForceKick: () -> Void
    let onDelete: () -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var isEditingAlias = false
    @State private var aliasText: String
    @FocusState private var isFocused: Bool

    init(daemon: Daemon,
         onHeightChange: @escaping (CGFloat) -> Void,
         onRestart: @escaping () -> Void,
         onEditAliasConfirm: @escaping (String?) -> Void,
         onForceKick: @escaping () -> Void,
         onDelete: @escaping () -> Void) {
        self.daemon = daemon
        self.onHeightChange = onHeightChange
        self.onRestart = onRestart
        self.onEditAliasConfirm = onEditAliasConfirm
        self.onForceKick = onForceKick
        self.onDelete = onDelete
        _aliasText = State(initialValue: daemon.alias ?? "")
    }

    var body: some View {
        VStack(spacing: 0) {
            // Drag handle — matches NewSessionSheet
            RoundedRectangle(cornerRadius: 3)
                .fill(Color.pcFgTertiary)
                .frame(width: 36, height: 5)
                .padding(.top, 16).padding(.bottom, 16)

            if isEditingAlias {
                editAliasView
            } else {
                actionListView
            }
        }
        .padding(.horizontal, PCSpacing.xxl)
        .background(
            GeometryReader { proxy in
                Color.clear.preference(key: ActionSheetHeightKey.self, value: proxy.size.height)
            }
        )
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(Color.pcSurface)
        .onPreferenceChange(ActionSheetHeightKey.self) { onHeightChange($0) }
    }

    // MARK: Action list

    private var actionListView: some View {
        VStack(spacing: 0) {
            Text(daemon.displayName)
                .font(PCFont.display(20, weight: .semibold))
                .foregroundStyle(Color.pcFg)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.bottom, 8)

            actionRow(title: "重启 daemon", icon: "arrow.clockwise", color: .pcAccent) {
                dismiss(); onRestart()
            }
            rowDivider
            actionRow(title: "编辑别名", icon: "pencil", color: .pcAccent) {
                isEditingAlias = true
            }
            rowDivider
            actionRow(title: "强制踢下线", icon: "arrow.down.circle", color: .pcError) {
                dismiss(); onForceKick()
            }
            rowDivider
            actionRow(title: "注销主机", icon: "trash", color: .pcError) {
                dismiss(); onDelete()
            }

            Button { dismiss() } label: {
                Text("取消")
                    .font(PCFont.display(17, weight: .semibold))
                    .foregroundStyle(Color.pcFg)
                    .frame(maxWidth: .infinity).padding(.vertical, 16)
                    .background(Color.pcHoverInput)
                    .cornerRadius(PCRadius.md)
            }
            .buttonStyle(.plain)
            .padding(.top, 20)
        }
    }

    private var rowDivider: some View {
        Rectangle().fill(Color.pcBorder).frame(height: 0.5)
    }

    private func actionRow(title: String, icon: String, color: Color, action: @escaping () -> Void) -> some View {
        Button { action() } label: {
            HStack(spacing: 14) {
                Image(systemName: icon)
                    .font(.system(size: 18))
                    .foregroundStyle(color)
                    .frame(width: 24)
                Text(title)
                    .font(PCFont.body(17))
                    .foregroundStyle(color)
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.system(size: 14))
                    .foregroundStyle(Color.pcFgTertiary)
            }
            .padding(.vertical, 14)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    // MARK: Edit alias

    private var editAliasView: some View {
        VStack(spacing: 16) {
            Text("编辑别名")
                .font(PCFont.display(20, weight: .semibold))
                .foregroundStyle(Color.pcFg)
                .frame(maxWidth: .infinity, alignment: .leading)

            TextField("输入别名…", text: $aliasText)
                .font(PCFont.body(16))
                .foregroundStyle(Color.pcFg)
                .focused($isFocused)
                .submitLabel(.done)
                .onSubmit { confirmAlias() }
                .padding(12)
                .background(Color.pcBackground)
                .overlay(RoundedRectangle(cornerRadius: PCRadius.md).stroke(isFocused ? Color.pcAccent : Color.pcBorder, lineWidth: 1))
                .cornerRadius(PCRadius.md)

            Button { confirmAlias() } label: {
                Text("确定")
                    .font(PCFont.display(17, weight: .semibold))
                    .foregroundStyle(Color.pcBackground)
                    .frame(maxWidth: .infinity).padding(.vertical, 16)
                    .background(Color.pcAccent)
                    .cornerRadius(PCRadius.md)
            }
            .buttonStyle(.plain)
        }
        .onAppear { DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { isFocused = true } }
    }

    private func confirmAlias() {
        let trimmed = aliasText.trimmingCharacters(in: .whitespacesAndNewlines)
        onEditAliasConfirm(trimmed.isEmpty ? nil : trimmed)
        dismiss()
    }
}

// MARK: - Overview Card

private struct OverviewCard: View {
    let online: Int
    let offline: Int
    let todayTokens: Int?
    let activeSessions: Int

    var body: some View {
        HStack(spacing: 0) {
            item(value: "\(online)", label: "在线", color: .pcSuccess)
            divider
            item(value: "\(offline)", label: "离线", color: .pcFgTertiary)
            divider
            item(value: todayTokens.map(formatTokens) ?? "—", label: "今日 Token", color: .pcAccent)
            divider
            item(value: "\(activeSessions)", label: "活跃会话", color: .pcFg)
        }
        .padding(.vertical, 14)
        .background(Color.pcSurface)
        .overlay(RoundedRectangle(cornerRadius: PCRadius.lg).stroke(Color.pcBorder, lineWidth: 1))
        .cornerRadius(PCRadius.lg)
    }

    private func item(value: String, label: String, color: Color) -> some View {
        VStack(spacing: 2) {
            Text(value).font(PCFont.body(20, weight: .bold)).foregroundStyle(color)
            Text(label).font(PCFont.body(11)).foregroundStyle(Color.pcFgTertiary)
        }
        .frame(maxWidth: .infinity)
    }
    private var divider: some View {
        Rectangle().fill(Color.pcBorder).frame(width: 0.5)
    }
}

// MARK: - Daemon Card

struct DaemonCard: View {
    let daemon: Daemon
    let activeSessions: Int
    let totalSessions: Int
    let lastActivity: String?
    let onTapSession: () -> Void
    let onTapNewSession: () -> Void
    let onTapToken: () -> Void
    let onTapAgent: () -> Void
    let onMore: () -> Void
    let onSetAlias: (String?) -> Void

    @State private var isEditing = false
    @State private var editText = ""
    @FocusState private var isInputFocused: Bool

    private var hasAlias: Bool { daemon.alias != nil }
    private var upgradableCount: Int { daemon.upgradableAgentCount }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                StatusDot(status: daemon.online ? "online" : "offline")
                Text(daemon.displayName)
                    .font(PCFont.body(17, weight: .semibold))
                    .foregroundStyle(Color.pcFg)
                    .lineLimit(1).truncationMode(.tail)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .onTapGesture { onTapSession() }

                if hasAlias {
                    Text("别名")
                        .font(PCFont.body(11, weight: .medium))
                        .foregroundStyle(Color.pcAccent)
                        .padding(.horizontal, 5).padding(.vertical, 1)
                        .background(Color.pcAccentSubtle).cornerRadius(4)
                }
                Button { startEdit() } label: {
                    Image(systemName: "pencil").font(.system(size: 14)).foregroundStyle(Color.pcFgTertiary).padding(.horizontal, 4).padding(.vertical, 2)
                }.buttonStyle(.plain)
                StatusChip(text: daemon.online ? "在线" : "离线", style: .status(daemon.online ? "running" : "offline"))
                Button { onMore() } label: {
                    Image(systemName: "ellipsis")
                        .font(.system(size: 16, weight: .bold))
                        .foregroundStyle(Color.pcFgTertiary)
                        .frame(width: 28, height: 28)
                        .rotationEffect(.degrees(90))
                }.buttonStyle(.plain)
            }
            .padding(.horizontal, PCSpacing.lg)
            .padding(.top, PCSpacing.lg).padding(.bottom, PCSpacing.sm)

            if isEditing {
                renameRow
                    .padding(.horizontal, PCSpacing.lg)
                    .padding(.bottom, PCSpacing.sm)
            }

            if !daemon.agents.isEmpty {
                agentTags
                    .padding(.horizontal, PCSpacing.lg)
                    .padding(.bottom, PCSpacing.sm)
            }

            VStack(spacing: 0) {
                featureRow(icon: "bubble.left.and.bubble.right", color: .pcAccent, label: "会话列表", value: "\(activeSessions) 活跃 · \(totalSessions) 历史", action: onTapSession)
                featureRow(icon: "plus", color: .pcSuccess, label: "新建会话", value: daemon.online ? nil : "主机离线", disabled: !daemon.online, action: onTapNewSession)
                featureRow(icon: "chart.bar", color: .pcSubAgent, label: "Token 消耗", value: nil, action: onTapToken)
                featureRow(icon: "wrench.and.screwdriver", color: .pcWarning, label: "Agent 管理", value: agentManageValue, disabled: !daemon.online, warn: upgradableCount > 0, action: onTapAgent)
            }
            .overlay(Rectangle().fill(Color.pcBorder).frame(height: 0.5), alignment: .top)
            .padding(.top, 2)

            HStack {
                if let lastActivity {
                    Text("最后活跃: \(lastActivity)").font(PCFont.body(13)).foregroundStyle(Color.pcFgSecondary)
                }
                Spacer()
            }
            .padding(.horizontal, PCSpacing.lg)
            .padding(.vertical, PCSpacing.sm)
        }
        .background(Color.pcSurface)
        .cornerRadius(PCRadius.lg)
        .overlay(RoundedRectangle(cornerRadius: PCRadius.lg).stroke(Color.pcBorder, lineWidth: 1))
    }

    private var agentManageValue: String? {
        guard !daemon.agents.isEmpty else { return nil }
        return upgradableCount > 0 ? "\(daemon.agents.count) 个 · \(upgradableCount) 可升级" : "\(daemon.agents.count) 个"
    }

    private var agentTags: some View {
        FlowLayout(spacing: 6) {
            ForEach(daemon.agents) { agent in
                HStack(spacing: 4) {
                    Circle().fill(agentVisual(agent.type).color).frame(width: 6, height: 6)
                    Text(displayAgentName(agent.type))
                    if !agent.version.isEmpty {
                        Text("v\(agent.version)").font(PCFont.body(10))
                    }
                    if agent.canUpgrade {
                        Text("可升级").font(PCFont.body(10, weight: .semibold)).foregroundStyle(Color.pcWarning)
                    }
                }
                .font(PCFont.body(12, weight: .medium))
                .foregroundStyle(agentVisual(agent.type).color)
                .padding(.horizontal, 8).padding(.vertical, 3)
                .background(agentVisual(agent.type).color.opacity(0.12))
                .cornerRadius(PCRadius.full)
            }
        }
    }

    @ViewBuilder
    private func featureRow(icon: String, color: Color, label: String, value: String?, disabled: Bool = false, warn: Bool = false, action: @escaping () -> Void) -> some View {
        Button { if !disabled { action() } } label: {
            HStack(spacing: 10) {
                Image(systemName: icon).font(.system(size: 14)).foregroundStyle(color)
                    .frame(width: 28, height: 28).background(color.opacity(0.12)).cornerRadius(7)
                Text(label).font(PCFont.body(15, weight: .medium)).foregroundStyle(Color.pcFg)
                Spacer()
                if let value {
                    Text(value)
                        .font(PCFont.body(13))
                        .foregroundStyle(warn ? Color.pcWarning : Color.pcFgTertiary)
                }
                Image(systemName: "chevron.right").font(.system(size: 14)).foregroundStyle(Color.pcFgTertiary)
            }
            .padding(.horizontal, PCSpacing.lg).padding(.vertical, 11)
            .opacity(disabled ? 0.4 : 1)
            .overlay(Rectangle().fill(Color.pcBorder).frame(height: 0.5).padding(.leading, PCSpacing.lg + 38), alignment: .bottom)
        }
        .buttonStyle(.plain)
        .disabled(disabled)
    }

    private var renameRow: some View {
        HStack(spacing: 6) {
            TextField("输入别名…", text: $editText)
                .font(PCFont.body(15)).foregroundStyle(Color.pcFg)
                .focused($isInputFocused)
                .onSubmit { confirmRename() }
                .padding(.horizontal, 10).padding(.vertical, 6)
                .background(Color.pcBackground)
                .overlay(RoundedRectangle(cornerRadius: 6).stroke(isInputFocused ? Color.pcAccent : Color.pcBorder, lineWidth: 1))
            Button { confirmRename() } label: { Image(systemName: "checkmark").font(.system(size: 16, weight: .semibold)).padding(4) }
                .buttonStyle(RenameActionButtonStyle(pressedColor: .pcSuccess))
            Button { cancelRename() } label: { Image(systemName: "xmark").font(.system(size: 16, weight: .semibold)).padding(4) }
                .buttonStyle(RenameActionButtonStyle(pressedColor: .pcError))
        }
    }

    private func startEdit() {
        withAnimation(.easeInOut(duration: 0.15)) { isEditing = true }
        editText = daemon.alias ?? ""
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { isInputFocused = true }
    }
    private func confirmRename() {
        let trimmed = editText.trimmingCharacters(in: .whitespacesAndNewlines)
        withAnimation(.easeInOut(duration: 0.15)) { isEditing = false; isInputFocused = false }
        onSetAlias(trimmed.isEmpty ? nil : trimmed)
    }
    private func cancelRename() {
        withAnimation(.easeInOut(duration: 0.15)) { isEditing = false; isInputFocused = false }
    }
}

// MARK: - Flow layout (wrapping tags)

private struct FlowLayout: Layout {
    var spacing: CGFloat = 6
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxWidth = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, rowH: CGFloat = 0
        for s in subviews {
            let sz = s.sizeThatFits(.unspecified)
            if x + sz.width > maxWidth { x = 0; y += rowH + spacing; rowH = 0 }
            x += sz.width + spacing
            rowH = max(rowH, sz.height)
        }
        return CGSize(width: maxWidth, height: y + rowH)
    }
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, rowH: CGFloat = 0
        let maxWidth = bounds.width
        for s in subviews {
            let sz = s.sizeThatFits(.unspecified)
            if x + sz.width > bounds.minX + maxWidth { x = bounds.minX; y += rowH + spacing; rowH = 0 }
            s.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(sz))
            x += sz.width + spacing
            rowH = max(rowH, sz.height)
        }
    }
}

// MARK: - Rename Action Button Style

private struct RenameActionButtonStyle: ButtonStyle {
    let pressedColor: Color
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.foregroundStyle(configuration.isPressed ? pressedColor : Color.pcFgTertiary)
    }
}

import SwiftUI

struct DaemonListView: View {
    @Binding var isLoggedIn: Bool

    private let apiClient = APIClient()
    private let wsService = WebSocketService()
    @State private var viewModel: DaemonListViewModel?
    @State private var didConnect = false
    @State private var navigateToSessionList: Daemon?
    @State private var showSettings = false

    var body: some View {
        NavigationStack {
            ZStack {
                Color.pcBackground.ignoresSafeArea()

                ScrollView {
                    VStack(spacing: 0) {
                        // Header
                        headerSection
                            .padding(.bottom, 16)

                        if let vm = viewModel {
                            if vm.daemons.isEmpty && !vm.isLoading {
                                emptyState
                            } else {
                                daemonCards(vm: vm)
                            }
                        }
                    }
                }
            }
            .navigationBarHidden(true)
            .navigationDestination(item: $navigateToSessionList) { daemon in
                let initialSessions = viewModel?.sessions.filter { $0.daemonId == daemon.daemonId } ?? []
                SessionListView(daemon: daemon, isLoggedIn: $isLoggedIn, wsService: wsService, apiClient: apiClient, initialSessions: initialSessions)
            }
            .sheet(isPresented: $showSettings) {
                SettingsView(isLoggedIn: $isLoggedIn)
            }
        }
        .task {
            // Only create ViewModel and connect once
            guard !didConnect else { return }

            let vm = DaemonListViewModel(wsService: wsService, apiClient: apiClient)
            vm.onAuthExpired = {
                isLoggedIn = false
            }
            viewModel = vm
            await vm.connect()
            didConnect = true

            // Smart navigation: auto-skip if only 1 daemon
            if vm.daemons.count == 1 {
                navigateToSessionList = vm.daemons.first
            }
        }
        .onAppear {
            // Incremental refresh only — data is already showing
            if let vm = viewModel, vm.isConnected {
                vm.refresh()
            }
        }
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
                let initial: String = {
                    let name = KeychainStorage.localDisplayName ?? user?.displayName ?? user?.phone
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
                    agentTags: vm.agentTags(for: daemon.daemonId),
                    activeSessions: vm.activeSessionCount(for: daemon.daemonId),
                    lastActivity: vm.lastActivity(for: daemon.daemonId)
                ) {
                    navigateToSessionList = daemon
                } onSetAlias: { alias in
                    vm.setAlias(daemonId: daemon.daemonId, alias: alias)
                }
            }
        }
        .padding(.horizontal, PCSpacing.lg)
    }

    // MARK: - Empty state

    private var emptyState: some View {
        VStack(spacing: 16) {
            EmptyStateView(
                icon: "desktopcomputer",
                title: "还没有注册主机",
                subtitle: "在你的开发机上运行以下命令安装 Daemon"
            )

            VStack(alignment: .leading, spacing: 4) {
                codeLine("curl -fsSL https://pocketctl.com/install.sh | bash")
                codeLine("pocketctl login")
                codeLine("pocketctl daemon start")
            }
            .padding(PCSpacing.md)
            .background(Color.pcCodeBg)
            .cornerRadius(PCRadius.sm)
            .padding(.horizontal, PCSpacing.xxl)

            Button {
                UIPasteboard.general.string = """
                curl -fsSL https://pocketctl.com/install.sh | bash
                pocketctl login
                pocketctl daemon start
                """
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "doc.on.doc")
                        .font(.system(size: 14))
                    Text("复制命令")
                        .font(PCFont.body(14))
                }
                .foregroundStyle(Color.pcAccent)
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
                .background(Color.pcSurface)
                .cornerRadius(PCRadius.sm)
                .overlay(
                    RoundedRectangle(cornerRadius: PCRadius.sm)
                        .stroke(Color.pcBorder, lineWidth: 1)
                )
            }
        }
    }

    private func codeLine(_ text: String) -> some View {
        Text(text)
            .font(PCFont.mono(12))
            .foregroundStyle(Color.pcSuccess)
            .textSelection(.enabled)
    }
}

// MARK: - Rename Action Button Style

/// Button style for rename confirm/cancel — default fgTertiary, pressed changes color
private struct RenameActionButtonStyle: ButtonStyle {
    let pressedColor: Color

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(configuration.isPressed ? pressedColor : Color.pcFgTertiary)
    }
}

// MARK: - Daemon Card

struct DaemonCard: View {
    let daemon: Daemon
    let agentTags: [String]
    let activeSessions: Int
    let lastActivity: String?
    let onTap: () -> Void
    let onSetAlias: (String?) -> Void

    @State private var isEditing = false
    @State private var editText = ""
    @FocusState private var isInputFocused: Bool

    private var hasAlias: Bool {
        daemon.alias != nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Top row: status + hostname + alias badge + edit + reset + chip
            HStack(spacing: 8) {
                StatusDot(status: daemon.online ? "online" : "offline")

                // Hostname — flex:1 + truncation (matches CSS flex:1 min-width:0 ellipsis)
                Text(daemon.displayName)
                    .font(PCFont.body(17, weight: .semibold))
                    .foregroundStyle(Color.pcFg)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .frame(maxWidth: .infinity, alignment: .leading)

                if hasAlias {
                    Text("别名")
                        .font(PCFont.body(11, weight: .medium))
                        .foregroundStyle(Color.pcAccent)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1)
                        .background(Color.pcAccentSubtle)
                        .cornerRadius(4)
                        .flexShrink(false)
                }

                // Edit button — no background, fgTertiary (matches CSS: border:none, opacity controlled)
                Button {
                    withAnimation(.easeInOut(duration: 0.15)) {
                        isEditing = true
                    }
                    editText = daemon.alias ?? ""
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                        isInputFocused = true
                    }
                } label: {
                    Image(systemName: "pencil")
                        .font(.system(size: 14))
                        .foregroundStyle(Color.pcFgTertiary)
                        .padding(.horizontal, 4)
                        .padding(.vertical, 2)
                }
                .buttonStyle(.plain)

                // Reset button — only when has alias (matches CSS: fgTertiary, hover→accent)
                if hasAlias {
                    Button {
                        onSetAlias(nil)
                    } label: {
                        Text("恢复默认")
                            .font(PCFont.body(11))
                            .foregroundStyle(Color.pcFgTertiary)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                    }
                    .buttonStyle(.plain)
                }

                StatusChip(
                    text: daemon.online ? "在线" : "离线",
                    style: .status(daemon.online ? "running" : "offline")
                )
            }
            .padding(.horizontal, PCSpacing.lg)
            .padding(.top, PCSpacing.lg)
            .padding(.bottom, PCSpacing.sm)

            // Inline rename row — with fadeSlideIn animation
            if isEditing {
                HStack(spacing: 6) {
                    TextField("输入别名…", text: $editText)
                        .font(PCFont.body(15))
                        .foregroundStyle(Color.pcFg)
                        .focused($isInputFocused)
                        .onSubmit { confirmRename() }
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .background(Color.pcBackground)
                        .overlay(
                            RoundedRectangle(cornerRadius: 6)
                                .stroke(isInputFocused ? Color.pcAccent : Color.pcBorder, lineWidth: 1)
                        )

                    Button { confirmRename() } label: {
                        Image(systemName: "checkmark")
                            .font(.system(size: 16, weight: .semibold))
                            .padding(4)
                    }
                    .buttonStyle(RenameActionButtonStyle(pressedColor: .pcSuccess))

                    Button { cancelRename() } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 16, weight: .semibold))
                            .padding(4)
                    }
                    .buttonStyle(RenameActionButtonStyle(pressedColor: .pcError))
                }
                .padding(.horizontal, PCSpacing.lg)
                .padding(.bottom, PCSpacing.sm)
                .transition(.opacity.combined(with: .move(edge: .top)))
            }

            // Info row — left-aligned with gap (matches CSS: flex + gap:space-md, no justify-content)
            HStack(spacing: PCSpacing.md) {
                if !agentTags.isEmpty {
                    Text(agentTags.joined(separator: ", "))
                        .font(PCFont.body(14))
                        .foregroundStyle(Color.pcFgTertiary)
                }

                if activeSessions > 0 {
                    Text("\(activeSessions) 个活跃会话")
                        .font(PCFont.body(14, weight: .medium))
                        .foregroundStyle(Color.pcAccent)
                } else {
                    Text("0 个会话")
                        .font(PCFont.body(14))
                        .foregroundStyle(Color.pcFgTertiary)
                }
            }
            .padding(.horizontal, PCSpacing.lg)
            .padding(.bottom, PCSpacing.sm)

            // Bottom row
            HStack {
                if let lastActivity {
                    Text("最后活跃: \(lastActivity)")
                        .font(PCFont.body(13))
                        .foregroundStyle(Color.pcFgSecondary)
                }
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.system(size: 14))
                    .foregroundStyle(Color.pcFgTertiary)
            }
            .padding(.horizontal, PCSpacing.lg)
            .padding(.bottom, PCSpacing.lg)
        }
        .background(Color.pcSurface)
        .cornerRadius(PCRadius.lg)
        .overlay(
            RoundedRectangle(cornerRadius: PCRadius.lg)
                .stroke(Color.pcBorder, lineWidth: 1)
        )
        .contentShape(Rectangle())
        .onTapGesture {
            guard !isEditing else { return }
            onTap()
        }
    }

    private func confirmRename() {
        let trimmed = editText.trimmingCharacters(in: .whitespacesAndNewlines)
        withAnimation(.easeInOut(duration: 0.15)) {
            isEditing = false
            isInputFocused = false
        }
        onSetAlias(trimmed.isEmpty ? nil : trimmed)
    }

    private func cancelRename() {
        withAnimation(.easeInOut(duration: 0.15)) {
            isEditing = false
            isInputFocused = false
        }
    }
}

// MARK: - View flex shrink helper

private extension View {
    /// Prevent this view from shrinking below its ideal size in an HStack
    func flexShrink(_ shrink: Bool) -> some View {
        if shrink {
            return AnyView(self)
        } else {
            return AnyView(self.frame(minWidth: 0, alignment: .leading))
        }
    }
}

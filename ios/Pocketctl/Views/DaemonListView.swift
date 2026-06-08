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
                Text("M")
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
                    lastActivity: vm.lastActivity(for: daemon.daemonId)
                ) {
                    navigateToSessionList = daemon
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

// MARK: - Daemon Card

struct DaemonCard: View {
    let daemon: Daemon
    let activeSessions: Int
    let lastActivity: String?
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            VStack(alignment: .leading, spacing: 8) {
                // Top row: status + hostname + chip
                HStack(spacing: 8) {
                    StatusDot(status: daemon.online ? "online" : "offline")
                    Text(daemon.hostname)
                        .font(PCFont.body(17, weight: .semibold))
                        .foregroundStyle(Color.pcFg)
                    StatusChip(
                        text: daemon.online ? "在线" : "离线",
                        style: .status(daemon.online ? "running" : "offline")
                    )
                }

                // Info row: agents + session count
                HStack {
                    if !daemon.agents.isEmpty {
                        Text(daemon.agents.joined(separator: ", "))
                            .font(PCFont.body(14))
                            .foregroundStyle(Color.pcFgTertiary)
                    }

                    Spacer()

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

                // Bottom row: last activity + chevron
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
            }
            .padding(PCSpacing.lg)
            .background(Color.pcSurface)
            .cornerRadius(PCRadius.lg)
            .overlay(
                RoundedRectangle(cornerRadius: PCRadius.lg)
                    .stroke(Color.pcBorder, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
    }
}

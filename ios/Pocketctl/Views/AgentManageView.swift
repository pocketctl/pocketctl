import SwiftUI

/// Agent management page (restores `agent-manage.html`): per-agent version /
/// latest / upgrade status, one-tap upgrade, and per-daemon-agent default
/// working-directory config (no model picker — models are chosen live at
/// session-create time). The "添加 Agent" button is intentionally absent.
struct AgentManageView: View {
    let daemonId: String
    let wsService: WebSocketService
    let apiClient: APIClient
    var activeSessionsByAgent: [String: Int] = [:]

    @State private var viewModel: AgentManageViewModel?
    @State private var configAgent: AgentInfo?
    @State private var configSheetHeight: CGFloat = 260

    var body: some View {
        ZStack {
            Color.pcBackground.ignoresSafeArea()

            ScrollView {
                VStack(spacing: PCSpacing.lg) {
                    if let vm = viewModel {
                        hostBar(vm: vm)
                        filterBar(vm: vm)
                        agentsList(vm: vm)
                    } else {
                        ProgressView()
                            .frame(maxWidth: .infinity, minHeight: 200)
                    }
                }
                .padding(.horizontal, PCSpacing.lg)
                .padding(.top, PCSpacing.md)
                .padding(.bottom, PCSpacing.xxxxl)
            }
        }
        .navigationTitle("Agent 管理")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            if viewModel == nil {
                let vm = AgentManageViewModel(daemonId: daemonId, wsService: wsService, apiClient: apiClient)
                vm.activeSessionsByAgent = activeSessionsByAgent
                viewModel = vm
                await vm.load()
                vm.startListening()
            }
        }
        .onDisappear { viewModel?.stopListening() }
        .sheet(item: $configAgent) { agent in
            AgentConfigSheet(daemonId: daemonId, agent: agent, onHeightChange: { configSheetHeight = max($0 + 40, 200) })
                .presentationDetents([.height(configSheetHeight)])
        }
    }

    // MARK: - Host bar

    @ViewBuilder
    private func hostBar(vm: AgentManageViewModel) -> some View {
        if let daemon = vm.daemon {
            HStack(spacing: PCSpacing.sm) {
                Circle()
                    .fill(daemon.online ? Color.pcSuccess : Color.pcFgTertiary)
                    .frame(width: 8, height: 8)
                Text(daemon.displayName)
                    .font(PCFont.body(15, weight: .semibold))
                    .foregroundStyle(Color.pcFg)
                Spacer()
                Text(hostMeta(daemon))
                    .font(PCFont.mono(12))
                    .foregroundStyle(Color.pcFgTertiary)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(Color.pcSurface)
            .overlay(RoundedRectangle(cornerRadius: PCRadius.lg).stroke(Color.pcBorder, lineWidth: 1))
            .cornerRadius(PCRadius.lg)
        }
    }

    private func hostMeta(_ daemon: Daemon) -> String {
        var parts: [String] = []
        if let ip = daemon.ip, !ip.isEmpty, ip != "unknown" { parts.append(ip) }
        if let os = daemon.os, !os.isEmpty, os != "unknown" { parts.append(os) }
        return parts.isEmpty ? daemon.hostname : parts.joined(separator: " · ")
    }

    // MARK: - Section header + filter

    @ViewBuilder
    private func filterBar(vm: AgentManageViewModel) -> some View {
        HStack(spacing: 6) {
            Text("已安装 Agent（\(vm.daemon?.agents.count ?? 0)）")
                .font(PCFont.body(13, weight: .semibold))
                .foregroundStyle(Color.pcFgSecondary)
            Spacer()
            HStack(spacing: 4) {
                ForEach(AgentFilter.allCases) { f in
                    Button { vm.filter = f } label: {
                        Text(f.title)
                            .font(PCFont.mono(11))
                            .foregroundStyle(vm.filter == f ? Color.pcBackground : Color.pcAccent)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 4)
                            .background(vm.filter == f ? Color.pcAccent : Color.pcAccentMuted)
                            .cornerRadius(6)
                    }
                }
            }
        }
    }

    // MARK: - Agents list

    @ViewBuilder
    private func agentsList(vm: AgentManageViewModel) -> some View {
        VStack(spacing: PCSpacing.sm) {
            if vm.visibleAgents.isEmpty {
                Text(vm.filter == .upgrade ? "没有可升级的 Agent" : "该主机未上报 Agent")
                    .font(PCFont.body(14))
                    .foregroundStyle(Color.pcFgTertiary)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, PCSpacing.xl)
            } else {
                ForEach(vm.visibleAgents) { agent in
                    AgentCard(
                        agent: agent,
                        activeSessions: vm.activeSessionCount(for: agent),
                        totalToken: vm.daemonToken?.total,
                        todayToken: vm.daemonToken?.today,
                        cacheToken: vm.daemonCacheTotal,
                        isUpgrading: vm.upgradingAgents.contains(agent.type),
                        onUpgrade: { vm.upgrade(agent: agent) },
                        onConfig: { configAgent = agent }
                    )
                }
            }
        }
    }
}

// MARK: - Agent Card

private struct AgentCard: View {
    let agent: AgentInfo
    let activeSessions: Int
    let totalToken: Int?
    let todayToken: Int?
    let cacheToken: Int?
    let isUpgrading: Bool
    let onUpgrade: () -> Void
    let onConfig: () -> Void

    private var visual: (abbrev: String, color: Color) { agentVisual(agent.type) }

    var body: some View {
        VStack(alignment: .leading, spacing: PCSpacing.sm) {
            // Head: icon + name + status
            HStack(spacing: 10) {
                Text(visual.abbrev)
                    .font(PCFont.body(13, weight: .bold))
                    .foregroundStyle(visual.color)
                    .frame(width: 36, height: 36)
                    .background(visual.color.opacity(0.15))
                    .cornerRadius(9)
                VStack(alignment: .leading, spacing: 2) {
                    Text(displayAgentName(agent.type))
                        .font(PCFont.body(15, weight: .semibold))
                        .foregroundStyle(Color.pcFg)
                    statusLabel
                }
                Spacer()
            }

            Divider().background(Color.pcBorder)

            versionRow

            if totalToken != nil {
                Divider().background(Color.pcBorder)
                tokenMini
            }

            HStack(spacing: PCSpacing.sm) {
                upgradeButton
                Button { onConfig() } label: {
                    Text("配置")
                        .font(PCFont.body(14))
                        .foregroundStyle(Color.pcFgSecondary)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                        .overlay(RoundedRectangle(cornerRadius: PCRadius.md).stroke(Color.pcBorder, lineWidth: 1))
                        .cornerRadius(PCRadius.md)
                }
            }
            .padding(.top, 4)
        }
        .padding(16)
        .background(Color.pcSurface)
        .overlay(RoundedRectangle(cornerRadius: PCRadius.lg).stroke(Color.pcBorder, lineWidth: 1))
        .cornerRadius(PCRadius.lg)
    }

    private var statusLabel: some View {
        HStack(spacing: 4) {
            Circle()
                .fill(activeSessions > 0 ? Color.pcSuccess : Color.pcFgTertiary)
                .frame(width: 6, height: 6)
            Text(activeSessions > 0 ? "运行中 · \(activeSessions) 个活跃会话" : "空闲 · 0 个活跃会话")
                .font(PCFont.body(12))
                .foregroundStyle(activeSessions > 0 ? Color.pcSuccess : Color.pcFgTertiary)
        }
    }

    @ViewBuilder
    private var versionRow: some View {
        if agent.canUpgrade {
            VStack(alignment: .leading, spacing: 4) {
                versionLine(label: "当前版本", value: "v\(agent.version)", color: .pcFg)
                HStack(spacing: 6) {
                    versionLine(label: "最新版本", value: "v\(agent.latest)", color: .pcSuccess)
                    Spacer()
                    Text("可升级")
                        .font(PCFont.body(11, weight: .semibold))
                        .foregroundStyle(Color.pcWarning)
                }
            }
        } else if !agent.version.isEmpty {
            versionLine(
                label: "当前版本",
                value: agent.latest.isEmpty ? "v\(agent.version)" : "v\(agent.version) ✓ 最新",
                color: agent.latest.isEmpty ? .pcFg : .pcSuccess
            )
        } else {
            versionLine(label: "当前版本", value: "版本未知", color: .pcFgTertiary)
        }
    }

    private func versionLine(label: String, value: String, color: Color) -> some View {
        HStack(spacing: 6) {
            Text(label)
                .font(PCFont.body(12))
                .foregroundStyle(Color.pcFgTertiary)
                .frame(width: 56, alignment: .leading)
            Text(value)
                .font(PCFont.mono(13, weight: .medium))
                .foregroundStyle(color)
        }
    }

    private var tokenMini: some View {
        HStack(spacing: 12) {
            tokenItem(value: totalToken.map(formatTokens) ?? "—", label: "总 Token")
            tokenItem(value: todayToken.map(formatTokens) ?? "—", label: "今日")
            tokenItem(value: cacheToken.map(formatTokens) ?? "—", label: "Cache 命中")
            Spacer()
        }
    }

    private func tokenItem(value: String, label: String) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(value)
                .font(PCFont.mono(14, weight: .semibold))
                .foregroundStyle(Color.pcFg)
            Text(label)
                .font(PCFont.body(10))
                .foregroundStyle(Color.pcFgTertiary)
        }
    }

    @ViewBuilder
    private var upgradeButton: some View {
        if agent.canUpgrade {
            Button { onUpgrade() } label: {
                Group {
                    if isUpgrading {
                        HStack(spacing: 4) { ProgressView().tint(Color.pcAccent); Text("升级中…") }
                    } else {
                        Text("升级到 v\(agent.latest)")
                    }
                }
                .font(PCFont.body(14, weight: .semibold))
                .foregroundStyle(isUpgrading ? Color.pcAccent.opacity(0.6) : Color.pcAccent)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 10)
                .background(Color.pcAccentMuted)
                .overlay(RoundedRectangle(cornerRadius: PCRadius.md).stroke(Color.pcAccent, lineWidth: 1))
                .cornerRadius(PCRadius.md)
            }
            .disabled(isUpgrading)
        } else {
            Text("已是最新")
                .font(PCFont.body(14))
                .foregroundStyle(Color.pcFgTertiary)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 10)
                .overlay(RoundedRectangle(cornerRadius: PCRadius.md).stroke(Color.pcBorder, lineWidth: 1))
                .cornerRadius(PCRadius.md)
        }
    }
}

// MARK: - Config Sheet (working directory only — no model picker)

/// Measures the config sheet's intrinsic content height for an auto-fitting detent.
private struct ConfigSheetHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

private struct AgentConfigSheet: View {
    let daemonId: String
    let agent: AgentInfo
    let onHeightChange: (CGFloat) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var workdir: String = ""

    var body: some View {
        VStack(spacing: 0) {
            // Drag handle — matches DaemonActionSheet
            RoundedRectangle(cornerRadius: 3)
                .fill(Color.pcFgTertiary)
                .frame(width: 36, height: 5)
                .padding(.top, 16).padding(.bottom, 16)

            VStack(spacing: 16) {
                Text("\(displayAgentName(agent.type)) 配置")
                    .font(PCFont.display(20, weight: .semibold))
                    .foregroundStyle(Color.pcFg)
                    .frame(maxWidth: .infinity, alignment: .leading)

                VStack(alignment: .leading, spacing: 6) {
                    Text("工作目录")
                        .font(PCFont.body(13))
                        .foregroundStyle(Color.pcFgTertiary)
                    TextField("/path/to/project", text: $workdir)
                        .font(PCFont.mono(14))
                        .foregroundStyle(Color.pcFg)
                        .padding(12)
                        .background(Color.pcBackground)
                        .overlay(RoundedRectangle(cornerRadius: PCRadius.md).stroke(Color.pcBorder, lineWidth: 1))
                        .cornerRadius(PCRadius.md)
                }

                Button {
                    AgentDefaultsStore.setCwd(daemonId: daemonId, agentType: agent.type, cwd: workdir)
                    dismiss()
                } label: {
                    Text("保存")
                        .font(PCFont.display(17, weight: .semibold))
                        .foregroundStyle(Color.pcBackground)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 16)
                        .background(Color.pcAccent)
                        .cornerRadius(PCRadius.md)
                }
            }
        }
        .padding(.horizontal, PCSpacing.xxl)
        .background(
            GeometryReader { proxy in
                Color.clear.preference(key: ConfigSheetHeightKey.self, value: proxy.size.height)
            }
        )
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(Color.pcSurface)
        .onPreferenceChange(ConfigSheetHeightKey.self) { onHeightChange($0) }
        .onAppear {
            workdir = AgentDefaultsStore.getCwd(daemonId: daemonId, agentType: agent.type) ?? ""
        }
    }
}

// MARK: - Shared helpers (also used by other screens in this change)

/// Agent type → (icon abbreviation, brand color).
func agentVisual(_ type: String) -> (abbrev: String, color: Color) {
    switch type.lowercased() {
    case "claude-code", "claude_code": return ("CC", .pcAccent)
    case "codex": return ("Cx", .pcSuccess)
    case "opencode", "open_code": return ("OC", .pcSubAgent)
    case "cursor": return ("Cu", .pcWarning)
    default: return (String(type.prefix(2)).uppercased(), .pcAccent)
    }
}

func displayAgentName(_ raw: String) -> String {
    switch raw.lowercased() {
    case "claude-code", "claude_code": return "Claude Code"
    case "codex": return "Codex"
    case "opencode", "open_code": return "OpenCode"
    default:
        return raw.split(separator: "-")
            .map { $0.prefix(1).uppercased() + $0.dropFirst() }
            .joined(separator: " ")
    }
}

/// Human-readable token count: 1.25M / 48K / 950.
func formatTokens(_ n: Int) -> String {
    if n >= 1_000_000 { return String(format: "%.1fM", Double(n) / 1_000_000) }
    if n >= 1_000 { return String(format: "%.0fK", Double(n) / 1_000) }
    return "\(n)"
}

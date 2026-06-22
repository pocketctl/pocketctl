import Foundation

/// Filter for the agent list on the Agent Manage page.
enum AgentFilter: String, CaseIterable, Identifiable {
    case all
    case upgrade

    var id: String { rawValue }

    var title: String {
        switch self {
        case .all: return "全部"
        case .upgrade: return "可升级"
        }
    }
}

/// View model for `AgentManageView`. Holds a daemon's installed agents (with
/// version info from `daemon_status`), per-agent active-session counts, the
/// daemon-level token totals, in-flight upgrade state, and the current filter.
///
/// Agent-level token breakdown is not available from the backend (see design
/// Risks); token figures shown are daemon-level totals.
@Observable
@MainActor
final class AgentManageViewModel {
    let daemonId: String
    private let wsService: WebSocketService
    private let apiClient: APIClient

    /// Active session counts keyed by agent_type, supplied by the parent
    /// (computed from its session list).
    var activeSessionsByAgent: [String: Int] = [:]

    /// Latest daemon snapshot (agents carry version/latest from daemon_status).
    private(set) var daemon: Daemon?

    /// Daemon-level token totals (lazily fetched).
    private(set) var daemonToken: TokensByDaemon?

    /// Agent types whose upgrade is in flight (optimistic loading).
    private(set) var upgradingAgents: Set<String> = []

    var upgradeError: String?
    var filter: AgentFilter = .all

    private var eventListenerId: String?

    init(daemonId: String, wsService: WebSocketService, apiClient: APIClient) {
        self.daemonId = daemonId
        self.wsService = wsService
        self.apiClient = apiClient
    }

    /// Daemon-level cache total (sum of session cache reads/creates), if loaded.
    /// Agent-level token breakdown isn't available; cards show daemon-level totals.
    var daemonCacheTotal: Int? {
        guard let sessions = daemonToken?.sessions, !sessions.isEmpty else { return nil }
        return sessions.reduce(0) { $0 + $1.tokCacheRead + $1.tokCacheCreate }
    }

    /// Agents after applying the current filter.
    var visibleAgents: [AgentInfo] {
        let all = daemon?.agents ?? []
        switch filter {
        case .all: return all
        case .upgrade: return all.filter { $0.canUpgrade }
        }
    }

    var upgradableCount: Int {
        (daemon?.agents ?? []).filter { $0.canUpgrade }.count
    }

    func activeSessionCount(for agent: AgentInfo) -> Int {
        activeSessionsByAgent[agent.type] ?? 0
    }

    /// Initial load: sync daemon snapshot + fetch daemon-level token totals.
    func load() async {
        daemon = wsService.daemons[daemonId]
        daemonToken = try? await apiClient.getTokensByDaemon(daemonId: daemonId)
    }

    /// Begin listening for daemon_status (version refresh) + upgrade_result events.
    func startListening() {
        if eventListenerId == nil {
            eventListenerId = wsService.addEventListener { [weak self] dict in
                Task { @MainActor in self?.handleEvent(dict) }
            }
        }
    }

    func stopListening() {
        if let id = eventListenerId {
            wsService.removeEventListener(id)
            eventListenerId = nil
        }
    }

    /// Trigger an agent upgrade. Optimistically marks the agent as upgrading;
    /// the version row updates when `upgrade_result` arrives.
    func upgrade(agent: AgentInfo) {
        upgradingAgents.insert(agent.type)
        upgradeError = nil
        Task {
            do {
                _ = try await apiClient.upgradeAgent(daemonId: daemonId, agent: agent.type)
                // Success of the HTTP call just means relay forwarded the request;
                // actual version bump arrives via upgrade_result / daemon_status.
            } catch {
                upgradingAgents.remove(agent.type)
                upgradeError = error.localizedDescription
            }
        }
    }

    private func handleEvent(_ dict: [String: Any]) {
        guard let event = WebSocketEvent(dict: dict) else { return }
        switch event.type {
        case .daemonStatus:
            if event.daemonId == daemonId {
                daemon = wsService.daemons[daemonId]
                // If any upgrading agent now matches latest, clear its loading state.
                if let agents = daemon?.agents {
                    upgradingAgents = upgradingAgents.filter { type in
                        agents.first { $0.type == type }.map { $0.canUpgrade } ?? true
                    }
                }
            }
        case .upgradeResult:
            // Clear loading for the targeted agent; daemon_status will carry the new version.
            if let agent = event.agent {
                upgradingAgents.remove(agent)
            }
            daemon = wsService.daemons[daemonId]
        default:
            break
        }
    }
}

import Foundation

@Observable
@MainActor
final class DaemonListViewModel {
    var daemons: [Daemon] = []
    var sessions: [Session] = []
    var isLoading = false
    var error: String?

    /// Whether the initial connect() has completed successfully
    private(set) var isConnected = false

    /// Called when auth is expired and refresh also fails — caller should redirect to login
    var onAuthExpired: (() -> Void)?

    private let wsService: WebSocketService
    private let apiClient: APIClient
    private var eventListenerId: String?

    init(wsService: WebSocketService, apiClient: APIClient) {
        self.wsService = wsService
        self.apiClient = apiClient
    }

    /// Connect and load data
    func connect() async {
        guard KeychainStorage.accessToken != nil else { return }

        isLoading = true
        error = nil

        // Refresh token before connecting to handle expired access tokens
        var token: String
        if let refreshToken = KeychainStorage.refreshToken {
            do {
                let resp = try await apiClient.refreshToken(refreshToken)
                KeychainStorage.accessToken = resp.access_token
                KeychainStorage.refreshToken = resp.refresh_token
                token = resp.access_token
            } catch {
                // Refresh failed — tokens fully expired, redirect to login
                onAuthExpired?()
                isLoading = false
                return
            }
        } else {
            guard let t = KeychainStorage.accessToken else {
                onAuthExpired?()
                isLoading = false
                return
            }
            token = t
        }

        // Build WebSocket URL
        let wsURL = apiClient.baseURL
            .replacingOccurrences(of: "https://", with: "wss://")
            .replacingOccurrences(of: "http://", with: "ws://")
            + "/ws"

        // Register event listener (multi-listener, won't be overwritten by child views)
        if let existingId = eventListenerId {
            wsService.removeEventListener(existingId)
        }
        eventListenerId = wsService.addEventListener { [weak self] dict in
            self?.handleEvent(dict)
        }

        // Register auth failure handler for WebSocket-level token rejection
        wsService.onAuthFailure = { [weak self] in
            self?.handleAuthFailure()
        }

        // Connect
        wsService.connect(url: wsURL, token: token)

        // Wait a moment for connection, then request sessions
        try? await Task.sleep(for: .milliseconds(800))
        wsService.send(["type": "list_sessions"])

        isConnected = true
        isLoading = false
    }

    /// Handle WebSocket-level auth failure — try refresh once more, then give up
    private func handleAuthFailure() {
        Task {
            if let refreshToken = KeychainStorage.refreshToken,
               let resp = try? await apiClient.refreshToken(refreshToken) {
                KeychainStorage.accessToken = resp.access_token
                KeychainStorage.refreshToken = resp.refresh_token
                // Reconnect with fresh token
                let wsURL = apiClient.baseURL
                    .replacingOccurrences(of: "https://", with: "wss://")
                    .replacingOccurrences(of: "http://", with: "ws://")
                    + "/ws"
                wsService.connect(url: wsURL, token: resp.access_token)
                try? await Task.sleep(for: .milliseconds(800))
                wsService.send(["type": "list_sessions"])
            } else {
                // Everything failed — clear tokens and redirect to login
                KeychainStorage.clearAll()
                onAuthExpired?()
            }
        }
    }

    func disconnect() {
        if let id = eventListenerId {
            wsService.removeEventListener(id)
            eventListenerId = nil
        }
        wsService.disconnect()
    }

    /// Re-register event handler and request fresh session list.
    /// Called on .onAppear when returning from a child view.
    func refresh() {
        // Re-register if needed (e.g. after child view overwrote handler)
        if eventListenerId == nil {
            eventListenerId = wsService.addEventListener { [weak self] dict in
                self?.handleEvent(dict)
            }
        }
        wsService.onAuthFailure = { [weak self] in
            self?.handleAuthFailure()
        }
        if wsService.isConnected {
            wsService.send(["type": "list_sessions"])
        } else {
            // Connection lost — reconnect, then request sessions
            Task { [weak self] in
                await self?.connect()
            }
        }
    }

    /// Number of online daemons
    var onlineCount: Int {
        daemons.filter { $0.online }.count
    }

    /// Get active session count for a daemon
    func activeSessionCount(for daemonId: String) -> Int {
        sessions.filter { $0.daemonId == daemonId && !$0.isTerminal }.count
    }

    /// Get unique agent type display names for a daemon's active sessions
    func agentTags(for daemonId: String) -> [String] {
        let types = Set(
            sessions
                .filter { $0.daemonId == daemonId && !$0.isTerminal }
                .map(\.agentType)
                .filter { !$0.isEmpty }
        )
        return types.sorted().map { Self.displayAgentName($0) }
    }

    /// Map raw agent_type to human-readable display name
    static func displayAgentName(_ raw: String) -> String {
        switch raw.lowercased() {
        case "claude-code", "claude_code": return "Claude Code"
        case "codex": return "Codex"
        case "opencode", "open_code": return "OpenCode"
        default:
            // Capitalize first letter of each word as fallback
            return raw.split(separator: "-")
                .map { $0.prefix(1).uppercased() + $0.dropFirst() }
                .joined(separator: " ")
        }
    }

    /// Get last activity time for a daemon
    func lastActivity(for daemonId: String) -> String? {
        sessions
            .filter { $0.daemonId == daemonId }
            .compactMap { $0.lastActivityAt ?? $0.createdAt }
            .max()
            .map { RelativeTime.format($0) }
    }

    /// Set alias for a daemon (optimistic update + API call)
    func setAlias(daemonId: String, alias: String?) {
        // Optimistic local update
        guard let index = daemons.firstIndex(where: { $0.daemonId == daemonId }) else { return }
        let trimmedAlias = alias?.trimmingCharacters(in: .whitespacesAndNewlines)
        let finalAlias = (trimmedAlias?.isEmpty ?? true) ? nil : trimmedAlias
        daemons[index].alias = finalAlias

        // Update local cache
        var cached = KeychainStorage.daemonAliases
        if let a = finalAlias {
            cached[daemonId] = a
        } else {
            cached.removeValue(forKey: daemonId)
        }
        KeychainStorage.daemonAliases = cached

        // Re-sort with new display name
        daemons.sort { ($0.alias ?? $0.hostname) < ($1.alias ?? $1.hostname) }

        // API call in background
        Task {
            do {
                _ = try await apiClient.setDaemonAlias(daemonId: daemonId, alias: finalAlias)
            } catch {
                print("[alias] failed to save alias: \(error)")
                // Roll back on failure
                var rollbackCached = KeychainStorage.daemonAliases
                rollbackCached.removeValue(forKey: daemonId)
                KeychainStorage.daemonAliases = rollbackCached
            }
        }
    }

    // MARK: - Event handling

    private func handleEvent(_ dict: [String: Any]) {
        guard let event = WebSocketEvent(dict: dict) else { return }

        switch event.type {
        case .sessionList:
            if let sessionDicts = event.sessions {
                let newSessions = sessionDicts.compactMap { Session.from(dict: $0) }
                mergeSessions(newSessions)
                buildDaemonList()
            }

        case .daemonStatus:
            if let daemon = Daemon.from(event: dict) {
                if let index = daemons.firstIndex(where: { $0.daemonId == daemon.daemonId }) {
                    daemons[index] = daemon
                } else {
                    daemons.append(daemon)
                }
            }

        case .sessionStatus:
            if let sid = event.sessionId,
               let index = sessions.firstIndex(where: { $0.sessionId == sid }) {
                sessions[index].status = event.status ?? sessions[index].status
                sessions[index].exitReason = event.exitReason ?? sessions[index].exitReason
            }

        case .sessionCreated, .sessionDiscovered:
            if let session = Session.from(dict: dict) {
                if !sessions.contains(where: { $0.sessionId == session.sessionId }) {
                    sessions.insert(session, at: 0)
                }
                buildDaemonList()
            }

        case .sessionIdChanged:
            if let newId = event.sessionId,
               let oldId = dict["old_session_id"] as? String,
               let index = sessions.firstIndex(where: { $0.sessionId == oldId }) {
                // Update session ID — need to create new Session with updated ID
                var updated = sessions[index]
                // Session is a struct, we can't mutate the ID directly
                // For now, remove old and insert new with correct ID
                sessions.remove(at: index)
            }

        case .sessionTitleUpdate:
            if let sid = event.sessionId,
               let index = sessions.firstIndex(where: { $0.sessionId == sid }) {
                sessions[index].title = event.title
            }

        default:
            break
        }
    }

    /// Build daemon list from sessions + daemon_status events
    private func buildDaemonList() {
        var daemonMap = wsService.daemons
        // Also add daemons from sessions that we haven't seen daemon_status for
        for session in sessions {
            if daemonMap[session.daemonId] == nil {
                daemonMap[session.daemonId] = Daemon(
                    daemonId: session.daemonId,
                    hostname: session.hostname ?? session.daemonId,
                    agents: [],
                    online: session.daemonOnline,
                    lastSeenAt: nil
                )
            }
        }
        // Update online status from sessions
        for (id, var daemon) in daemonMap {
            if wsService.daemons[id] == nil {
                daemon.online = sessions.contains { $0.daemonId == id && $0.daemonOnline }
            }
            daemonMap[id] = daemon
        }
        daemons = Array(daemonMap.values).sorted { ($0.alias ?? $0.hostname) < ($1.alias ?? $1.hostname) }
    }

    /// Merge new sessions into existing list with minimal changes.
    private func mergeSessions(_ newSessions: [Session]) {
        let newMap = Dictionary(uniqueKeysWithValues: newSessions.map { ($0.sessionId, $0) })
        for newSession in newSessions {
            if let index = sessions.firstIndex(where: { $0.sessionId == newSession.sessionId }) {
                if !sessions[index].contentEquals(newSession) {
                    sessions[index] = newSession
                }
            } else {
                sessions.append(newSession)
            }
        }
        sessions.removeAll { newMap[$0.sessionId] == nil }
    }
}

import Foundation

@Observable
@MainActor
final class SessionListViewModel {
    var sessions: [Session] = []
    var isLoading = false
    var error: String?
    var showError = false

    /// Whether the initial connect() has completed successfully
    private(set) var isConnected = false

    /// 分批渲染：当前可见的最大卡片数
    private(set) var visibleCount = 5

    let daemon: Daemon
    private let wsService: WebSocketService
    private let apiClient: APIClient
    private var eventListenerId: String?

    init(daemon: Daemon, wsService: WebSocketService, apiClient: APIClient, initialSessions: [Session] = []) {
        self.daemon = daemon
        self.wsService = wsService
        self.apiClient = apiClient
        self.sessions = initialSessions
    }

    /// Filtered sessions for this daemon
    var filteredSessions: [Session] {
        sessions
            .filter { $0.daemonId == daemon.daemonId }
            .sorted { lhs, rhs in
                let l = lhs.lastActivityAt ?? lhs.createdAt
                let r = rhs.lastActivityAt ?? rhs.createdAt
                return l > r
            }
    }

    /// 分批渲染：只返回当前可见数量的 session
    var displayedSessions: [Session] {
        let all = filteredSessions
        guard visibleCount < all.count else { return all }
        return Array(all.prefix(visibleCount))
    }

    /// 滚动到底部附近时追加下一批
    func loadMoreIfNeeded(currentIndex: Int) {
        let total = filteredSessions.count
        guard currentIndex >= visibleCount - 2, visibleCount < total else { return }
        visibleCount = min(visibleCount + 5, total)
    }

    var daemonStatusText: String {
        let status = daemon.online ? "在线" : "离线"
        return status
    }

    var heartbeatText: String? {
        // TODO: track last heartbeat time
        return daemon.online ? "刚刚" : nil
    }

    /// Connect and load sessions
    func connect() async {
        guard let token = KeychainStorage.accessToken else { return }

        isLoading = true
        error = nil

        let wsURL = RelayEnvironmentManager.shared.current.wsBaseURL

        eventListenerId = wsService.addEventListener { [weak self] dict in
            self?.handleEvent(dict)
        }

        if !wsService.isConnected {
            wsService.connect(url: wsURL, token: token)
        }

        try? await Task.sleep(for: .milliseconds(500))
        wsService.send(["type": "list_sessions"])

        isConnected = true
        isLoading = false
    }

    func disconnect() {
        if let id = eventListenerId {
            wsService.removeEventListener(id)
            eventListenerId = nil
        }
    }

    /// Re-register event handler and request fresh session list.
    /// Called on .onAppear when returning from a child view.
    func refresh() {
        if eventListenerId == nil {
            eventListenerId = wsService.addEventListener { [weak self] dict in
                self?.handleEvent(dict)
            }
        }
        wsService.send(["type": "list_sessions"])
    }

    /// Delete a session (only for exited/completed sessions)
    func deleteSession(_ sessionId: String) {
        wsService.send(["type": "session_delete", "session_id": sessionId])
        // Optimistically remove from local list
        sessions.removeAll { $0.sessionId == sessionId }
    }

    /// Create a new session
    func createSession(agent: String, cwd: String, prompt: String) {
        wsService.send([
            "type": "session_create",
            "agent": agent,
            "cwd": cwd,
            "prompt": prompt,
        ])
    }

    // MARK: - Event handling

    private func handleEvent(_ dict: [String: Any]) {
        guard let event = WebSocketEvent(dict: dict) else { return }

        switch event.type {
        case .sessionList:
            if let sessionDicts = event.sessions {
                let newSessions = sessionDicts.compactMap { Session.from(dict: $0) }
                mergeSessions(newSessions)
            }

        case .sessionStatus:
            if let sid = event.sessionId,
               let index = sessions.firstIndex(where: { $0.sessionId == sid }) {
                sessions[index].status = event.status ?? sessions[index].status
                sessions[index].exitReason = event.exitReason ?? sessions[index].exitReason
                sessions[index].lastActivityAt = dict["last_activity_at"] as? String ?? sessions[index].lastActivityAt
            }

        case .sessionCreated:
            if let session = Session.from(dict: dict) {
                if !sessions.contains(where: { $0.sessionId == session.sessionId }) {
                    sessions.insert(session, at: 0)
                }
            }

        case .sessionIdChanged:
            if let newId = event.sessionId,
               let oldId = dict["old_session_id"] as? String,
               let index = sessions.firstIndex(where: { $0.sessionId == oldId }) {
                sessions[index].sessionId = newId
            }

        case .sessionDiscovered:
            if let session = Session.from(dict: dict) {
                if !sessions.contains(where: { $0.sessionId == session.sessionId }) {
                    sessions.insert(session, at: 0)
                }
            }

        case .sessionTitleUpdate:
            if let sid = event.sessionId,
               let index = sessions.firstIndex(where: { $0.sessionId == sid }) {
                sessions[index].title = event.title
            }

        case .sessionDeleted:
            if let sid = event.sessionId {
                sessions.removeAll { $0.sessionId == sid }
            }

        case .error:
            error = event.error ?? "未知错误"
            showError = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in
                self?.showError = false
            }

        default:
            break
        }
    }

    /// Merge new sessions into existing list with minimal changes.
    /// Only updates items that actually changed, avoids full-array flash.
    private func mergeSessions(_ newSessions: [Session]) {
        let newMap = Dictionary(uniqueKeysWithValues: newSessions.map { ($0.sessionId, $0) })

        // Update existing or append new
        for newSession in newSessions {
            if let index = sessions.firstIndex(where: { $0.sessionId == newSession.sessionId }) {
                if !sessions[index].contentEquals(newSession) {
                    sessions[index] = newSession
                }
            } else {
                sessions.append(newSession)
            }
        }

        // Remove sessions that no longer exist
        sessions.removeAll { existing in newMap[existing.sessionId] == nil }
    }
}

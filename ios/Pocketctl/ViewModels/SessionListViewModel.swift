import Foundation

@Observable
@MainActor
final class SessionListViewModel {
    var sessions: [Session] = [] {
        didSet { rebuildSortedSessions() }
    }
    var isLoading = false
    var error: String?
    var showError = false

    /// Whether the initial connect() has completed successfully
    private(set) var isConnected = false

    /// 分批渲染：当前可见的最大卡片数（每页 15 条）
    private(set) var visibleCount = 15

    /// 当前 daemon 过滤 + 按最近活动排序后的会话缓存。
    /// 仅在 sessions 变化时重建一次，避免每次 body 求值都全量 filter+sort。
    private(set) var sortedSessions: [Session] = []

    /// 实际渲染的会话（sortedSessions 的前 visibleCount 条）。
    /// visibleCount 变化时刷新，滚动时不再重排。
    private(set) var displayedSessions: [Session] = []

    let daemon: Daemon
    private let wsService: WebSocketService
    private let apiClient: APIClient
    private var eventListenerId: String?

    init(daemon: Daemon, wsService: WebSocketService, apiClient: APIClient, initialSessions: [Session] = []) {
        self.daemon = daemon
        self.wsService = wsService
        self.apiClient = apiClient
        self.sessions = initialSessions
        rebuildSortedSessions()
    }

    /// 过滤 + 排序 + 切片缓存。仅当 `sessions` 或 `visibleCount` 变化时调用。
    private func rebuildSortedSessions() {
        let sorted = sessions
            .filter { $0.daemonId == daemon.daemonId }
            .sorted { lhs, rhs in
                // 置顶会话优先
                if lhs.pinned != rhs.pinned { return lhs.pinned }
                let l = lhs.lastActivityAt ?? lhs.createdAt
                let r = rhs.lastActivityAt ?? rhs.createdAt
                return l > r
            }
        sortedSessions = sorted
        displayedSessions = visibleCount < sorted.count ? Array(sorted.prefix(visibleCount)) : sorted
    }

    /// 滚动到底部附近时追加下一批（每批 15 条）。
    /// 只读缓存 count，不再每次都 filter+sort。
    func loadMoreIfNeeded(currentIndex: Int) {
        let total = sortedSessions.count
        guard currentIndex >= visibleCount - 2, visibleCount < total else { return }
        visibleCount = min(visibleCount + 15, total)
        rebuildSortedSessions()
    }

    /// 基于当前卡片 sessionId 触发分页（供 ForEach 无 index 时使用）。
    /// 在已显示的全集里定位该 session，靠近末尾即加载下一批。
    func loadMoreIfNeeded(currentSessionId: String) {
        guard let index = sortedSessions.firstIndex(where: { $0.sessionId == currentSessionId }) else { return }
        loadMoreIfNeeded(currentIndex: index)
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

    /// 切换会话置顶状态（置顶/取消置顶）
    func togglePin(_ sessionId: String) {
        guard let index = sessions.firstIndex(where: { $0.sessionId == sessionId }) else { return }
        let newPinned = !sessions[index].pinned
        // 乐观更新本地状态
        sessions[index].pinned = newPinned
        wsService.send([
            "type": "session_pin",
            "session_id": sessionId,
            "pinned": newPinned,
        ])
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

        case .sessionPinned:
            if let sid = event.sessionId,
               let pinned = event.pinned,
               let index = sessions.firstIndex(where: { $0.sessionId == sid }) {
                sessions[index].pinned = pinned
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

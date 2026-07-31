import Foundation

struct Session: Identifiable, Sendable, Hashable, Equatable {
    var sessionId: String  // var to support session_id_changed updates
    let daemonId: String
    let agentType: String
    let cwd: String
    var title: String?
    let source: String  // "daemon" | "terminal" | "web"
    var status: String  // running/busy/retry/idle/exited/completed/error/killed/disconnected
    let createdAt: String
    var updatedAt: String?
    var lastActivityAt: String?
    var turnStartedAt: String?
    var exitReason: String?
    var subagentCount: Int
    var hostname: String?
    var daemonAlias: String?
    var daemonOnline: Bool
    var model: String?
    var activeAgent: String? = nil
    var pinned: Bool = false
    var controlMode: String? = nil
    var capabilities: [String] = []

    // Subagent hierarchy fields (from session_list)
    var parentId: String?
    var isSubagent: Bool = false
    var rootSessionId: String?
    var totalTokens: Int64 = 0
    var children: [SubAgent] = []

    var id: String { sessionId }

    /// Host label for display — alias if set, otherwise hostname.
    var hostDisplayName: String? {
        if let a = daemonAlias, !a.isEmpty { return a }
        return hostname
    }

    static func == (lhs: Session, rhs: Session) -> Bool {
        lhs.sessionId == rhs.sessionId
    }

    /// Full content equality check (for diff-based updates)
    var isContentEqual: Bool {
        // Can't compare self, use tuple comparison
        sessionId == sessionId // placeholder — actual check below
    }

    /// Check if all visible fields match another session
    func contentEquals(_ other: Session) -> Bool {
        sessionId == other.sessionId &&
        status == other.status &&
        (title ?? "") == (other.title ?? "") &&
        lastActivityAt == other.lastActivityAt &&
        turnStartedAt == other.turnStartedAt &&
        exitReason == other.exitReason &&
        subagentCount == other.subagentCount &&
        daemonOnline == other.daemonOnline &&
        hostname == other.hostname &&
        daemonAlias == other.daemonAlias &&
        model == other.model &&
        activeAgent == other.activeAgent &&
        pinned == other.pinned &&
        controlMode == other.controlMode &&
        capabilities == other.capabilities &&
        parentId == other.parentId &&
        isSubagent == other.isSubagent &&
        rootSessionId == other.rootSessionId &&
        totalTokens == other.totalTokens &&
        childrenContentEquals(other.children)
    }

    private func childrenContentEquals(_ otherChildren: [SubAgent]) -> Bool {
        guard children.count == otherChildren.count else { return false }
        return zip(children, otherChildren).allSatisfy { $0.contentEquals($1) }
    }

    func hash(into hasher: inout Hasher) {
        hasher.combine(sessionId)
    }

    var displayTitle: String {
        guard let title = title, !title.isEmpty else {
            return String(sessionId.prefix(8))
        }
        // If title still matches the default pattern, show as-is (includes "Terminal Session-{suffix}")
        return title
    }

    /// 解析后的当前模型名，用于列表展示。空字符串视为无模型（返回 nil，不渲染）。
    /// opencode 的模型形如 "anthropic/claude-sonnet-4"，列表卡片空间有限，
    /// 去掉 provider 前缀只保留 model 名；无前缀的（如 "gpt-5.5"）原样返回。
    var displayModel: String? {
        guard let model, !model.isEmpty else { return nil }
        if let slash = model.firstIndex(of: "/") {
            let tail = String(model[model.index(after: slash)...])
            if !tail.isEmpty { return tail }
        }
        return model
    }

    var isTerminal: Bool {
        ["exited", "completed", "error", "killed"].contains(status)
    }
}

extension Session {
    /// Create from session_list WebSocket event data
    static func from(dict: [String: Any]) -> Session? {
        guard let sessionId = dict["session_id"] as? String,
              let daemonId = dict["daemon_id"] as? String else { return nil }
        var session = Session(
            sessionId: sessionId,
            daemonId: daemonId,
            agentType: dict["agent_type"] as? String ?? "",
            cwd: dict["cwd"] as? String ?? "",
            title: dict["title"] as? String,
            source: dict["source"] as? String ?? "daemon",
            status: dict["status"] as? String ?? "running",
            createdAt: dict["created_at"] as? String ?? "",
            updatedAt: dict["updated_at"] as? String,
            lastActivityAt: dict["last_activity_at"] as? String,
            turnStartedAt: dict["turn_started_at"] as? String,
            exitReason: dict["exit_reason"] as? String,
            subagentCount: dict["subagent_count"] as? Int ?? 0,
            hostname: dict["hostname"] as? String,
            daemonAlias: dict["daemon_alias"] as? String,
            daemonOnline: dict["daemon_online"] as? Bool ?? false,
            model: dict["model"] as? String,
            activeAgent: dict["active_agent"] as? String,
            pinned: dict["pinned"] as? Bool ?? false
        )
        // Subagent hierarchy fields — additive, defaults handle absent keys
        session.parentId = dict["parent_session_id"] as? String
        session.isSubagent = (dict["is_subagent"] as? Bool) ?? false
        session.rootSessionId = dict["root_session_id"] as? String
        session.totalTokens = Int64(dict["totalTokens"] as? Int ?? (dict["total_tokens"] as? Int) ?? 0)
        session.children = (dict["children"] as? [[String: Any]] ?? []).compactMap { SubAgent.from(dict: $0) }
        session.controlMode = dict["control_mode"] as? String
        session.capabilities = dict["capabilities"] as? [String] ?? []
        return session
    }
}

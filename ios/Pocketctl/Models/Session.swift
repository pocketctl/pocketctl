import Foundation

struct Session: Identifiable, Sendable, Hashable, Equatable {
    var sessionId: String  // var to support session_id_changed updates
    let daemonId: String
    let agentType: String
    let cwd: String
    var title: String?
    let source: String  // "daemon" | "terminal" | "web"
    var status: String  // running/busy/idle/exited/completed/error/killed/disconnected
    let createdAt: String
    var updatedAt: String?
    var lastActivityAt: String?
    var exitReason: String?
    var subagentCount: Int
    var hostname: String?
    var daemonAlias: String?
    var daemonOnline: Bool
    var pinned: Bool = false

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
        exitReason == other.exitReason &&
        subagentCount == other.subagentCount &&
        daemonOnline == other.daemonOnline &&
        hostname == other.hostname &&
        pinned == other.pinned
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

    var isTerminal: Bool {
        ["exited", "completed", "error", "killed"].contains(status)
    }
}

extension Session {
    /// Create from session_list WebSocket event data
    static func from(dict: [String: Any]) -> Session? {
        guard let sessionId = dict["session_id"] as? String,
              let daemonId = dict["daemon_id"] as? String else { return nil }
        return Session(
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
            exitReason: dict["exit_reason"] as? String,
            subagentCount: dict["subagent_count"] as? Int ?? 0,
            hostname: dict["hostname"] as? String,
            daemonAlias: dict["daemon_alias"] as? String,
            daemonOnline: dict["daemon_online"] as? Bool ?? false,
            pinned: dict["pinned"] as? Bool ?? false
        )
    }
}

import Foundation

/// Filters the same daemon event when it reaches a detail screen once through
/// live delivery and again through an overlapping history replay.
struct EventDeliveryDeduplicator {
    private struct Identity: Hashable {
        let sessionId: String
        let agentId: String
        let type: String
        let sequence: Int
        let payloadHash: Int
    }

    private let capacity = 2_048
    private var delivered = Set<Identity>()
    private var deliveryOrder: [Identity] = []

    mutating func shouldAccept(_ event: [String: Any]) -> Bool {
        guard let sequence = Self.intValue(event["seq"]),
              let type = event["type"] as? String else {
            // Old relays/locally-generated events have no sequence number. They
            // still go through the adjacent-message guard below.
            return true
        }

        let sessionId = event["session_id"] as? String ?? ""
        let agentId = event["agent_id"] as? String ?? ""
        let identity = Identity(
            sessionId: sessionId,
            agentId: agentId,
            type: type,
            sequence: sequence,
            payloadHash: Self.stablePayloadHash(event)
        )
        guard delivered.insert(identity).inserted else { return false }
        deliveryOrder.append(identity)
        if deliveryOrder.count > capacity {
            let overflow = deliveryOrder.count - capacity
            let expired = deliveryOrder.prefix(overflow)
            delivered.subtract(expired)
            deliveryOrder.removeFirst(overflow)
        }
        return true
    }

    mutating func reset() {
        delivered.removeAll(keepingCapacity: true)
        deliveryOrder.removeAll(keepingCapacity: true)
    }

    private static func intValue(_ value: Any?) -> Int? {
        if let value = value as? Int { return value }
        if let value = value as? String { return Int(value) }
        return nil
    }

    private static func stablePayloadHash(_ event: [String: Any]) -> Int {
        guard JSONSerialization.isValidJSONObject(event),
              let data = try? JSONSerialization.data(withJSONObject: event, options: [.sortedKeys]) else {
            return 0
        }
        return data.hashValue
    }
}

enum MessageAppendPolicy {
    static func isImmediateDuplicate(
        role: ChatMessageRole,
        type: ChatMessageType?,
        content: String,
        in messages: [ChatMessage]
    ) -> Bool {
        guard let last = messages.last else { return false }
        return last.role == role && last.type == type && last.content == content
    }
}

enum SessionInputPolicy {
    static func canSend(
        status: String,
        source: String,
        daemonOnline: Bool,
        isSubagent: Bool,
        isManagedSession: Bool = false,
        agentType: String = "",
        capabilities: Set<String> = []
    ) -> Bool {
        if isSubagent || !daemonOnline || status == "disconnected" { return false }
        if agentType == "claude-code" {
            if source == "daemon" || isManagedSession { return true }
            guard source == "terminal" else { return false }
            if status == "idle" { return true }
            let resumableStatuses: Set<String> = ["exited", "completed", "error", "killed"]
            return resumableStatuses.contains(status)
                && capabilities.contains("resume_after_exit")
        }
        if ["idle", "waiting_approval"].contains(status) { return true }

        let resumableStatuses: Set<String> = ["exited", "completed", "error", "killed"]
        return resumableStatuses.contains(status)
            && (source == "daemon" || isManagedSession)
    }
}

enum TurnActivitySignal {
    case sendAccepted
    case acknowledged
    case rejected
    case status(String)
    case reset
}

struct TurnActivityState {
    private(set) var isAwaitingStart = false

    mutating func apply(_ signal: TurnActivitySignal) {
        switch signal {
        case .sendAccepted:
            isAwaitingStart = true
        case .acknowledged:
            break
        case .rejected, .reset:
            isAwaitingStart = false
        case .status(let status):
            let reconciled: Set<String> = [
                "running", "busy", "retry", "idle", "completed", "exited",
                "error", "killed", "disconnected",
            ]
            if reconciled.contains(status) {
                isAwaitingStart = false
            }
        }
    }

    func isWorking(status: String) -> Bool {
        isAwaitingStart || ["running", "busy", "retry"].contains(status)
    }
}

extension Session {
    /// `session_created` is a realtime event rather than a DB row and older
    /// relays omit timestamps from it. Supply a deterministic local fallback so
    /// a newly-created session sorts to the top immediately.
    static func fromLiveEvent(
        dict: [String: Any],
        fallbackDaemonId: String,
        now: String = ISO8601DateFormatter().string(from: Date())
    ) -> Session? {
        var normalized = dict
        if normalized["daemon_id"] == nil {
            normalized["daemon_id"] = fallbackDaemonId
        }
        let createdAt = (normalized["created_at"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? now
        normalized["created_at"] = createdAt
        if (normalized["last_activity_at"] as? String)?.isEmpty != false {
            normalized["last_activity_at"] = createdAt
        }
        return from(dict: normalized)
    }
}

struct SessionIdentityCanonicalizer {
    private var aliases: [String: String] = [:]

    mutating func record(oldId: String, newId: String) {
        guard !oldId.isEmpty, !newId.isEmpty, oldId != newId else { return }
        aliases[oldId] = canonicalId(newId)
    }

    func canonicalId(_ id: String) -> String {
        var current = id
        var seen = Set<String>()
        while let next = aliases[current], seen.insert(current).inserted {
            current = next
        }
        return current
    }

    func canonicalize(_ sessions: [Session]) -> [Session] {
        var result: [Session] = []
        var indexById: [String: Int] = [:]
        for original in sessions {
            let canonical = canonicalId(original.sessionId)
            var session = original
            session.sessionId = canonical
            if let index = indexById[canonical] {
                // Prefer the entry that already carries the canonical ID. It is
                // normally the real-id live/authoritative record rather than a
                // sparse pending-id copy from an overlapping page response.
                if original.sessionId == canonical {
                    result[index] = session
                }
            } else {
                indexById[canonical] = result.count
                result.append(session)
            }
        }
        return result
    }

    func canonicalize(_ ids: Set<String>) -> Set<String> {
        Set(ids.map(canonicalId))
    }
}

enum SessionDiscoveryPolicy {
    static func isFresh(_ event: [String: Any]) -> Bool {
        event["resync"] as? Bool != true
    }
}

enum SessionPageMergePolicy {
    static func merge(
        existing: [Session],
        incoming: [Session],
        replaceAll: Bool,
        preserveSessionIds: Set<String>
    ) -> [Session] {
        let incomingIds = Set(incoming.map(\.sessionId))
        let preserved = existing.filter { session in
            !incomingIds.contains(session.sessionId)
                && (!replaceAll || preserveSessionIds.contains(session.sessionId))
        }
        return (preserved + incoming).sorted(by: isOrderedBefore)
    }

    private static func isOrderedBefore(_ lhs: Session, _ rhs: Session) -> Bool {
        if lhs.pinned != rhs.pinned { return lhs.pinned }
        return (lhs.lastActivityAt ?? lhs.createdAt) > (rhs.lastActivityAt ?? rhs.createdAt)
    }
}

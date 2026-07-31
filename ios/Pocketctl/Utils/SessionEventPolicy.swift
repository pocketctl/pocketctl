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

enum SessionComposerConnectivity {
    case offline
    case syncing
    case ready
}

enum SessionComposerState: Equatable {
    case ready
    case temporarilyUnavailable
    case syncing
    case readOnly
    case ended

    var isVisible: Bool {
        switch self {
        case .ready, .temporarilyUnavailable, .syncing:
            return true
        case .readOnly, .ended:
            return false
        }
    }

    var isEditable: Bool {
        switch self {
        case .ready, .temporarilyUnavailable:
            return true
        case .syncing, .readOnly, .ended:
            return false
        }
    }

    var canSend: Bool {
        self == .ready
    }
}

/// Applies transport readiness to the agent-specific writable decision without
/// treating a temporary daemon disconnect as a terminal session lifecycle.
enum SessionComposerPolicy {
    static func resolve(
        writableWhenConnected: Bool,
        connectivity: SessionComposerConnectivity,
        isTerminal: Bool
    ) -> SessionComposerState {
        guard writableWhenConnected else {
            return isTerminal ? .ended : .readOnly
        }
        switch connectivity {
        case .ready:
            return .ready
        case .syncing:
            return .syncing
        case .offline:
            return .temporarilyUnavailable
        }
    }

    static func isTerminalStatus(_ status: String) -> Bool {
        ["exited", "completed", "error", "killed"].contains(status)
    }
}

/// Older relays emitted this synthetic status for a daemon connectivity loss.
/// It is not an authoritative lifecycle transition.
enum SessionStatusEventPolicy {
    static func isConnectivityOverlay(_ status: String?) -> Bool {
        status == "disconnected"
    }
}

enum UserMessageDeliveryState: Equatable {
    case pending
    case forwarded
    case accepted
    case failed
}

struct PendingUserMessageTracker {
    private struct Entry {
        var state: UserMessageDeliveryState
        let expectsAcceptanceReceipt: Bool
    }

    private var entries: [String: Entry] = [:]

    mutating func begin(id: String, expectsAcceptanceReceipt: Bool) {
        entries[id] = Entry(
            state: .pending,
            expectsAcceptanceReceipt: expectsAcceptanceReceipt
        )
    }

    func state(for id: String) -> UserMessageDeliveryState? {
        entries[id]?.state
    }

    mutating func acknowledge(id: String) -> UserMessageDeliveryState? {
        guard var entry = entries[id] else { return nil }
        if entry.expectsAcceptanceReceipt {
            entry.state = .forwarded
            entries[id] = entry
            return .forwarded
        }
        entries.removeValue(forKey: id)
        return .accepted
    }

    mutating func resolve(id: String, status: String) -> UserMessageDeliveryState? {
        guard entries[id]?.expectsAcceptanceReceipt == true else { return nil }
        entries.removeValue(forKey: id)
        return status == "accepted" ? .accepted : .failed
    }

    mutating func reject(id: String) -> UserMessageDeliveryState? {
        guard entries.removeValue(forKey: id) != nil else { return nil }
        return .failed
    }
}

struct ContentStreamChunk: Equatable {
    let streamId: String
    let sequence: Int
    let byteOffset: Int
    let content: String
    let final: Bool
    let totalBytes: Int?
}

struct ContentStreamUpdate: Equatable {
    let appended: String
    let content: String
    let changed: Bool
    let completed: Bool
    let transitionedToComplete: Bool
    let incomplete: Bool
    let truncated: Bool
    let receivedBytes: Int
}

struct ContentStreamAssembler {
    private struct State {
        var nextSequence = 0
        var chunks: [Int: ContentStreamChunk] = [:]
        var content = ""
        var finalSequence: Int?
        var finalTotalBytes: Int?
        var receivedBytes = 0
        var retainedBytes = 0
        var truncated = false
    }

    private let maxPreviewBytes: Int
    private let maxBufferedChunksPerStream: Int
    private let maxBufferedBytes: Int
    private let maxActiveStreams: Int
    private let maxCompletedStreams: Int
    private var streams: [String: State] = [:]
    private var completedStreams = Set<String>()
    private var completedOrder: [String] = []
    private var bufferedBytes = 0

    init(
        maxPreviewBytes: Int = 1024 * 1024,
        maxBufferedChunksPerStream: Int = 64,
        maxBufferedBytes: Int = 8 * 1024 * 1024,
        maxActiveStreams: Int = 32,
        maxCompletedStreams: Int = 2_048
    ) {
        self.maxPreviewBytes = max(0, maxPreviewBytes)
        self.maxBufferedChunksPerStream = max(1, maxBufferedChunksPerStream)
        self.maxBufferedBytes = max(0, maxBufferedBytes)
        self.maxActiveStreams = max(1, maxActiveStreams)
        self.maxCompletedStreams = max(0, maxCompletedStreams)
    }

    mutating func accept(_ chunk: ContentStreamChunk) -> ContentStreamUpdate? {
        guard !chunk.streamId.isEmpty, chunk.sequence >= 0 else { return nil }
        if completedStreams.contains(chunk.streamId) {
            return ContentStreamUpdate(
                appended: "", content: "", changed: false,
                completed: true, transitionedToComplete: false, incomplete: false,
                truncated: false, receivedBytes: 0
            )
        }

        if streams[chunk.streamId] == nil && streams.count >= maxActiveStreams {
            return nil
        }
        var state = streams[chunk.streamId] ?? State()
        if chunk.sequence < state.nextSequence {
            if chunk.final && chunk.sequence == state.finalSequence {
                state.finalTotalBytes = chunk.totalBytes
                return finish(
                    streamId: chunk.streamId,
                    state: &state,
                    appended: "",
                    changed: false
                )
            }
            return ContentStreamUpdate(
                appended: "", content: state.content, changed: false,
                completed: false, transitionedToComplete: false,
                incomplete: state.finalSequence != nil,
                truncated: state.truncated, receivedBytes: state.receivedBytes
            )
        }

        if state.chunks[chunk.sequence] == chunk {
            return finish(
                streamId: chunk.streamId,
                state: &state,
                appended: "",
                changed: false
            )
        }
        let existing = state.chunks[chunk.sequence]
        let chunkBytes = chunk.content.utf8.count
        let existingBytes = existing?.content.utf8.count ?? 0
        let drainsImmediately = chunk.sequence == state.nextSequence
            && chunk.byteOffset == state.receivedBytes
        guard !(
            (existing == nil && !drainsImmediately
                && state.chunks.count >= maxBufferedChunksPerStream)
                || chunkBytes > maxBufferedBytes
                || (!drainsImmediately
                    && bufferedBytes - existingBytes + chunkBytes > maxBufferedBytes)
        ) else {
            return nil
        }
        bufferedBytes += chunkBytes - existingBytes
        state.chunks[chunk.sequence] = chunk
        if chunk.final {
            state.finalSequence = chunk.sequence
            state.finalTotalBytes = chunk.totalBytes
        }

        var appended = ""
        while let next = state.chunks[state.nextSequence] {
            guard next.byteOffset == state.receivedBytes else { break }
            state.chunks.removeValue(forKey: state.nextSequence)
            let nextBytes = next.content.utf8.count
            bufferedBytes -= nextBytes
            state.receivedBytes += nextBytes
            let retained = retainUtf8Prefix(
                next.content,
                byteLimit: maxPreviewBytes - state.retainedBytes
            )
            state.content += retained
            appended += retained
            state.retainedBytes += retained.utf8.count
            if retained != next.content { state.truncated = true }
            state.nextSequence += 1
            if next.final { break }
        }

        return finish(
            streamId: chunk.streamId,
            state: &state,
            appended: appended,
            changed: !appended.isEmpty
        )
    }

    mutating func reset() {
        streams.removeAll(keepingCapacity: true)
        completedStreams.removeAll(keepingCapacity: true)
        completedOrder.removeAll(keepingCapacity: true)
        bufferedBytes = 0
    }

    private mutating func finish(
        streamId: String,
        state: inout State,
        appended: String,
        changed: Bool
    ) -> ContentStreamUpdate {
        let reachedFinal = state.finalSequence.map { state.nextSequence > $0 } ?? false
        let totalMatches = state.finalTotalBytes.map { $0 == state.receivedBytes } ?? true
        let completed = reachedFinal && totalMatches
        let update = ContentStreamUpdate(
            appended: appended,
            content: state.content,
            changed: changed,
            completed: completed,
            transitionedToComplete: completed,
            incomplete: state.finalSequence != nil && !completed,
            truncated: state.truncated,
            receivedBytes: state.receivedBytes
        )
        if completed {
            bufferedBytes -= state.chunks.values.reduce(0) { $0 + $1.content.utf8.count }
            streams.removeValue(forKey: streamId)
            rememberCompleted(streamId)
        } else {
            streams[streamId] = state
        }
        return update
    }

    private mutating func rememberCompleted(_ streamId: String) {
        guard maxCompletedStreams > 0 else { return }
        completedStreams.insert(streamId)
        completedOrder.append(streamId)
        while completedOrder.count > maxCompletedStreams {
            completedStreams.remove(completedOrder.removeFirst())
        }
    }

    private func retainUtf8Prefix(_ content: String, byteLimit: Int) -> String {
        guard byteLimit > 0, !content.isEmpty else { return "" }
        if content.utf8.count <= byteLimit { return content }
        var retained = ""
        var retainedBytes = 0
        for character in content {
            let bytes = String(character).utf8.count
            guard retainedBytes + bytes <= byteLimit else { break }
            retained.append(character)
            retainedBytes += bytes
        }
        return retained
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

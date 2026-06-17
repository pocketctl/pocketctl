import Foundation

/// All WebSocket event types from the relay server
enum WebSocketEventType: String, Sendable {
    // Daemon events
    case daemonStatus = "daemon_status"

    // Session lifecycle
    case sessionList = "session_list"
    case sessionCreated = "session_created"
    case sessionDiscovered = "session_discovered"
    case sessionStatus = "session_status"
    case sessionIdChanged = "session_id_changed"
    case sessionTitleUpdate = "session_title_update"
    case sessionDeleted = "session_deleted"

    // Agent streaming
    case agentText = "agent_text"
    case userText = "user_text"
    case toolCall = "tool_call"
    case toolResult = "tool_result"
    case subagentDiscovered = "subagent_discovered"

    // Slash commands (daemon → client)
    case commandList = "command_list"
    case commandReceipt = "command_receipt"

    // Replay control (relay → client)
    case replayBatch = "replay_batch"
    case replayEnd = "replay_end"

    // Errors
    case error

    // Server responses
    case registerAck = "register_ack"
    case pong
}

/// Parsed WebSocket event
struct WebSocketEvent {
    let type: WebSocketEventType
    let raw: [String: Any]

    init?(dict: [String: Any]) {
        guard let typeStr = dict["type"] as? String,
              let type = WebSocketEventType(rawValue: typeStr) else { return nil }
        self.type = type
        self.raw = dict
    }

    // Convenience accessors
    var sessionId: String? { raw["session_id"] as? String }
    var text: String? { raw["text"] as? String }
    var streaming: Bool { raw["streaming"] as? Bool ?? false }
    var callId: String? { raw["call_id"] as? String }
    var tool: String? { raw["tool"] as? String }
    var status: String? { raw["status"] as? String }
    var error: String? { raw["error"] as? String }
    var title: String? { raw["title"] as? String }
    var agentId: String? { raw["agent_id"] as? String }
    var exitReason: String? { raw["exit_reason"] as? String }
    var hostname: String? { raw["hostname"] as? String }
    var daemonId: String? { raw["daemon_id"] as? String }

    var input: Any? { raw["input"] }
    var output: String? { raw["output"] as? String }

    var sessions: [[String: Any]]? {
        raw["sessions"] as? [[String: Any]]
    }

    var subagentDesc: String? { raw["subagent_desc"] as? String }
    var subagentType: String? { raw["subagent_type"] as? String }

    // Slash command accessors
    /// Command name for command_receipt (e.g. "/compact"). Empty if unknown.
    var command: String? { raw["command"] as? String }
    /// Receipt status: "success" | "failed" | "unavailable". Defaults to "success".
    var receiptStatus: String? { raw["receipt_status"] as? String }
    /// Receipt message (human-readable detail). May be empty.
    var receiptMessage: String? { raw["message"] as? String }
    /// Available commands for command_list.
    var commands: [[String: Any]]? { raw["commands"] as? [[String: Any]] }

    // Replay control accessors
    var events: [[String: Any]]? { raw["events"] as? [[String: Any]] }
    var lastSeq: Int? { raw["last_seq"] as? Int }
    var count: Int? { raw["count"] as? Int }
}

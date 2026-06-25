import Foundation

/// All WebSocket event types from the relay server
enum WebSocketEventType: String, Sendable {
    // Daemon events
    case daemonStatus = "daemon_status"
    case daemonList = "daemon_list"

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

    // Tool-use approval (daemon → client, non-bypass sessions)
    case approvalRequest = "approval_request"

    // Replay control (relay → client)
    case replayBatch = "replay_batch"
    case replayEnd = "replay_end"

    // Errors
    case error

    // Agent management & model picker
    case modelList = "model_list"
    case upgradeResult = "upgrade_result"
    case sessionCreateFailed = "session_create_failed"
    case sessionMeta = "session_meta"

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

    /// Approval request id — for approval_request events (PreToolUse hook).
    var requestId: String? { raw["request_id"] as? String }

    var sessions: [[String: Any]]? {
        raw["sessions"] as? [[String: Any]]
    }

    /// Daemon list — for `daemon_list` (response to `list_daemons`). Each element
    /// carries `{daemon_id, hostname, agents:[{type,version,latest}], status, ...}`.
    var daemons: [[String: Any]]? {
        raw["daemons"] as? [[String: Any]]
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
    /// Replay direction — for replay_batch ('forward' | 'backward').
    var direction: String? { raw["direction"] as? String }
    /// Whether older events exist beyond the loaded page — for replay_end.
    var hasMore: Bool? { raw["has_more"] as? Bool }

    // Model picker & agent management
    /// Available models — for model_list.
    var models: [[String: Any]]? { raw["models"] as? [[String: Any]] }
    /// Agent type (e.g. "claude-code") — for upgrade_result.
    var agent: String? { raw["agent"] as? String }
    /// Failure reason code (e.g. "no_cli", "bad_cwd") — for session_create_failed.
    var reason: String? { raw["reason"] as? String }
    /// Upgrade success flag — for upgrade_result.
    var upgradeSuccess: Bool? { raw["success"] as? Bool }
    /// Resolved model name — for session_meta.
    var resolvedModel: String? { raw["model"] as? String }
}

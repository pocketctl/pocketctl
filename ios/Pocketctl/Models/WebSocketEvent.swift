import Foundation

/// All WebSocket event types from the relay server
enum WebSocketEventType: String, Sendable {
    // Daemon events
    case daemonStatus = "daemon_status"
    case daemonList = "daemon_list"
    case quotaStatus = "quota_status"

    // Session lifecycle
    case sessionList = "session_list"
    case sessionCreated = "session_created"
    case sessionDiscovered = "session_discovered"
    case sessionStatus = "session_status"
    case sessionIdChanged = "session_id_changed"
    case sessionTitleUpdate = "session_title_update"
    case sessionDeleted = "session_deleted"
    case sessionPinned = "session_pinned"

    // Agent streaming
    case agentText = "agent_text"
    case agentReasoning = "agent_reasoning"
    case agentRetry = "agent_retry"
    case agentCompaction = "agent_compaction"
    case agentFile = "agent_file"
    case agentPatch = "agent_patch"
    case agentTodo = "agent_todo"
    case agentSubtask = "agent_subtask"
    case agentProfile = "agent_profile"
    case userText = "user_text"
    case toolCall = "tool_call"
    case toolResult = "tool_result"
    case subagentDiscovered = "subagent_discovered"

    // Subagent usage & title
    case subagentUsage = "subagent_usage"
    case subagentTitleUpdate = "subagent_title_update"

    // Slash commands (daemon → client)
    case commandList = "command_list"
    case commandReceipt = "command_receipt"
    case sessionAgentList = "session_agent_list"
    case sessionAgentChanged = "session_agent_changed"

    // Tool-use approval (daemon → client, non-bypass sessions)
    case approvalRequest = "approval_request"
    // Pending approval was answered elsewhere (e.g. [y/n] typed in the terminal
    // that owns the session) — dismiss the matching card on this device.
    case approvalResolved = "approval_resolved"
    case questionRequest = "question_request"
    case questionResolved = "question_resolved"
    case mcpElicitationRequest = "mcp_elicitation_request"
    case mcpElicitationResolved = "mcp_elicitation_resolved"
    case interactionResult = "interaction_result"

    // PTY selection menu (daemon → client) — a menu the agent's TUI drew to the
    // PTY that never reached the JSONL history (e.g. a host PreToolUse hook's
    // "❯1.Yes 2.No" confirmation). The daemon scans the PTY and surfaces it as
    // a numbered-choice card; the user's pick is written back to the PTY.
    case interactivePrompt = "interactive_prompt"

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
    case sessionModelChanged = "session_model_changed"
    case permissionConfigChanged = "permission_config_changed"

    // Server responses
    case registerAck = "register_ack"
    case userMessageAck = "user_message_ack"
    case userMessageNack = "user_message_nack"
    case userMessageReceipt = "user_message_receipt"
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
    var text: String? { value("text") as? String }
    var streaming: Bool { value("streaming") as? Bool ?? false }
    var streamId: String? { value("stream_id") as? String }
    var chunkSequence: Int? { intValue("chunk_seq") }
    var byteOffset: Int? { intValue("byte_offset") }
    var streamFinal: Bool { value("final") as? Bool ?? false }
    var totalBytes: Int? { intValue("total_bytes") }
    var contentHash: String? { value("content_hash") as? String }
    var streamTruncated: Bool? { value("truncated") as? Bool }
    var messageId: String? { value("message_id") as? String }
    var partId: String? { value("part_id") as? String }
    var revision: Int? { intValue("revision") }
    var replace: Bool { value("replace") as? Bool ?? false }
    var attempt: Int? { intValue("attempt") }
    var retryAt: Int64? {
        if let value = value("retry_at") as? Int64 { return value }
        if let value = value("retry_at") as? Int { return Int64(value) }
        if let value = value("retry_at") as? String { return Int64(value) }
        return nil
    }
    var compactionAuto: Bool { value("auto") as? Bool ?? false }
    var overflow: Bool { value("overflow") as? Bool ?? false }
    var mime: String? { value("mime") as? String }
    var filename: String? { value("filename") as? String }
    var url: String? { value("url") as? String }
    var patchHash: String? { value("hash") as? String }
    var files: [String] { value("files") as? [String] ?? [] }
    var prompt: String? { value("prompt") as? String }
    var partDescription: String? { value("description") as? String }
    var partAgent: String? { value("agent") as? String }
    var partModel: String? { value("model") as? String }
    var partCommand: String? { value("command") as? String }
    var profileName: String? { value("profile_name") as? String }
    var partSource: String? { jsonText(value("part_source"), limit: 1000) }
    var todos: [OpenCodeTodoItem] {
        guard let rows = value("todos") as? [[String: Any]] else { return [] }
        return rows.compactMap { row in
            guard let content = row["content"] as? String, !content.isEmpty else { return nil }
            return OpenCodeTodoItem(
                content: content,
                status: row["status"] as? String ?? "pending",
                priority: row["priority"] as? String ?? ""
            )
        }
    }
    var callId: String? { value("call_id") as? String }
    var tool: String? { value("tool") as? String }
    var status: String? { raw["status"] as? String }
    var error: String? { value("error") as? String }
    var title: String? { raw["title"] as? String }
    /// 置顶状态 — for session_pinned 事件
    var pinned: Bool? { raw["pinned"] as? Bool }
    var agentId: String? { raw["agent_id"] as? String }
    var exitReason: String? { raw["exit_reason"] as? String }
    var hostname: String? { raw["hostname"] as? String }
    var daemonId: String? { raw["daemon_id"] as? String }
    var msgId: String? { raw["msg_id"] as? String }
    var requestIdValue: String? { raw["request_id"] as? String }
    var operation: String? { value("operation") as? String }
    var quotaStatus: QuotaStatus? { QuotaStatus.from(dict: raw) }

    var input: Any? { value("input") }
    var output: String? { value("output") as? String }

    /// Token usage for `agent_text` events — the final turn chunk carries
    /// `{output_tokens, input_tokens, ...}`. Accepts both top-level `usage`
    /// and a nested `payload.usage` (relay may forward either way), matching
    /// the web client.
    var usage: TokenUsage? {
        let u = (raw["usage"] as? [String: Any]) ?? ((raw["payload"] as? [String: Any])?["usage"] as? [String: Any])
        guard let u else { return nil }
        let out = (u["output_tokens"] as? Int) ?? Int(u["output_tokens"] as? String ?? "") ?? 0
        let inp = (u["input_tokens"] as? Int) ?? Int(u["input_tokens"] as? String ?? "") ?? 0
        let cr = (u["cache_read_tokens"] as? Int) ?? Int(u["cache_read_tokens"] as? String ?? "") ?? 0
        let cc = (u["cache_create_tokens"] as? Int) ?? Int(u["cache_create_tokens"] as? String ?? "") ?? 0
        return TokenUsage(outputTokens: out, inputTokens: inp, cacheReadTokens: cr, cacheCreateTokens: cc)
    }

    /// Approval request id — for approval_request events (PreToolUse hook).
    var requestId: String? { value("request_id") as? String }

    /// Terminal-side decision — for approval_resolved events. true = allowed.
    var approved: Bool { value("approved") as? Bool ?? false }
    var action: String? { value("action") as? String }
    var approvalKind: String? { value("approval_kind") as? String }
    var availableDecisions: [String] { value("available_decisions") as? [String] ?? [] }
    var permissionName: String? { value("permission_name") as? String }
    var patterns: [String] { value("patterns") as? [String] ?? [] }
    var alwaysRules: [String] { value("always") as? [String] ?? [] }
    var permissionVersion: String? { value("permission_version") as? String }
    var toolMessageId: String? { value("tool_message_id") as? String }
    var toolCallId: String? { value("tool_call_id") as? String }
    var metadata: String? {
        guard let metadata = value("metadata") else { return nil }
        if let string = metadata as? String { return String(string.prefix(4000)) }
        guard JSONSerialization.isValidJSONObject(metadata),
              let data = try? JSONSerialization.data(withJSONObject: metadata, options: [.prettyPrinted]),
              let string = String(data: data, encoding: .utf8) else { return nil }
        return String(string.prefix(4000))
    }
    var questions: [OpenCodeQuestion] {
        OpenCodeQuestion.parse(value("questions") as? [[String: Any]] ?? [])
    }
    var answers: [[String]] { value("answers") as? [[String]] ?? [] }
    var rejected: Bool { value("rejected") as? Bool ?? false }
    var autoResolutionMs: UInt64? {
        if let value = value("auto_resolution_ms") as? UInt64 { return value }
        if let value = value("auto_resolution_ms") as? Int, value >= 0 { return UInt64(value) }
        return nil
    }
    var redacted: Bool { value("redacted") as? Bool ?? false }
    var mcpServer: String? { value("mcp_server") as? String }
    var elicitationMode: String? { value("elicitation_mode") as? String }
    var elicitationId: String? { value("elicitation_id") as? String }
    var elicitationSchema: String? { jsonText(value("elicitation_schema"), limit: 64 * 1024) }
    var elicitationMessage: String? { value("message") as? String }

    /// Parsed interactive-prompt payload — for interactive_prompt events.
    /// The daemon emits `{request_id, input:{prompt, options:[{index,label}]}}`.
    var promptText: String? {
        guard let input = promptInputDict else { return nil }
        return input["prompt"] as? String
    }
    /// Numbered options for an interactive_prompt, as (index, label) tuples.
    var promptOptions: [(index: String, label: String)] {
        guard let input = promptInputDict,
              let arr = input["options"] as? [[String: Any]] else { return [] }
        return arr.compactMap { opt in
            guard let idx = opt["index"] as? String, let label = opt["label"] as? String else { return nil }
            return (index: idx, label: label)
        }
    }
    /// Resolves the `input` field for an interactive_prompt, accepting either a
    /// parsed dict or a JSON string (the relay may forward it either way).
    private var promptInputDict: [String: Any]? {
        if let dict = raw["input"] as? [String: Any] { return dict }
        if let str = raw["input"] as? String,
           let data = str.data(using: .utf8),
           let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            return parsed
        }
        return nil
    }

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

    // Subagent usage accessor — for subagent_usage events.
    /// Token usage carried by a subagent_usage event. Mirrors the `usage`
    /// accessor pattern (input_tokens/output_tokens/cache_read_tokens/cache_create_tokens).
    var subagentUsage: TokenUsage? {
        let u = raw["usage"] as? [String: Any]
        guard let u else { return nil }
        let out = (u["output_tokens"] as? Int) ?? Int(u["output_tokens"] as? String ?? "") ?? 0
        let inp = (u["input_tokens"] as? Int) ?? Int(u["input_tokens"] as? String ?? "") ?? 0
        let cr = (u["cache_read_tokens"] as? Int) ?? Int(u["cache_read_tokens"] as? String ?? "") ?? 0
        let cc = (u["cache_create_tokens"] as? Int) ?? Int(u["cache_create_tokens"] as? String ?? "") ?? 0
        return TokenUsage(outputTokens: out, inputTokens: inp, cacheReadTokens: cr, cacheCreateTokens: cc)
    }
    /// Subagent title — for subagent_title_update events.
    var subagentTitle: String? { raw["title"] as? String }

    // Slash command accessors
    /// Command name for command_receipt (e.g. "/compact"). Empty if unknown.
    var command: String? { raw["command"] as? String }
    /// Receipt status: "success" | "failed" | "unavailable". Defaults to "success".
    var receiptStatus: String? { raw["receipt_status"] as? String }
    /// Receipt message (human-readable detail). May be empty.
    var receiptMessage: String? { raw["message"] as? String }
    /// Available commands for command_list.
    var commands: [[String: Any]]? { raw["commands"] as? [[String: Any]] }
    var currentAgent: String? { value("current_agent") as? String }
    var sessionAgents: [OpenCodeSessionAgent] {
        OpenCodeSessionAgent.selectable(from: value("agents") as? [[String: Any]] ?? [])
    }
    var capabilities: [String] { value("capabilities") as? [String] ?? [] }
    var controlMode: String? { value("control_mode") as? String }

    // Replay control accessors
    var events: [[String: Any]]? { raw["events"] as? [[String: Any]] }
    var lastSeq: Int? {
        if let value = raw["last_seq"] as? Int { return value }
        if let value = raw["last_seq"] as? String { return Int(value) }
        return nil
    }
    var count: Int? { raw["count"] as? Int }
    /// Replay direction — for replay_batch ('forward' | 'backward').
    var direction: String? { raw["direction"] as? String }
    /// Whether older events exist beyond the loaded page — for replay_end.
    var hasMore: Bool? { raw["has_more"] as? Bool }
    var nextCursor: String? { raw["next_cursor"] as? String }

    // Model picker & agent management
    /// Available models — for model_list.
    var models: [[String: Any]]? { raw["models"] as? [[String: Any]] }
    /// Agent type (e.g. "claude-code") — for upgrade_result.
    var agent: String? { raw["agent"] as? String }
    /// Failure reason code (e.g. "no_cli", "bad_cwd") — for session_create_failed.
    var reason: String? { value("reason") as? String }
    /// Upgrade success flag — for upgrade_result.
    var upgradeSuccess: Bool? { raw["success"] as? Bool }
    /// Resolved model name — for session_meta.
    var resolvedModel: String? { raw["model"] as? String }

    /// Actual reasoning effort reported by session_meta.
    var effort: String? { raw["effort"] as? String }
    var permission: AgentPermissionConfig? { (raw["permission"] as? [String: Any]).flatMap(AgentPermissionConfig.from) }
    var permissionEffective: String? { raw["permission_effective"] as? String }
    var permissionMutable: Bool { raw["permission_mutable"] as? Bool ?? false }
    var permissionMutableModes: [String] { raw["permission_mutable_modes"] as? [String] ?? [] }

    /// Last activity timestamp — for session_status. Used to recover the real
    /// turn start when resuming a running session so the elapsed timer doesn't
    /// restart from zero on re-entry.
    var lastActivityAt: String? { raw["last_activity_at"] as? String }
    var turnStartedAt: String? { raw["turn_started_at"] as? String }

    private func value(_ key: String) -> Any? {
        raw[key] ?? (raw["payload"] as? [String: Any])?[key]
    }

    private func intValue(_ key: String) -> Int? {
        if let value = value(key) as? Int { return value }
        if let value = value(key) as? Int64 { return Int(value) }
        if let value = value(key) as? String { return Int(value) }
        return nil
    }

    private func jsonText(_ object: Any?, limit: Int) -> String? {
        guard let object else { return nil }
        if let string = object as? String { return String(string.prefix(limit)) }
        guard JSONSerialization.isValidJSONObject(object),
              let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
              let string = String(data: data, encoding: .utf8) else { return nil }
        return String(string.prefix(limit))
    }
}

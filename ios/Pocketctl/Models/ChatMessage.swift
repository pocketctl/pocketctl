import Foundation

enum ChatMessageRole: Sendable {
    case user
    case agent
}

/// Token usage carried by an `agent_text` event (the final chunk of a turn).
/// Mirrors the web client's `usage` object — only the fields needed for the
/// "已完成" status bar are kept (output tokens). Input is retained for parity
/// and future cost displays.
///
/// context 使用量（与 web 客户端 `contextTokens` 一致）= input + cacheRead + cacheCreate。
struct TokenUsage: Sendable {
    var outputTokens: Int
    var inputTokens: Int
    var cacheReadTokens: Int
    var cacheCreateTokens: Int

    init(outputTokens: Int, inputTokens: Int, cacheReadTokens: Int = 0, cacheCreateTokens: Int = 0) {
        self.outputTokens = outputTokens
        self.inputTokens = inputTokens
        self.cacheReadTokens = cacheReadTokens
        self.cacheCreateTokens = cacheCreateTokens
    }

    /// Context 使用量（输入侧总 token）：输入 + 缓存读取 + 缓存写入，与 web 客户端一致。
    var contextTokens: Int { inputTokens + cacheReadTokens + cacheCreateTokens }
}

enum ChatMessageType: Sendable {
    case agentText
    case reasoning
    case retryNotice
    case compactionNotice
    case openCodeFile
    case openCodePatch
    case openCodeTodo
    case openCodeSubtask
    case openCodeAgent
    case toolCall
    case error
    case commandReceipt
    case approvalRequest
    case openCodeQuestion
    case mcpElicitation
    case interactiveChoice
}

struct OpenCodeTodoItem: Sendable {
    let content: String
    let status: String
    let priority: String
}

struct ChatMessage: Identifiable, Sendable {
    let id: Int
    let role: ChatMessageRole
    let type: ChatMessageType?
    var content: String
    var streaming: Bool

    // OpenCode mutable Part identity. Optional for legacy daemon events.
    var messageId: String? = nil
    var partId: String? = nil
    var revision: Int = 0

    // OpenCode retry/compaction notice metadata.
    var attempt: Int = 0
    var retryAt: Int64? = nil
    var automatic: Bool = false
    var overflow: Bool = false

    // OpenCode structured display Parts and session Todo snapshot.
    var mime: String = ""
    var filename: String = ""
    var url: String = ""
    var partSource: String = ""
    var patchHash: String = ""
    var files: [String] = []
    var prompt: String = ""
    var partDescription: String = ""
    var partAgent: String = ""
    var partModel: String = ""
    var partCommand: String = ""
    var profileName: String = ""
    var todos: [OpenCodeTodoItem] = []

    // Tool call fields
    var tool: String?
    var callId: String?
    var expanded: Bool = false
    var outputExpanded: Bool = false
    var subAgentId: String?

    // Tool call input/output — stored as raw strings for flexibility
    var inputDescription: String = ""
    var rawInputJSON: String?  // JSON-encoded input (for AskUserQuestion parsing)
    var output: String?

    /// Token usage attached to the final chunk of an agent_text turn
    /// (output_tokens for the "已完成" status bar). nil for non-agent or
    /// streaming chunks that didn't carry usage.
    var usage: TokenUsage?

    // Command receipt fields (slash command feedback)
    var command: String = ""
    var receiptStatus: String = "success"  // success | failed | unavailable

    // Tool-use approval fields (PreToolUse hook → approval_request → approval_response)
    var requestId: String?                 // daemon's approval request id (approval_request)
    var approvalStatus: String = "pending" // pending | allowed | denied
    var permissionName: String = ""
    var permissionPatterns: [String] = []
    var permissionAlways: [String] = []
    var permissionMetadata: String?
    var permissionVersion: String?
    var approvalAction: String?
    var approvalKind: String?
    var availableDecisions: [String] = []
    var interactionSubmitting: Bool = false
    var interactionError: String?
    var interactionResolutionReason: String?

    // OpenCode structured question fields.
    var questions: [OpenCodeQuestion] = []
    var questionAnswers: [[String]] = []
    var questionRejected: Bool = false
    var questionAutoResolutionMs: UInt64?
    var questionRedacted: Bool = false

    // Codex MCP elicitation fields. Submitted form content is intentionally
    // never retained on a resolved ChatMessage.
    var mcpServer: String = ""
    var elicitationMode: String = ""
    var elicitationId: String = ""
    var elicitationSchema: String = ""
    var elicitationURL: String = ""
    var elicitationMessage: String = ""
    var elicitationAction: String?

    // PTY selection-menu fields (interactive_prompt → interactive_response).
    // Surfaced when the daemon scans a menu the agent's TUI drew to the PTY
    // (e.g. a host PreToolUse hook's "❯1.Yes 2.No" prompt that never reaches JSONL).
    var promptText: String = ""            // the question phrase parsed from the menu
    var promptOptions: [(index: String, label: String)] = []  // numbered options
    var selectedChoice: String?            // the index the user picked (nil while pending)

    /// Whether this tool call is still running (no output yet).
    ///
    /// A toolCall is only considered running while the hosting session is still
    /// active (`sessionActive == true`) AND no `tool_result` has been received
    /// (`output == nil`). Once the session reaches a terminal state, orphan
    /// tool_calls (missing tool_result due to interrupted/forced-idle sessions,
    /// dropped events, etc.) are treated as finished to avoid a forever-spinning
    /// card that misleads users into thinking the call is still executing.
    func isRunning(sessionActive: Bool) -> Bool {
        type == .toolCall && output == nil && sessionActive
    }

    /// Truncated output for display (first 2000 chars)
    var truncatedOutput: String? {
        guard let output else { return nil }
        if output.count <= 2000 { return output }
        return String(output.prefix(2000))
    }

    /// Whether the output is long enough to need truncation
    var isOutputLong: Bool {
        guard let output else { return false }
        return output.count > 2000 || output.components(separatedBy: "\n").count > 50
    }

    /// SF Symbol for command receipt status.
    /// success uses checkmark.circle (neutral), failed uses xmark.circle,
    /// unavailable uses minus.circle — all in circles for visual consistency.
    var receiptIcon: String {
        switch receiptStatus {
        case "success":     return "checkmark.circle"
        case "failed":      return "xmark.circle"
        case "unavailable": return "minus.circle"
        default:            return "circle"
        }
    }
}

extension ChatMessage {
    /// SF Symbol name for the tool (replaces previous emoji icons to match
    /// the system's outline-icon visual language).
    var toolIcon: String {
        switch tool {
        case "Read": return "book"
        case "Write", "Edit": return "pencil"
        case "Bash": return "terminal"
        case "Glob", "Grep": return "magnifyingglass"
        case "WebSearch": return "globe"
        case "WebFetch": return "arrow.down.circle"
        case "Agent", "Task": return "sparkles"
        case "AskUserQuestion": return "questionmark.bubble"
        default: return "wrench.and.screwdriver"
        }
    }

    /// Summary text for tool call header
    var toolSummary: String {
        switch tool {
        case "Read", "Write", "Edit":
            return inputDescription
        case "Bash":
            return String(inputDescription.prefix(40)) + (inputDescription.count > 40 ? "…" : "")
        case "Glob", "Grep":
            return inputDescription
        case "Agent":
            return inputDescription
        case "AskUserQuestion":
            return inputDescription
        default:
            return inputDescription
        }
    }
}

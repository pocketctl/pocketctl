import Foundation

enum ChatMessageRole: Sendable {
    case user
    case agent
}

enum ChatMessageType: Sendable {
    case agentText
    case toolCall
    case error
    case commandReceipt
    case approvalRequest
    case interactiveChoice
}

struct ChatMessage: Identifiable, Sendable {
    let id: Int
    let role: ChatMessageRole
    let type: ChatMessageType?
    var content: String
    var streaming: Bool

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

    // Command receipt fields (slash command feedback)
    var command: String = ""
    var receiptStatus: String = "success"  // success | failed | unavailable

    // Tool-use approval fields (PreToolUse hook → approval_request → approval_response)
    var requestId: String?                 // daemon's approval request id (approval_request)
    var approvalStatus: String = "pending" // pending | allowed | denied

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

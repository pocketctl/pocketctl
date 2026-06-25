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

    /// Whether this tool call is still running (no output yet)
    var isRunning: Bool {
        type == .toolCall && output == nil
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

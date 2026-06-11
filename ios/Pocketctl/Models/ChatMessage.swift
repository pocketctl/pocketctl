import Foundation

enum ChatMessageRole: Sendable {
    case user
    case agent
}

enum ChatMessageType: Sendable {
    case agentText
    case toolCall
    case error
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
    var output: String?

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
}

extension ChatMessage {
    /// Tool icon emoji mapping
    var toolIcon: String {
        switch tool {
        case "Read": return "📖"
        case "Write", "Edit": return "✏️"
        case "Bash": return "⚡"
        case "Glob", "Grep": return "🔍"
        case "WebSearch", "WebFetch": return "🌐"
        case "Agent": return "🤖"
        default: return "🔧"
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
        default:
            return inputDescription
        }
    }
}

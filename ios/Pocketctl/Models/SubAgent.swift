import Foundation

struct SubAgent: Identifiable, Sendable {
    let agentId: String
    let description: String
    let agentType: String
    var messages: [ChatMessage]
    var status: String  // "running" | "completed" | "error"

    // Token fields — accumulated from subagent_usage events
    var tokenIn: Int64 = 0
    var tokenOut: Int64 = 0
    var tokenCache: Int64 = 0
    var tokenCacheCreate: Int64 = 0
    var title: String?

    var id: String { agentId }

    func contentEquals(_ other: SubAgent) -> Bool {
        agentId == other.agentId &&
        description == other.description &&
        agentType == other.agentType &&
        status == other.status &&
        tokenIn == other.tokenIn &&
        tokenOut == other.tokenOut &&
        tokenCache == other.tokenCache &&
        tokenCacheCreate == other.tokenCacheCreate &&
        title == other.title
    }
}

extension SubAgent {
    /// Create from a session_list children[] element or subagent_discovered event.
    static func from(dict: [String: Any]) -> SubAgent? {
        guard let agentId = (dict["agent_id"] as? String) ?? (dict["agentId"] as? String) else { return nil }
        return SubAgent(
            agentId: agentId,
            description: dict["description"] as? String ?? dict["title"] as? String ?? "",
            agentType: (dict["agent_type"] as? String) ?? (dict["agentType"] as? String) ?? "",
            messages: [],
            status: dict["status"] as? String ?? "running",
            tokenIn: Int64(dict["tokenIn"] as? Int ?? (dict["token_in"] as? Int) ?? 0),
            tokenOut: Int64(dict["tokenOut"] as? Int ?? (dict["token_out"] as? Int) ?? 0),
            tokenCache: Int64(dict["tokenCache"] as? Int ?? (dict["token_cache"] as? Int) ?? 0),
            tokenCacheCreate: Int64(dict["tokenCacheCreate"] as? Int ?? (dict["token_cache_create"] as? Int) ?? 0),
            title: dict["title"] as? String
        )
    }
}

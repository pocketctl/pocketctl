import Foundation

struct SubAgent: Identifiable, Sendable {
    let agentId: String
    let description: String
    let agentType: String
    var messages: [ChatMessage]
    var status: String  // "running" | "completed" | "error"

    var id: String { agentId }
}

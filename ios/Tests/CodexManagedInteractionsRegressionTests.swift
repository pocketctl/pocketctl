import Foundation

private func expect(_ condition: @autoclosure () -> Bool, _ message: String) {
    if !condition() { fputs("FAIL: \(message)\n", stderr); exit(1) }
}

let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
func source(_ path: String) throws -> String {
    try String(contentsOf: root.appendingPathComponent(path), encoding: .utf8)
}

let event = try source("ios/Pocketctl/Models/WebSocketEvent.swift")
let interaction = try source("ios/Pocketctl/Models/OpenCodeInteraction.swift")
let message = try source("ios/Pocketctl/Models/ChatMessage.swift")
let vm = try source("ios/Pocketctl/ViewModels/SessionDetailViewModel.swift")
let view = try source("ios/Pocketctl/Views/SessionDetailView.swift")
let approval = try source("ios/Pocketctl/Views/Components/ApprovalCard.swift")
let question = try source("ios/Pocketctl/Views/Components/OpenCodeQuestionCard.swift")
let elicitation = try source("ios/Pocketctl/Views/Components/McpElicitationCard.swift")

for accessor in ["var approvalKind:", "var availableDecisions:", "var autoResolutionMs:", "var redacted:"] {
    expect(event.contains(accessor), "Codex interaction decoder must expose \(accessor)")
}
expect(interaction.contains("dict[\"id\"] as? String") && interaction.contains("let secret: Bool"), "Codex question ids and secret flag must survive decoding")
for field in ["var approvalKind:", "var availableDecisions:", "var questionAutoResolutionMs:", "var questionRedacted:"] {
    expect(message.contains(field), "ChatMessage must retain \(field)")
}
expect(vm.contains("[\"once\", \"always\", \"reject\", \"cancel\"]"), "Codex cancel must be accepted")
expect(vm.contains("!message.availableDecisions.isEmpty"), "Codex decisions must use action responses without OpenCode capabilities")
expect(view.contains("!message.availableDecisions.isEmpty"), "Codex card must expose native decisions")
expect(approval.contains("availableDecisions.contains(\"accept\")") && approval.contains("availableDecisions.contains(\"cancel\")"), "approval buttons must follow availableDecisions")
expect(question.contains("SecureField") && question.contains("question.secret"), "secret answers must use secure native input")
expect(question.contains("questionRedacted"), "resolved secret answers must remain redacted")
expect(event.contains("mcpElicitationRequest") && event.contains("var elicitationSchema:"), "MCP elicitation events and schema must decode")
expect(message.contains("case mcpElicitation") && message.contains("var elicitationSchema:"), "MCP elicitation must have a distinct chat card")
expect(vm.contains("mcp_elicitation_response") && vm.contains("respondMcpElicitation"), "MCP elicitation responses must route to daemon")
expect(view.contains("McpElicitationCard"), "session detail must render MCP elicitation")
expect(elicitation.contains("SecureField") == false && elicitation.contains("elicitationMode"), "MCP form renderer must use the typed elicitation contract")

print("CodexManagedInteractionsRegressionTests passed")

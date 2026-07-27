import Foundation

func expect(_ condition: @autoclosure () -> Bool, _ message: String) {
    if !condition() {
        fputs("FAIL: \(message)\n", stderr)
        exit(1)
    }
}

let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let event = try String(contentsOf: root.appendingPathComponent("ios/Pocketctl/Models/WebSocketEvent.swift"), encoding: .utf8)
let message = try String(contentsOf: root.appendingPathComponent("ios/Pocketctl/Models/ChatMessage.swift"), encoding: .utf8)
let viewModel = try String(contentsOf: root.appendingPathComponent("ios/Pocketctl/ViewModels/SessionDetailViewModel.swift"), encoding: .utf8)
let view = try String(contentsOf: root.appendingPathComponent("ios/Pocketctl/Views/SessionDetailView.swift"), encoding: .utf8)

for eventCase in [
    "agentFile = \"agent_file\"", "agentPatch = \"agent_patch\"", "agentTodo = \"agent_todo\"",
    "agentSubtask = \"agent_subtask\"", "agentProfile = \"agent_profile\"",
] {
    expect(event.contains(eventCase), "WebSocketEvent must recognize \(eventCase)")
}

for messageCase in ["case openCodeFile", "case openCodePatch", "case openCodeTodo", "case openCodeSubtask", "case openCodeAgent"] {
    expect(message.contains(messageCase), "ChatMessage must expose \(messageCase)")
}

expect(viewModel.contains("handleOpenCodeStructured(event, messages: &messages)"), "live and replay paths must handle structured Parts")
expect(viewModel.contains("messageType == .openCodeTodo"), "Todo snapshots must upsert one card")
expect(viewModel.contains("let newerTodoExists = bufMessages.contains(where: { $0.type == .openCodeTodo })"), "backward pagination must detect the newer Todo snapshot")
expect(viewModel.contains("prependMsgs.removeAll(where: { $0.type == .openCodeTodo })"), "backward pagination must discard stale Todo snapshots")
expect(viewModel.contains("[\"running\", \"busy\", \"retry\"]"), "native retry must remain an executing state")
expect(view.contains("private struct OpenCodePartCard"), "iOS must render structured OpenCode cards")
expect(view.contains("DisclosureGroup"), "reasoning must stay collapsed by default")
expect(view.contains(".stroke(Color.pcBorder"), "reasoning and structured content must use card styling")

print("OpenCode P2 display regression checks passed")

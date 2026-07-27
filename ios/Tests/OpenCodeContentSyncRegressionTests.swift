import Foundation

private func expect(_ condition: @autoclosure () -> Bool, _ message: String) {
    if !condition() {
        fputs("FAIL: \(message)\n", stderr)
        exit(1)
    }
}

let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
func source(_ path: String) throws -> String {
    try String(contentsOf: root.appendingPathComponent(path), encoding: .utf8)
}

let event = try source("ios/Pocketctl/Models/WebSocketEvent.swift")
let message = try source("ios/Pocketctl/Models/ChatMessage.swift")
let viewModel = try source("ios/Pocketctl/ViewModels/SessionDetailViewModel.swift")
let view = try source("ios/Pocketctl/Views/SessionDetailView.swift")

for eventCase in ["agentReasoning = \"agent_reasoning\"", "agentRetry = \"agent_retry\"", "agentCompaction = \"agent_compaction\""] {
    expect(event.contains(eventCase), "WebSocketEventType must recognize \(eventCase)")
}
for accessor in ["var messageId:", "var partId:", "var revision:", "var replace:", "var attempt:", "var retryAt:", "var compactionAuto:", "var overflow:"] {
    expect(event.contains(accessor), "WebSocketEvent must expose \(accessor)")
}
for field in ["var messageId:", "var partId:", "var revision:"] {
    expect(message.contains(field), "ChatMessage must retain \(field)")
}
expect(viewModel.contains("applyRevisionedPart"), "ViewModel must share revisioned Part merge logic")
expect(viewModel.contains("existing.revision >= revision"), "ViewModel must reject stale Part revisions")
expect(viewModel.contains("event.replace ? text"), "ViewModel must replace non-prefix/final snapshots")
expect(viewModel.contains("case .agentReasoning:"), "live and replay dispatch must handle reasoning")
expect(viewModel.contains("case .agentRetry:"), "live and replay dispatch must handle retry notices")
expect(viewModel.contains("case .agentCompaction:"), "live and replay dispatch must handle compaction notices")
expect(view.contains("DisclosureGroup"), "reasoning must render as a collapsed disclosure")
expect(view.contains("case .retryNotice:"), "retry notice must render")
expect(view.contains("case .compactionNotice:"), "compaction notice must render")

print("OpenCodeContentSyncRegressionTests passed")

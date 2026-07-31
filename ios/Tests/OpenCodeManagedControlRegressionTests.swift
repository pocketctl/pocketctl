import Foundation

private func expect(_ condition: @autoclosure () -> Bool, _ message: String) {
    if !condition() { fputs("FAIL: \(message)\n", stderr); exit(1) }
}

let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
func source(_ path: String) throws -> String {
    try String(contentsOf: root.appendingPathComponent(path), encoding: .utf8)
}

let session = try source("ios/Pocketctl/Models/Session.swift")
let event = try source("ios/Pocketctl/Models/WebSocketEvent.swift")
let message = try source("ios/Pocketctl/Models/ChatMessage.swift")
let vm = try source("ios/Pocketctl/ViewModels/SessionDetailViewModel.swift")
let view = try source("ios/Pocketctl/Views/SessionDetailView.swift")
let inputPolicy = try source("ios/Pocketctl/Utils/SessionEventPolicy.swift")
let approval = try source("ios/Pocketctl/Views/Components/ApprovalCard.swift")
let question = try source("ios/Pocketctl/Views/Components/OpenCodeQuestionCard.swift")

for field in ["var controlMode:", "var capabilities:"] {
    expect(session.contains(field), "Session must retain \(field)")
}
expect(session.contains("dict[\"control_mode\"]"), "session_list must decode control_mode")
expect(session.contains("dict[\"capabilities\"]"), "session_list must decode capabilities")
expect(event.contains("interactionResult = \"interaction_result\""), "event decoder must recognize interaction_result")
expect(event.contains("var controlMode:"), "session_meta must expose control_mode")
expect(message.contains("var interactionResolutionReason:"), "cards must retain resolved_elsewhere")
expect(vm.contains("var isManagedOpenCodeSession:"), "view model needs one managed-session policy")
expect(vm.contains("session.controlMode == \"managed\""), "managed policy must require control_mode")
expect(vm.contains("sessionAgentCapabilities.contains(\"shared_runtime\")"), "managed policy must require shared_runtime")
expect(vm.contains("sessionAgentCapabilities.contains(\"terminal_coapproval\")"), "remote cards must require terminal_coapproval")
expect(inputPolicy.contains("isManagedSession: Bool = false"), "input policy must accept generic managed-session state")
expect(vm.contains("isManagedSession: session.controlMode == \"managed\""), "composer policy must receive generic managed-session control state")
expect(vm.contains("return basePolicyAllowsSend && (session.agentType != \"opencode\" || isManagedOpenCodeSession)"), "view model must retain the separate managed OpenCode capability gate")
expect(vm.contains("case .interactionResult:"), "resolved_elsewhere response must converge card state")
expect(vm.contains("reason: \"resolved_elsewhere\""), "resolved_elsewhere must be persisted as a normal resolution")
expect(view.contains("此会话由启用 Pocketctl 前的终端进程运行"), "legacy session must explain how to adopt it")
expect(view.contains("vm.isLegacyOpenCodeSession"), "legacy banner must be driven by managed control state")
expect(approval.contains("已在其他设备处理"), "approval card must show neutral elsewhere result")
expect(question.contains("已在其他设备处理"), "question card must show neutral elsewhere result")

print("OpenCodeManagedControlRegressionTests passed")

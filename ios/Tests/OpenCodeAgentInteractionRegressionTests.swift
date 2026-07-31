import Foundation

private func expect(_ condition: @autoclosure () -> Bool, _ message: String) {
    if !condition() { fputs("FAIL: \(message)\n", stderr); exit(1) }
}

let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
func source(_ path: String) throws -> String {
    try String(contentsOf: root.appendingPathComponent(path), encoding: .utf8)
}

let command = try source("ios/Pocketctl/Models/CommandItem.swift")
let event = try source("ios/Pocketctl/Models/WebSocketEvent.swift")
let interaction = try source("ios/Pocketctl/Models/OpenCodeInteraction.swift")
let session = try source("ios/Pocketctl/Models/Session.swift")
let vm = try source("ios/Pocketctl/ViewModels/SessionDetailViewModel.swift")
let view = try source("ios/Pocketctl/Views/SessionDetailView.swift")
let picker = try source("ios/Pocketctl/Views/Components/SessionAgentPicker.swift")
let project = try source("ios/Pocketctl.xcodeproj/project.pbxproj")

for field in ["let template:", "let hints:", "let subtask:", "let agent:", "let model:"] {
    expect(command.contains(field), "CommandItem must retain \(field)")
}
for eventCase in ["sessionAgentList = \"session_agent_list\"", "sessionAgentChanged = \"session_agent_changed\""] {
    expect(event.contains(eventCase), "WebSocketEventType must recognize \(eventCase)")
}
for accessor in ["var currentAgent:", "var sessionAgents:", "var capabilities:", "var operation:"] {
    expect(event.contains(accessor), "WebSocketEvent must expose \(accessor)")
}
expect(interaction.contains("struct OpenCodeSessionAgent"), "typed OpenCode Agent model is required")
expect(interaction.contains("mode == \"primary\" || mode == \"all\""), "only primary/all Agents may be selected")
expect(session.contains("var activeAgent:"), "session list must retain confirmed active_agent")
expect(vm.contains("requestSessionAgents()"), "ViewModel must request dynamic Agent list")
expect(vm.contains("\"type\": \"list_session_agents\""), "ViewModel must send list_session_agents")
expect(vm.contains("\"type\": \"set_session_agent\""), "ViewModel must send set_session_agent")
expect(vm.contains("case .sessionAgentChanged:"), "confirmed Agent changes must be handled")
expect(vm.contains("currentSessionAgent = event.currentAgent"), "current Agent changes only on daemon confirmation")
expect(vm.contains("sessionAgentSubmitting = false"), "failed/confirmed switches must restore UI")
expect(vm.contains("focusedSubAgent == nil"), "focused subagent must remain read-only")
expect(view.contains("SessionAgentPicker("), "composer must render the Agent picker")
expect(picker.contains("Menu"), "Agent picker should use a compact native menu")
expect(project.contains("OpenCodeInteraction.swift in Sources"), "OpenCode interaction models must belong to app target")
expect(project.contains("SessionAgentPicker.swift in Sources"), "Agent picker must belong to app target")

print("OpenCodeAgentInteractionRegressionTests passed")

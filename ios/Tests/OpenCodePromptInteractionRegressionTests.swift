import Foundation

private func expect(_ condition: @autoclosure () -> Bool, _ message: String) {
    if !condition() { fputs("FAIL: \(message)\n", stderr); exit(1) }
}
let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
func source(_ path: String) throws -> String { try String(contentsOf: root.appendingPathComponent(path), encoding: .utf8) }

let event = try source("ios/Pocketctl/Models/WebSocketEvent.swift")
let interaction = try source("ios/Pocketctl/Models/OpenCodeInteraction.swift")
let message = try source("ios/Pocketctl/Models/ChatMessage.swift")
let vm = try source("ios/Pocketctl/ViewModels/SessionDetailViewModel.swift")
let view = try source("ios/Pocketctl/Views/SessionDetailView.swift")
let approval = try source("ios/Pocketctl/Views/Components/ApprovalCard.swift")
let question = try source("ios/Pocketctl/Views/Components/OpenCodeQuestionCard.swift")
let project = try source("ios/Pocketctl.xcodeproj/project.pbxproj")

for eventCase in ["questionRequest = \"question_request\"", "questionResolved = \"question_resolved\""] {
    expect(event.contains(eventCase), "event decoder must recognize \(eventCase)")
}
for accessor in ["var permissionName:", "var patterns:", "var alwaysRules:", "var metadata:", "var questions:", "var answers:", "var rejected:", "var action:"] {
    expect(event.contains(accessor), "event decoder must expose \(accessor)")
}
expect(interaction.contains("struct OpenCodeQuestion"), "typed multi-question model is required")
expect(message.contains("case openCodeQuestion"), "chat stream needs native OpenCode question messages")
for field in ["var permissionName:", "var permissionPatterns:", "var permissionAlways:", "var approvalAction:", "var questions:", "var questionAnswers:", "var interactionSubmitting:", "var interactionError:"] {
    expect(message.contains(field), "ChatMessage must retain \(field)")
}
expect(vm.contains("func respondApproval(requestId: String, action: String)"), "approval must support once/always/reject")
expect(vm.contains("\"action\": action"), "OpenCode approval action must be sent unchanged")
expect(vm.contains("\"approved\": action != \"reject\" && action != \"cancel\""), "legacy approval fallback must remain")
expect(vm.contains("func respondQuestion(requestId: String, answers: [[String]])"), "ordered question answers must be sent atomically")
expect(vm.contains("\"type\": \"question_reject\""), "question rejection must be explicit")
expect(vm.contains("upsertApprovalRequest"), "duplicate approval asked events must upsert")
expect(vm.contains("upsertQuestionRequest"), "duplicate question asked events must upsert")
expect(vm.contains("interactionResolutions"), "resolution tombstones must survive replay ordering")
expect(vm.contains("action: event.action ?? (event.approved ? \"once\" : \"reject\")"), "remote approval action must survive daemon/relay decoding")
expect(vm.contains("answers: event.answers, rejected: event.rejected") && vm.contains("redacted: event.redacted"), "remote ordered question answers and redaction must survive daemon/relay decoding")
expect(vm.contains("\"question_response\", \"question_reject\"") && vm.contains("interactionSubmitting = false"), "failed question replies must restore controls")
expect(view.contains("OpenCodeQuestionCard("), "native question card must render in message stream")
expect(approval.contains("始终允许"), "OpenCode approval card must expose always")
expect(question.contains("orderedAnswers"), "question card must preserve question/option order")
expect(question.contains("TextField"), "question card must support custom input")
expect(project.contains("OpenCodeQuestionCard.swift in Sources"), "question card must belong to app target")

print("OpenCodePromptInteractionRegressionTests passed")

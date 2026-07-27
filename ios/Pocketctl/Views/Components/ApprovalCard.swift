import SwiftUI

/// Tool-use approval card — rendered inline in the chat stream when the daemon
/// surfaces a PreToolUse approval request (non-bypass sessions). Shows the tool,
/// its target (file path / args), and — for file-editing tools — a compact
/// line-level diff preview, with full-width Allow / Deny actions. After the user
/// answers, the buttons are replaced by a result label.
struct ApprovalCard: View {
    let message: ChatMessage
    let supportsActions: Bool
    let disabled: Bool
    /// Invoked with (requestId, once|always|reject) when the user taps a button.
    let onRespond: (String, String) -> Void

    // The diff is derived from the tool input (CPU-bound JSON parse + diff).
    // Compute it ONCE in init (like DiffCard) rather than on every body
    // re-evaluation — re-deriving on each render is a known jank source.
    private let diffBlocks: [DiffBlock]
    private let diffSummary: (additions: Int, deletions: Int)
    private let diffFile: String

    /// Cap the inline preview so a large Write/Edit can't make the card huge.
    private let maxPreviewLines = 12

    init(message: ChatMessage, supportsActions: Bool = false, disabled: Bool = false, onRespond: @escaping (String, String) -> Void) {
        self.message = message
        self.supportsActions = supportsActions
        self.disabled = disabled
        self.onRespond = onRespond
        if let tool = message.tool, DIFF_TOOLS.contains(tool) {
            let b = buildDiffBlocks(inputJSON: message.rawInputJSON, tool: tool)
            self.diffBlocks = b
            self.diffSummary = sumChanges(b)
            self.diffFile = diffFilePath(inputJSON: message.rawInputJSON)
        } else {
            self.diffBlocks = []
            self.diffSummary = (0, 0)
            self.diffFile = ""
        }
    }

    private var isPending: Bool { message.approvalStatus == "pending" }
    private var isCodexApproval: Bool { !message.availableDecisions.isEmpty }
    private var hasDiff: Bool { !diffBlocks.isEmpty }
    private var allDiffLines: [DiffLine] { diffBlocks.flatMap { $0.lines } }
    private var previewLines: [DiffLine] { Array(allDiffLines.prefix(maxPreviewLines)) }
    private var hiddenLineCount: Int { max(0, allDiffLines.count - maxPreviewLines) }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            header
            toolRow
            if hasDiff {
                diffPreview
            } else if !message.inputDescription.isEmpty {
                argsBlock
            }
            if supportsActions { permissionDetails }
            if let error = message.interactionError {
                Text(error).font(PCFont.body(11)).foregroundStyle(Color.pcError)
            }
            actions
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.pcSurface)
        .cornerRadius(PCRadius.lg)
        .overlay(
            RoundedRectangle(cornerRadius: PCRadius.lg)
                .stroke(borderColor, lineWidth: 1)
        )
        .overlay(alignment: .leading) {
            // Left accent bar (web card's border-left). Inset vertically by the
            // corner radius so it spans only the straight part of the left edge.
            RoundedRectangle(cornerRadius: 1.5)
                .fill(accentColor)
                .frame(width: 3)
                .padding(.vertical, PCRadius.lg)
        }
    }

    // MARK: - Header

    private var header: some View {
        HStack(spacing: 6) {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 13))
                .foregroundStyle(Color.pcWarning)
            Text("工具审批")
                .font(PCFont.body(11, weight: .bold))
                .foregroundStyle(Color.pcWarning)
                .textCase(.uppercase)
            Spacer(minLength: 4)
            if isPending {
                HStack(spacing: 5) {
                    Text("等待你的决定")
                        .font(PCFont.body(11))
                        .foregroundStyle(Color.pcFgTertiary)
                    Circle().fill(Color.pcWarning).frame(width: 6, height: 6)
                }
            }
        }
    }

    // MARK: - Tool + target row

    private var toolRow: some View {
        HStack(spacing: 8) {
            Image(systemName: message.toolIcon)
                .font(.system(size: 13))
                .foregroundStyle(Color.pcAccent)
                .frame(width: 16)
            Text(message.tool ?? "Tool")
                .font(PCFont.body(14, weight: .semibold))
                .foregroundStyle(Color.pcAccent)
                .layoutPriority(1)
            if hasDiff && !diffFile.isEmpty {
                Text(diffFile)
                    .font(PCFont.mono(12))
                    .foregroundStyle(Color.pcFgTertiary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            Spacer(minLength: 6)
            if hasDiff {
                // +N -M change summary
                HStack(spacing: 6) {
                    if diffSummary.additions > 0 {
                        Text("+\(diffSummary.additions)")
                            .font(PCFont.mono(11, weight: .semibold))
                            .foregroundStyle(Color.pcSuccess)
                    }
                    if diffSummary.deletions > 0 {
                        Text("-\(diffSummary.deletions)")
                            .font(PCFont.mono(11, weight: .semibold))
                            .foregroundStyle(Color.pcError)
                    }
                }
                .layoutPriority(1)
            }
        }
    }

    // MARK: - Args block (non-diff tools, e.g. Bash command)

    private var argsBlock: some View {
        Text(message.inputDescription)
            .font(PCFont.mono(12))
            .foregroundStyle(Color.pcFgSecondary)
            .lineLimit(3)
            .truncationMode(.tail)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .background(Color.pcCodeBg)
            .cornerRadius(PCRadius.sm)
            .overlay(RoundedRectangle(cornerRadius: PCRadius.sm).stroke(Color.pcBorder, lineWidth: 1))
    }

    @ViewBuilder
    private var permissionDetails: some View {
        if !message.permissionPatterns.isEmpty || !message.permissionAlways.isEmpty || message.permissionMetadata != nil {
            VStack(alignment: .leading, spacing: 6) {
                if !message.permissionPatterns.isEmpty {
                    Text("匹配范围 · \(message.permissionPatterns.joined(separator: ", "))")
                }
                if !message.permissionAlways.isEmpty {
                    Text("可保存规则 · \(message.permissionAlways.joined(separator: ", "))")
                }
                if let metadata = message.permissionMetadata, !metadata.isEmpty {
                    DisclosureGroup("请求详情") {
                        Text(String(metadata.prefix(4000))).font(PCFont.mono(10)).textSelection(.enabled)
                    }
                }
            }
            .font(PCFont.body(11)).foregroundStyle(Color.pcFgTertiary)
            .padding(8).background(Color.pcCodeBg).cornerRadius(PCRadius.sm)
        }
    }

    // MARK: - Compact diff preview (Edit / Write / MultiEdit)

    private var diffPreview: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(previewLines) { line in
                HStack(alignment: .top, spacing: 6) {
                    Text(sign(line.type))
                        .frame(width: 10, alignment: .center)
                        .foregroundStyle(signColor(line.type))
                    Text(line.text.isEmpty ? " " : line.text)
                        .foregroundStyle(Color.pcFg)
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .font(PCFont.mono(11))
                .padding(.vertical, 1.5)
                .padding(.horizontal, 8)
                .background(lineBackground(line.type))
            }
            if hiddenLineCount > 0 {
                Text("… 其余 \(hiddenLineCount) 行")
                    .font(PCFont.body(10))
                    .foregroundStyle(Color.pcFgTertiary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
            }
        }
        .padding(.vertical, 2)
        .background(Color.pcCodeBg)
        .cornerRadius(PCRadius.sm)
        .overlay(RoundedRectangle(cornerRadius: PCRadius.sm).stroke(Color.pcBorder, lineWidth: 1))
    }

    // MARK: - Actions / result

    @ViewBuilder
    private var actions: some View {
        if isPending {
            HStack(spacing: 8) {
                if isCodexApproval {
                    if message.availableDecisions.contains("accept") {
                        actionButton(title: "仅本次允许", icon: "checkmark", fg: .white, bg: Color.pcSuccess) {
                            if let id = message.requestId { onRespond(id, "once") }
                        }
                    }
                    if message.availableDecisions.contains("acceptForSession") {
                        actionButton(title: "始终允许", icon: "checkmark.shield", fg: Color.pcAccent, bg: Color.pcAccentMuted) {
                            if let id = message.requestId { onRespond(id, "always") }
                        }
                    }
                    if message.availableDecisions.contains("decline") {
                        actionButton(title: "拒绝", icon: "xmark", fg: Color.pcError, bg: Color.pcErrorBg) {
                            if let id = message.requestId { onRespond(id, "reject") }
                        }
                    }
                    if message.availableDecisions.contains("cancel") {
                        actionButton(title: "拒绝并停止", icon: "stop.fill", fg: Color.pcError, bg: Color.pcErrorBg) {
                            if let id = message.requestId { onRespond(id, "cancel") }
                        }
                    }
                } else if supportsActions {
                    actionButton(title: "仅本次允许", icon: "checkmark", fg: .white, bg: Color.pcSuccess) {
                        if let id = message.requestId { onRespond(id, "once") }
                    }
                    actionButton(title: "始终允许", icon: "checkmark.shield", fg: Color.pcAccent, bg: Color.pcAccentMuted, extraDisabled: message.permissionAlways.isEmpty) {
                        if let id = message.requestId { onRespond(id, "always") }
                    }
                    actionButton(title: "拒绝", icon: "xmark", fg: Color.pcError, bg: Color.pcErrorBg) {
                        if let id = message.requestId { onRespond(id, "reject") }
                    }
                } else {
                    actionButton(title: "允许", icon: "checkmark", fg: .white, bg: Color.pcSuccess) {
                        if let id = message.requestId { onRespond(id, "once") }
                    }
                    actionButton(title: "拒绝", icon: "xmark", fg: Color.pcError, bg: Color.pcErrorBg) {
                        if let id = message.requestId { onRespond(id, "reject") }
                    }
                }
            }
        } else {
            let neutralReasons: Set<String> = ["resolved_elsewhere", "timed_out", "daemon_restarted", "hook_disconnected", "session_drained", "server_shutdown"]
            let isNeutralResolution = message.interactionResolutionReason.map(neutralReasons.contains) == true
            HStack(spacing: 5) {
                Image(systemName: isNeutralResolution ? "minus.circle" : (["reject", "cancel"].contains(message.approvalAction ?? "") || message.approvalStatus == "denied" ? "xmark.circle.fill" : "checkmark.circle.fill"))
                    .font(.system(size: 12))
                Text(message.interactionResolutionReason == "resolved_elsewhere" ? "已在其他设备处理" : (isNeutralResolution ? "审批已关闭" : (message.approvalAction == "always" ? "已始终允许" : (["reject", "cancel"].contains(message.approvalAction ?? "") || message.approvalStatus == "denied" ? "已拒绝" : "已允许"))))
                    .font(PCFont.body(12, weight: .semibold))
            }
            .foregroundStyle(isNeutralResolution ? Color.pcFgSecondary : (["reject", "cancel"].contains(message.approvalAction ?? "") || message.approvalStatus == "denied" ? Color.pcError : Color.pcSuccess))
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
            .background(isNeutralResolution ? Color.pcCodeBg : (["reject", "cancel"].contains(message.approvalAction ?? "") || message.approvalStatus == "denied" ? Color.pcErrorBg : Color.pcSuccessBg))
            .clipShape(Capsule())
        }
    }

    private func actionButton(title: String, icon: String, fg: Color, bg: Color, extraDisabled: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: icon)
                .font(PCFont.body(14, weight: .semibold))
                .foregroundStyle(fg)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 9)
                .background(bg)
                .cornerRadius(PCRadius.md)
        }
        .buttonStyle(.plain)
        .disabled(disabled || message.interactionSubmitting || extraDisabled)
        .opacity(disabled || message.interactionSubmitting || extraDisabled ? 0.45 : 1)
    }

    // MARK: - Diff line styling (mirrors DiffCard)

    private func sign(_ t: DiffLineType) -> String {
        switch t {
        case .add: return "+"
        case .del: return "-"
        case .ctx: return ""
        }
    }
    private func signColor(_ t: DiffLineType) -> Color {
        switch t {
        case .add: return .pcSuccess
        case .del: return .pcError
        case .ctx: return .pcFgTertiary
        }
    }
    private func lineBackground(_ t: DiffLineType) -> Color {
        switch t {
        case .add: return Color.pcSuccess.opacity(0.12)
        case .del: return Color.pcError.opacity(0.12)
        case .ctx: return .clear
        }
    }

    private var accentColor: Color {
        let neutralReasons: Set<String> = ["resolved_elsewhere", "timed_out", "daemon_restarted", "hook_disconnected", "session_drained", "server_shutdown"]
        if message.interactionResolutionReason.map(neutralReasons.contains) == true { return .pcFgTertiary }
        switch message.approvalStatus {
        case "allowed": return .pcSuccess
        case "denied": return .pcError
        default: return .pcWarning
        }
    }

    private var borderColor: Color {
        let neutralReasons: Set<String> = ["resolved_elsewhere", "timed_out", "daemon_restarted", "hook_disconnected", "session_drained", "server_shutdown"]
        if message.interactionResolutionReason.map(neutralReasons.contains) == true { return .pcBorder }
        switch message.approvalStatus {
        case "allowed": return .pcSuccess
        case "denied": return .pcError
        default: return .pcBorder
        }
    }
}

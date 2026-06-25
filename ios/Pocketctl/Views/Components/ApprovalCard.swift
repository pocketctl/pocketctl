import SwiftUI

/// Tool-use approval card — rendered inline in the chat stream when the daemon
/// surfaces a PreToolUse approval request (non-bypass sessions). Shows the tool
/// and its arguments with Allow / Deny buttons. After the user answers, the
/// buttons are replaced by a result label.
struct ApprovalCard: View {
    let message: ChatMessage
    /// Invoked with (requestId, approved) when the user taps a button.
    let onRespond: (String, Bool) -> Void

    private var isPending: Bool { message.approvalStatus == "pending" }

    var body: some View {
        VStack(alignment: .leading, spacing: PCSpacing.sm) {
            // Header: warning icon + title + waiting indicator
            HStack(spacing: 6) {
                Image(systemName: "exclamationmark.triangle")
                    .font(.system(size: 13))
                    .foregroundStyle(Color.pcWarning)
                Text("工具审批")
                    .font(PCFont.body(11, weight: .bold))
                    .foregroundStyle(Color.pcWarning)
                    .textCase(.uppercase)
                if isPending {
                    Spacer()
                    HStack(spacing: 5) {
                        Circle()
                            .fill(Color.pcWarning)
                            .frame(width: 6, height: 6)
                        Text("等待你的决定")
                            .font(PCFont.body(11))
                            .foregroundStyle(Color.pcFgTertiary)
                    }
                }
            }

            // Tool + args
            HStack(spacing: 8) {
                Text(message.tool ?? "Tool")
                    .font(PCFont.mono(13, weight: .semibold))
                    .foregroundStyle(Color.pcAccent)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 2)
                    .background(Color.pcAccentMuted)
                    .cornerRadius(PCRadius.sm)
                if !message.inputDescription.isEmpty {
                    Text(message.inputDescription)
                        .font(PCFont.mono(12))
                        .foregroundStyle(Color.pcFgSecondary)
                        .lineLimit(2)
                }
            }

            // Actions / result
            if isPending {
                HStack(spacing: 8) {
                    Button {
                        if let id = message.requestId { onRespond(id, true) }
                    } label: {
                        Label("允许", systemImage: "checkmark")
                            .font(PCFont.body(13, weight: .semibold))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 6)
                            .background(Color.pcSuccess)
                            .cornerRadius(PCRadius.md)
                    }
                    .buttonStyle(.plain)

                    Button {
                        if let id = message.requestId { onRespond(id, false) }
                    } label: {
                        Label("拒绝", systemImage: "xmark")
                            .font(PCFont.body(13, weight: .semibold))
                            .foregroundStyle(Color.pcFgSecondary)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 6)
                            .background(Color.pcSurface)
                            .overlay(
                                RoundedRectangle(cornerRadius: PCRadius.md)
                                    .stroke(Color.pcBorder, lineWidth: 1)
                            )
                            .cornerRadius(PCRadius.md)
                    }
                    .buttonStyle(.plain)
                }
            } else {
                Text(message.approvalStatus == "allowed" ? "已允许" : "已拒绝")
                    .font(PCFont.body(12, weight: .semibold))
                    .foregroundStyle(message.approvalStatus == "allowed" ? Color.pcSuccess : Color.pcError)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 4)
                    .background(message.approvalStatus == "allowed" ? Color.pcSuccessBg : Color.pcErrorBg)
                    .clipShape(Capsule())
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.pcSurface)
        .cornerRadius(PCRadius.lg)
        .overlay(
            // Left accent bar colored by state (warning → success/error).
            RoundedRectangle(cornerRadius: PCRadius.lg)
                .stroke(borderColor, lineWidth: 1)
        )
        .overlay(alignment: .leading) {
            // Colored left edge to match the web card's border-left.
            Rectangle()
                .fill(accentColor)
                .frame(width: 3)
                .clipShape(RoundedCornerShape(radius: PCRadius.lg, corners: [.topLeft, .bottomLeft]))
        }
    }

    private var accentColor: Color {
        switch message.approvalStatus {
        case "allowed": return .pcSuccess
        case "denied": return .pcError
        default: return .pcWarning
        }
    }

    private var borderColor: Color {
        switch message.approvalStatus {
        case "allowed": return .pcSuccess
        case "denied": return .pcError
        default: return .pcBorder
        }
    }
}

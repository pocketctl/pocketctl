import SwiftUI

/// Slash command execution receipt card — shows the outcome of a command like
/// /compact, /clear, /model. Aligns 1:1 with the web CommandReceiptCard:
/// left status bar (3pt) + status icon + command name + optional message.
struct CommandReceiptCard: View {
    let message: ChatMessage

    private var statusColor: Color {
        switch message.receiptStatus {
        case "success":     return .pcAccent      // neutral info tone, not loud green
        case "failed":      return .pcError
        case "unavailable": return .pcFgTertiary
        default:            return .pcFgTertiary
        }
    }

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            // Left status bar (3pt), matching web's border-left
            Rectangle()
                .fill(statusColor)
                .frame(width: 3)
                .clipShape(RoundedCornerShape(radius: 3, corners: .allCorners))

            // Status icon
            Image(systemName: message.receiptIcon)
                .font(.system(size: 13, weight: .bold))
                .foregroundStyle(statusColor)
                .frame(width: 16)
                .padding(.top, 1)

            // Command name (mono, accent)
            if !message.command.isEmpty {
                Text(message.command)
                    .font(PCFont.mono(13, weight: .semibold))
                    .foregroundStyle(Color.pcAccent)
            }

            // Optional message (single line, truncated)
            if !message.content.isEmpty {
                Text(message.content)
                    .font(PCFont.body(12))
                    .foregroundStyle(Color.pcFgSecondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }

            Spacer(minLength: 0)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.pcSurface)
        .cornerRadius(PCRadius.sm)
        .overlay(
            RoundedRectangle(cornerRadius: PCRadius.sm)
                .stroke(Color.pcBorder, lineWidth: 1)
        )
    }
}

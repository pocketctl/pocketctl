import SwiftUI

/// Interactive selection card — rendered inline when the daemon scans a
/// selection menu the agent's TUI drew to the PTY (e.g. a host PreToolUse
/// hook's "Do you want to proceed? ❶ Yes ❷ No" prompt that never reaches the
/// JSONL history). Shows the prompt text and a tappable, numbered option list.
/// Tapping an option sends interactive_response back so the daemon writes the
/// index to the PTY and the agent's blocking prompt proceeds. After answering,
/// the chosen row is highlighted and the rest dimmed.
struct InteractiveChoiceCard: View {
    let message: ChatMessage
    /// Invoked with (requestId, choiceIndex) when the user taps an option.
    let onRespond: (String, String) -> Void

    private var isPending: Bool { message.selectedChoice == nil }

    var body: some View {
        VStack(alignment: .leading, spacing: PCSpacing.sm) {
            // Header: warning icon + title + waiting indicator
            HStack(spacing: 6) {
                Image(systemName: "exclamationmark.triangle")
                    .font(.system(size: 13))
                    .foregroundStyle(Color.pcWarning)
                Text("需要你的选择")
                    .font(PCFont.body(11, weight: .bold))
                    .foregroundStyle(Color.pcWarning)
                    .textCase(.uppercase)
                if isPending {
                    Spacer()
                    HStack(spacing: 5) {
                        Circle()
                            .fill(Color.pcWarning)
                            .frame(width: 6, height: 6)
                        Text("等待你的选择")
                            .font(PCFont.body(11))
                            .foregroundStyle(Color.pcFgTertiary)
                    }
                }
            }

            // Prompt text (the question phrase parsed from the menu)
            if !message.promptText.isEmpty {
                Text(message.promptText)
                    .font(PCFont.mono(13))
                    .foregroundStyle(Color.pcFg)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            // Numbered options
            VStack(spacing: 6) {
                ForEach(Array(message.promptOptions.enumerated()), id: \.offset) { _, opt in
                    optionRow(opt)
                }
            }
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
            Rectangle()
                .fill(accentColor)
                .frame(width: 3)
                .clipShape(RoundedCornerShape(radius: PCRadius.lg, corners: [.topLeft, .bottomLeft]))
        }
    }

    @ViewBuilder
    private func optionRow(_ opt: (index: String, label: String)) -> some View {
        let isSelected = !isPending && message.selectedChoice == opt.index
        let isDimmed = !isPending && message.selectedChoice != opt.index

        Button {
            guard isPending else { return }
            if let id = message.requestId { onRespond(id, opt.index) }
        } label: {
            HStack(spacing: 8) {
                // Numbered index circle
                Text(opt.index)
                    .font(PCFont.mono(12, weight: .bold))
                    .foregroundStyle(isSelected ? Color.white : Color.pcAccent)
                    .frame(width: 22, height: 22)
                    .background(isSelected ? Color.pcSuccess : Color.pcAccentMuted)
                    .clipShape(Circle())

                Text(opt.label)
                    .font(PCFont.body(13, weight: isSelected ? .semibold : .medium))
                    .foregroundStyle(isSelected ? Color.pcSuccess : Color.pcFg)

                Spacer()

                if isSelected {
                    Image(systemName: "checkmark")
                        .font(.system(size: 13, weight: .bold))
                        .foregroundStyle(Color.pcSuccess)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(isSelected ? Color.pcSuccessBg : Color.pcBackground)
            .cornerRadius(PCRadius.md)
            .overlay(
                RoundedRectangle(cornerRadius: PCRadius.md)
                    .stroke(isSelected ? Color.pcSuccess : Color.pcBorder, lineWidth: 1)
            )
            .opacity(isDimmed ? 0.45 : 1)
        }
        .buttonStyle(.plain)
        .disabled(!isPending)
    }

    private var accentColor: Color {
        isPending ? .pcWarning : .pcSuccess
    }

    private var borderColor: Color {
        isPending ? .pcBorder : .pcSuccess
    }
}

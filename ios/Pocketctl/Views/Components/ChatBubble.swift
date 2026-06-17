import SwiftUI

/// Renders a single chat message.
///
/// Layout is hybrid (matches the web client and codex/zcode clients):
/// - **user**: right-aligned bubble with an asymmetric corner (tail).
/// - **agent**: full-width block with a 3pt accent bar on the left and no
///   bubble background — code, tables and lists get the full column width.
/// - **error**: full-width block with a 3pt error bar and tinted background.
struct ChatBubble: View {
    let message: ChatMessage

    var body: some View {
        Group {
            switch message.role {
            case .user:
                userBubble
            case .agent:
                if message.type == .error {
                    errorBlock
                } else {
                    agentBlock
                }
            }
        }
    }

    // MARK: - User (right bubble, kept as-is)

    private var userBubble: some View {
        HStack {
            Spacer(minLength: 15)
            Text(message.content)
                .font(PCFont.body(15))
                .foregroundStyle(.white)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(Color.pcUserBubble)
                .cornerRadius(16)
                .mask(
                    RoundedCornerShape(radius: 16, corners: [.topLeft, .topRight, .bottomLeft])
                )
        }
    }

    // MARK: - Agent (full-width block, no left bar — clean text flow)

    private var agentBlock: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("assistant")
                .font(PCFont.body(11, weight: .semibold))
                .foregroundStyle(Color.pcFgTertiary)
                .textCase(.uppercase)
                .kerning(0.6)

            // Agent body: markdown rendering (tables, lists, code, etc.)
            MarkdownContentView(content: message.content)
                .foregroundStyle(Color.pcFg)

            if message.streaming {
                Text("▎")
                    .font(PCFont.body(15))
                    .foregroundStyle(Color.pcAccent)
                    .opacity(blinkOpacity)
                    .onAppear {
                        withAnimation(.easeInOut(duration: 0.6).repeatForever(autoreverses: true)) {
                            blinkOpacity = 0
                        }
                    }
            }
        }
    }

    // MARK: - Error (full-width tinted block, no left bar)

    private var errorBlock: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "exclamationmark.circle")
                .font(.system(size: 13))
                .foregroundStyle(Color.pcError)
                .padding(.top, 2)

            Text(message.content)
                .font(PCFont.body(13))
                .foregroundStyle(Color.pcError)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.pcErrorBg.opacity(0.5))
        .cornerRadius(PCRadius.sm)
    }

    @State private var blinkOpacity: Double = 1
}

// MARK: - Rounded corner shape

struct RoundedCornerShape: Shape {
    let radius: CGFloat
    let corners: UIRectCorner

    func path(in rect: CGRect) -> Path {
        let path = UIBezierPath(
            roundedRect: rect,
            byRoundingCorners: corners,
            cornerRadii: CGSize(width: radius, height: radius)
        )
        return Path(path.cgPath)
    }
}

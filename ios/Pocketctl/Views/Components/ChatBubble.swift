import SwiftUI

struct ChatBubble: View {
    let message: ChatMessage

    var body: some View {
        HStack {
            if message.role == .user { Spacer(minLength: 15) }

            contentView
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(bubbleBackground)
                .cornerRadius(16)
                .if(message.role == .user) { view in
                    view.mask(
                        RoundedCornerShape(radius: 16, corners: [.topLeft, .topRight, .bottomLeft])
                    )
                }
                .if(message.role == .agent) { view in
                    view.mask(
                        RoundedCornerShape(radius: 16, corners: [.topLeft, .topRight, .bottomRight])
                    )
                }
                .overlay(
                    Group {
                        if message.streaming {
                            // Blinking cursor
                            Text("▎")
                                .font(PCFont.body(15))
                                .foregroundStyle(Color.pcAccent)
                                .opacity(blinkOpacity)
                        }
                    },
                    alignment: .trailing
                )

            if message.role == .agent { Spacer(minLength: 15) }
        }
    }

    @ViewBuilder
    private var contentView: some View {
        if message.role == .user {
            Text(message.content)
                .font(PCFont.body(15))
                .foregroundStyle(.white)
        } else {
            // Agent messages: render with markdown support (tables, etc.)
            MarkdownContentView(content: message.content)
                .foregroundStyle(Color.pcFg)
        }
    }

    private var bubbleBackground: Color {
        switch message.role {
        case .user: return .pcUserBubble
        case .agent:
            if message.type == .error { return .pcErrorBg }
            return Color(red: 0.133, green: 0.149, blue: 0.176) // #21262d
        }
    }

    @State private var blinkOpacity: Double = 1

    private var cursorBlink: some View {
        Text("▎")
            .font(PCFont.body(15))
            .foregroundStyle(Color.pcAccent)
            .onAppear {
                withAnimation(.easeInOut(duration: 0.6).repeatForever(autoreverses: true)) {
                    blinkOpacity = 0
                }
            }
    }
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

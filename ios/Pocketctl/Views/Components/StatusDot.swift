import SwiftUI

struct StatusDot: View {
    let status: String
    var size: CGFloat = 10

    var body: some View {
        Circle()
            .fill(dotColor)
            .frame(width: size, height: size)
            .if(isPulsing) { view in
                view.modifier(PulseEffect(color: dotColor))
            }
    }

    private var dotColor: Color {
        switch status {
        case "online", "running": return .pcSuccess
        case "busy": return .pcWarning
        case "idle": return Color(hex: 0xEAB308)
        case "waiting", "waiting_approval": return Color(hex: 0xF97316)
        case "completed": return .pcAccent
        case "error": return .pcError
        case "offline", "disconnected": return .pcFgTertiary
        default: return .pcFgTertiary
        }
    }

    private var isPulsing: Bool {
        ["online", "running", "busy"].contains(status)
    }
}

struct PulseEffect: ViewModifier {
    let color: Color
    @State private var pulsing = false

    func body(content: Content) -> some View {
        content
            .shadow(color: color.opacity(pulsing ? 0.6 : 0), radius: pulsing ? 6 : 0)
            .onAppear {
                withAnimation(.easeInOut(duration: 1.5).repeatForever(autoreverses: true)) {
                    pulsing = true
                }
            }
    }
}

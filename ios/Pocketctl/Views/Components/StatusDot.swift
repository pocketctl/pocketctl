import SwiftUI

struct StatusDot: View {
    let status: String
    var size: CGFloat = 10

    var body: some View {
        if isPulsing {
            // 活跃状态：用「缩放 + 透明度」的圆环扩散代替 shadow 脉冲。
            // shadow 动画会触发逐帧离屏栅格化，列表里多张卡片同时跑会明显掉帧；
            // 圆环只改 transform / opacity，是 GPU 友好的合成操作。
            ZStack {
                Circle()
                    .fill(dotColor.opacity(0.35))
                    .frame(width: size, height: size)
                    .scaleEffect(pulsing ? 1.8 : 1.0)
                    .opacity(pulsing ? 0 : 0.6)
                Circle()
                    .fill(dotColor)
                    .frame(width: size, height: size)
            }
            .onAppear { startPulse() }
        } else {
            Circle()
                .fill(dotColor)
                .frame(width: size, height: size)
        }
    }

    @State private var pulsing = false

    private func startPulse() {
        // 触发一次，repeatForever 让它持续；避免 onAppear 重复调用时叠加动画。
        guard !pulsing else { return }
        withAnimation(.easeOut(duration: 1.4).repeatForever(autoreverses: false)) {
            pulsing = true
        }
    }

    private var dotColor: Color {
        switch status {
        case "online", "running": return .pcSuccess
        case "busy": return .pcWarning
        case "idle": return .pcIdle
        case "waiting", "waiting_approval": return .pcWaiting
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

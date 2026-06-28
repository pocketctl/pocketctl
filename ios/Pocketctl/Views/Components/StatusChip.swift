import SwiftUI

struct StatusChip: View {
    let text: String
    let style: ChipStyle

    enum ChipStyle {
        case terminal, web, subAgent
        case status(String) // status name
        case agent(String)  // agent type → brand color
    }

    var body: some View {
        Text(text)
            .font(PCFont.body(12, weight: .medium))
            .foregroundStyle(fgColor)
            .padding(.horizontal, 10)
            .padding(.vertical, 3)
            .background(bgColor)
            .cornerRadius(PCRadius.full)
    }

    private var fgColor: Color {
        switch style {
        case .terminal: return .pcAccent
        case .web: return .pcSuccess
        case .subAgent: return .pcSubAgent
        case .agent(let t): return agentVisual(t).color
        case .status(let s):
            switch s {
            case "completed": return .pcAccent
            case "error": return .pcError
            case "running": return .pcSuccess
            default: return .pcFgSecondary
            }
        }
    }

    private var bgColor: Color {
        switch style {
        case .terminal: return .pcAccentMuted
        case .web: return .pcSuccessBg
        case .subAgent: return .pcSubAgentBg
        case .agent(let t): return agentVisual(t).color.opacity(0.14)
        case .status(let s):
            switch s {
            case "completed": return .pcAccentMuted
            case "error": return .pcErrorBg
            case "running": return .pcSuccessBg
            default: return .pcHoverInput
            }
        }
    }
}

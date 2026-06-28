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
        // Agent chip: brand abbreviation badge + name (e.g. [CC] Claude Code)
        if case .agent(let t) = style {
            let visual = agentVisual(t)
            HStack(spacing: 4) {
                Text(visual.abbrev)
                    .font(PCFont.body(9, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: 14, height: 14)
                    .background(visual.color)
                    .cornerRadius(3)
                Text(text)
                    .font(PCFont.body(12, weight: .medium))
                    .foregroundStyle(visual.color)
            }
            .padding(.horizontal, 6)
            .padding(.vertical, 3)
            .background(visual.color.opacity(0.14))
            .cornerRadius(PCRadius.full)
        } else {
            Text(text)
                .font(PCFont.body(12, weight: .medium))
                .foregroundStyle(fgColor)
                .padding(.horizontal, 10)
                .padding(.vertical, 3)
                .background(bgColor)
                .cornerRadius(PCRadius.full)
        }
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

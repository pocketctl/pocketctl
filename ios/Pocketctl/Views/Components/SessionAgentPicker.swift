import SwiftUI

struct SessionAgentPicker: View {
    let agents: [OpenCodeSessionAgent]
    let currentAgent: String?
    let loading: Bool
    let error: String?
    let disabled: Bool
    let submitting: Bool
    let onSelect: (String) -> Void
    let onRetry: () -> Void

    var body: some View {
        Group {
            if loading {
                HStack(spacing: 5) {
                    ProgressView().controlSize(.mini)
                    Text("Agent")
                }
            } else if error != nil {
                Button(action: onRetry) {
                    Label("Agent", systemImage: "arrow.clockwise")
                }
                .accessibilityHint(error ?? "")
            } else {
                Menu {
                    ForEach(agents) { agent in
                        Button {
                            onSelect(agent.name)
                        } label: {
                            if agent.name == currentAgent {
                                Label(agent.name, systemImage: "checkmark")
                            } else {
                                Text(agent.name)
                            }
                        }
                        .disabled(agent.name == currentAgent)
                    }
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "circle.hexagongrid")
                        Text(currentAgent ?? "Agent")
                            .lineLimit(1)
                        if submitting { ProgressView().controlSize(.mini) }
                        else { Image(systemName: "chevron.up.chevron.down").font(.system(size: 9)) }
                    }
                }
                .disabled(disabled || submitting || agents.isEmpty)
            }
        }
        .font(PCFont.body(12, weight: .semibold))
        .foregroundStyle(Color.pcAccent)
        .accessibilityLabel("OpenCode Agent")
    }
}

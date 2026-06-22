import SwiftUI

struct SubAgentCard: View {
    let subAgent: SubAgent
    @Binding var messages: [ChatMessage]

    @State private var isExpanded = false

    var body: some View {
        // Full-width sub-agent card. No left bar; the card itself is the
        // visual container (border + sub-agent tinted bg).
        cardBody
    }

    private var cardBody: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Header
            Button {
                withAnimation(.easeInOut(duration: 0.2)) {
                    isExpanded.toggle()
                }
            } label: {
                HStack(spacing: 10) {
                    Image(systemName: "sparkles")
                        .font(.system(size: 13))
                        .foregroundStyle(Color.pcSubAgent)
                        .frame(width: 18)

                    Text(subAgent.agentType)
                        .font(PCFont.body(12, weight: .medium))
                        .foregroundStyle(Color.pcSubAgent)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Color.pcSubAgentBg)
                        .cornerRadius(PCRadius.sm)

                    Text(String(subAgent.description.prefix(60)))
                        .font(PCFont.body(13))
                        .foregroundStyle(Color.pcFgSecondary)
                        .lineLimit(1)

                    Spacer()

                    statusBadge

                    Text("\(subAgent.messages.count)")
                        .font(PCFont.mono(11))
                        .foregroundStyle(Color.pcFgTertiary)

                    Image(systemName: "chevron.right")
                        .font(.system(size: 10))
                        .foregroundStyle(Color.pcFgTertiary)
                        .rotationEffect(.degrees(isExpanded ? 90 : 0))
                }
                .padding(10)
            }
            .buttonStyle(.plain)

            // Body
            if isExpanded {
                Divider()
                    .background(Color.pcSubAgent.opacity(0.2))

                VStack(alignment: .leading, spacing: 6) {
                    ForEach(subAgent.messages) { msg in
                        if msg.type == .agentText {
                            Text(msg.content)
                                .font(PCFont.body(13))
                                .foregroundStyle(Color.pcFg)
                                .padding(8)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(Color.pcSubAgentBg.opacity(0.5))
                                .cornerRadius(PCRadius.sm)
                        } else if msg.type == .toolCall {
                            HStack(spacing: 8) {
                                Image(systemName: msg.toolIcon)
                                    .font(.system(size: 11))
                                    .foregroundStyle(Color.pcAccent)
                                    .frame(width: 14)
                                Text(msg.tool ?? "")
                                    .font(PCFont.mono(12, weight: .medium))
                                    .foregroundStyle(Color.pcAccent)
                                Text(msg.inputDescription)
                                    .font(PCFont.mono(11))
                                    .foregroundStyle(Color.pcFgTertiary)
                                    .lineLimit(1)
                                Spacer()
                                if msg.isRunning {
                                    ProgressView()
                                        .tint(.pcFgTertiary)
                                        .scaleEffect(0.7)
                                } else {
                                    Text("✓")
                                        .font(.system(size: 12))
                                        .foregroundStyle(Color.pcSuccess)
                                }
                            }
                            .padding(8)
                            .background(Color.pcSubAgentBg.opacity(0.3))
                            .cornerRadius(PCRadius.sm)
                        }
                    }
                }
                .padding(10)
            }
        }
        .background(Color.pcSubAgentBg)
        .cornerRadius(PCRadius.md)
        .overlay(
            RoundedRectangle(cornerRadius: PCRadius.md)
                .stroke(Color.pcSubAgent.opacity(0.2), lineWidth: 1)
        )
    }

    @ViewBuilder
    private var statusBadge: some View {
        switch subAgent.status {
        case "running":
            Text("运行中")
                .font(PCFont.body(11, weight: .medium))
                .foregroundStyle(.white)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(Color.pcAccent)
                .cornerRadius(PCRadius.full)
        case "error":
            Text("出错")
                .font(PCFont.body(11, weight: .medium))
                .foregroundStyle(.white)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(Color.pcError)
                .cornerRadius(PCRadius.full)
        default:
            Text("完成")
                .font(PCFont.body(11, weight: .medium))
                .foregroundStyle(.white)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(Color.pcSuccess)
                .cornerRadius(PCRadius.full)
        }
    }
}

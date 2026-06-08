import SwiftUI

struct NewSessionSheet: View {
    let daemon: Daemon
    let onCreate: (String, String, String) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var selectedAgent = "claude-code"
    @State private var workingDir = ""
    @State private var prompt = ""

    private let agents = ["claude-code", "codex"]

    var body: some View {
        VStack(spacing: 0) {
            // Drag handle
            RoundedRectangle(cornerRadius: 3)
                .fill(Color.pcFgTertiary)
                .frame(width: 36, height: 5)
                .padding(.top, 16)
                .padding(.bottom, 16)

            // Title
            Text("新建会话")
                .font(PCFont.display(20, weight: .semibold))
                .foregroundStyle(Color.pcFg)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, PCSpacing.xxl)
                .padding(.bottom, 20)

            // Agent type selector
            HStack(spacing: PCSpacing.sm) {
                ForEach(agents, id: \.self) { agent in
                    Button {
                        selectedAgent = agent
                    } label: {
                        Text(agent == "claude-code" ? "Claude Code" : "Codex")
                            .font(PCFont.body(15, weight: .medium))
                            .foregroundStyle(selectedAgent == agent ? Color.pcBackground : Color.pcFgSecondary)
                            .padding(.horizontal, 20)
                            .padding(.vertical, 10)
                            .background(selectedAgent == agent ? Color.pcAccent : Color.pcHoverInput)
                            .cornerRadius(PCRadius.full)
                    }
                }
            }
            .padding(.horizontal, PCSpacing.xxl)
            .padding(.bottom, 20)

            // Working directory
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    Image(systemName: "folder")
                        .font(.system(size: 14))
                        .foregroundStyle(Color.pcFgSecondary)
                    Text("工作目录")
                        .font(PCFont.body(13))
                        .foregroundStyle(Color.pcFgSecondary)
                }

                TextField("/path/to/project", text: $workingDir)
                    .font(PCFont.mono(14))
                    .foregroundStyle(Color.pcFg)
                    .padding(PCSpacing.md)
                    .background(Color.pcBackground)
                    .cornerRadius(PCRadius.md)
                    .overlay(
                        RoundedRectangle(cornerRadius: PCRadius.md)
                            .stroke(Color.pcBorder, lineWidth: 1)
                    )
            }
            .padding(.horizontal, PCSpacing.xxl)
            .padding(.bottom, 16)

            // Initial prompt
            VStack(alignment: .leading, spacing: 6) {
                Text("初始提示")
                    .font(PCFont.body(13))
                    .foregroundStyle(Color.pcFgSecondary)

                TextField("描述你想要 AI 完成的任务...", text: $prompt, axis: .vertical)
                    .font(PCFont.body(15))
                    .foregroundStyle(Color.pcFg)
                    .lineLimit(3...8)
                    .padding(PCSpacing.md)
                    .background(Color.pcBackground)
                    .cornerRadius(PCRadius.md)
                    .overlay(
                        RoundedRectangle(cornerRadius: PCRadius.md)
                            .stroke(Color.pcBorder, lineWidth: 1)
                    )
            }
            .padding(.horizontal, PCSpacing.xxl)
            .padding(.bottom, 24)

            // Start button
            Button {
                onCreate(selectedAgent, workingDir, prompt)
            } label: {
                Text("开始会话")
                    .font(PCFont.display(17, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 16)
                    .background(prompt.isEmpty ? Color.pcPrimaryBtn.opacity(0.5) : Color.pcPrimaryBtn)
                    .cornerRadius(PCRadius.md)
            }
            .disabled(prompt.isEmpty)
            .padding(.horizontal, PCSpacing.xxl)
            .padding(.bottom, 32)
        }
        .background(Color.pcSurface)
        .cornerRadius(PCRadius.xl, corners: [.topLeft, .topRight])
    }
}

// MARK: - Corner radius extension for specific corners

extension View {
    func cornerRadius(_ radius: CGFloat, corners: UIRectCorner) -> some View {
        clipShape(RoundedCornerShape(radius: radius, corners: corners))
    }
}

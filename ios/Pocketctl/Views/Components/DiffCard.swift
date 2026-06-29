import SwiftUI

/// Diff card for Edit/MultiEdit/Write tool calls. Same full-width card shell as
/// ToolCallCard, but the body renders a line-level diff (green additions / red
/// deletions) computed from the tool input. Swift port of the web DiffCard.vue.
///
/// `blocks`/`summary`/`filePath`/`totalLines` 在 init 中一次性预算——它们依赖
/// JSON 解析与 diff 计算（CPU 密集）。原实现把它们写成计算属性，导致键盘动画
/// 期间 body 被反复求值时 diff 被重复计算，是会话详情页卡顿的主要来源之一。
/// `visibleBlocks` 仍为计算属性，但它只做数组切片，成本可忽略。
struct DiffCard: View {
    let message: ChatMessage
    @Binding var messages: [ChatMessage]
    let messageIndex: Int
    /// Whether the hosting session may still emit new tool events. When false
    /// (terminal session), orphan tool_calls render as finished instead of
    /// forever-spinning "执行中".
    let sessionActive: Bool

    @State private var isExpanded = false
    @State private var isOutputExpanded = false

    private let collapsedLines = 50

    // MARK: - Pre-computed (init)

    private let blocks: [DiffBlock]
    private let summary: (additions: Int, deletions: Int)
    private let filePath: String
    private let totalLines: Int
    private var isNewFile: Bool { message.tool == "Write" && summary.deletions == 0 }
    private var isLong: Bool { totalLines > collapsedLines }

    init(message: ChatMessage, messages: Binding<[ChatMessage]>, messageIndex: Int, sessionActive: Bool) {
        self.message = message
        self._messages = messages
        self.messageIndex = messageIndex
        self.sessionActive = sessionActive

        self.blocks = buildDiffBlocks(inputJSON: message.rawInputJSON, tool: message.tool)
        self.summary = sumChanges(self.blocks)
        self.filePath = diffFilePath(inputJSON: message.rawInputJSON)
        self.totalLines = self.blocks.reduce(0) { $0 + $1.lines.count }
    }

    /// Collapse: show only the first `collapsedLines` across all blocks.
    /// Cheap array slicing — safe to keep as a computed property.
    private var visibleBlocks: [DiffBlock] {
        guard isLong, !isOutputExpanded else { return blocks }
        var remaining = collapsedLines
        var out: [DiffBlock] = []
        for var b in blocks {
            if remaining <= 0 { break }
            if b.lines.count > remaining {
                b.lines = Array(b.lines.prefix(remaining))
            }
            remaining -= b.lines.count
            out.append(b)
        }
        return out
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            if isExpanded {
                Divider().background(Color.pcBorder)
                body_
            }
        }
        .background(Color.pcSurface)
        .cornerRadius(PCRadius.md)
        .overlay(
            RoundedRectangle(cornerRadius: PCRadius.md)
                .stroke(Color.pcBorder, lineWidth: 1)
        )
    }

    // MARK: - Header

    private var header: some View {
        Button {
            withAnimation(.easeInOut(duration: 0.2)) {
                isExpanded.toggle()
                messages[messageIndex].expanded = isExpanded
            }
        } label: {
            HStack(spacing: 10) {
                Image(systemName: message.toolIcon)
                    .font(.system(size: 14))
                    .foregroundStyle(Color.pcAccent)
                    .frame(width: 18)

                Text(message.tool ?? "Unknown")
                    .font(PCFont.body(14, weight: .semibold))
                    .foregroundStyle(Color.pcAccent)

                Text(filePath)
                    .font(PCFont.mono(12))
                    .foregroundStyle(Color.pcFgTertiary)
                    .lineLimit(1)
                    .truncationMode(.middle)

                if isNewFile {
                    Text("新文件")
                        .font(PCFont.body(10, weight: .semibold))
                        .foregroundStyle(Color.pcSuccess)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Color.pcSuccess.opacity(0.14))
                        .cornerRadius(4)
                }

                Spacer()

                if message.isRunning(sessionActive: sessionActive) {
                    ProgressView().tint(.pcFgTertiary).scaleEffect(0.8)
                } else {
                    Text("✓").font(.system(size: 14)).foregroundStyle(Color.pcSuccess)
                }

                Image(systemName: "chevron.right")
                    .font(.system(size: 12))
                    .foregroundStyle(Color.pcFgTertiary)
                    .rotationEffect(.degrees(isExpanded ? 90 : 0))
            }
            .padding(PCSpacing.md)
        }
        .buttonStyle(.plain)
    }

    // MARK: - Body

    @ViewBuilder
    private var body_: some View {
        // The diff is derived from the tool INPUT, which is present the moment
        // the tool_call arrives — it must not wait on the tool_result/output.
        // Only fall back to a running placeholder when there's no diff data yet.
        if blocks.isEmpty {
            if message.isRunning(sessionActive: sessionActive) {
                HStack(spacing: 8) {
                    ProgressView().tint(.pcAccent).scaleEffect(0.8)
                    Text("执行中...")
                        .font(PCFont.body(14))
                        .foregroundStyle(Color.pcFgSecondary)
                }
                .padding(PCSpacing.md)
            } else {
                // Terminal session without diff data nor output (orphan tool_call).
                Text("无输出")
                    .font(PCFont.body(13))
                    .foregroundStyle(Color.pcFgTertiary)
                    .padding(PCSpacing.md)
            }
        } else {
            VStack(alignment: .leading, spacing: 8) {
                // Summary: +N -M
                HStack(spacing: 12) {
                    Text("+\(summary.additions)")
                        .font(PCFont.mono(12)).foregroundStyle(Color.pcSuccess)
                    Text("-\(summary.deletions)")
                        .font(PCFont.mono(12)).foregroundStyle(Color.pcError)
                }

                ForEach(visibleBlocks) { block in
                    if let idx = block.index {
                        Text("编辑 \(idx)")
                            .font(PCFont.body(11, weight: .medium))
                            .foregroundStyle(Color.pcFgTertiary)
                            .textCase(.uppercase)
                            .kerning(0.5)
                    }
                    diffTable(block)
                }

                if isLong {
                    Button {
                        isOutputExpanded.toggle()
                    } label: {
                        Text(isOutputExpanded ? "收起" : "展开全部 (\(totalLines) 行)")
                            .font(PCFont.body(12))
                            .foregroundStyle(Color.pcAccent)
                    }
                }
            }
            .padding(PCSpacing.md)
        }
    }

    private func diffTable(_ block: DiffBlock) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(block.lines) { line in
                HStack(alignment: .top, spacing: 0) {
                    Text(line.oldLine.map(String.init) ?? "")
                        .frame(width: 30, alignment: .trailing)
                    Text(line.newLine.map(String.init) ?? "")
                        .frame(width: 30, alignment: .trailing)
                        .padding(.trailing, 6)
                    Text(sign(line.type))
                        .frame(width: 12, alignment: .center)
                        .foregroundStyle(signColor(line.type))
                    Text(line.text.isEmpty ? " " : line.text)
                        .foregroundStyle(Color.pcFg)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.leading, 6)
                        .textSelection(.enabled)
                }
                .font(PCFont.mono(12))
                .padding(.vertical, 1)
                .background(lineBackground(line.type))
            }
        }
        .background(Color.pcCodeBg)
        .cornerRadius(PCRadius.sm)
        .overlay(
            RoundedRectangle(cornerRadius: PCRadius.sm).stroke(Color.pcBorder, lineWidth: 1)
        )
    }

    private func sign(_ t: DiffLineType) -> String {
        switch t {
        case .add: return "+"
        case .del: return "-"
        case .ctx: return ""
        }
    }
    private func signColor(_ t: DiffLineType) -> Color {
        switch t {
        case .add: return .pcSuccess
        case .del: return .pcError
        case .ctx: return .clear
        }
    }
    private func lineBackground(_ t: DiffLineType) -> Color {
        switch t {
        case .add: return Color.pcSuccess.opacity(0.12)
        case .del: return Color.pcError.opacity(0.12)
        case .ctx: return .clear
        }
    }
}

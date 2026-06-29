import SwiftUI

/// Tool-call card (Bash / Read / Grep / ...). Edit/MultiEdit/Write are handled
/// by `DiffCard`; AskUserQuestion by `QuestionCard`.
///
/// input/output 的语法高亮结果在 init 中一次性预算（折叠态 + 展开态各一份），
/// body 只读取常量。这避免键盘动画期间 body 被反复求值时重复执行逐字符分词
/// ——这是会话详情页唤起键盘卡顿的主要 CPU 来源之一。output 通常在 tool_result
/// 到达后即终态，message 变化时会触发 init 重跑，因此高亮始终与最新内容一致。
struct ToolCallCard: View {
    let message: ChatMessage
    @Binding var messages: [ChatMessage]
    let messageIndex: Int
    /// Whether the hosting session may still emit new tool events. When false
    /// (terminal session), orphan tool_calls render as finished instead of
    /// forever-spinning "执行中".
    let sessionActive: Bool

    @State private var isExpanded = false
    @State private var isOutputExpanded = false

    // MARK: - Pre-computed (init) highlight results

    private let hasInput: Bool
    private let highlightedInput: AttributedString

    private let hasOutput: Bool
    private let highlightedOutputCollapsed: AttributedString
    private let highlightedOutputFull: AttributedString
    private let isOutputLongCached: Bool
    private let outputLineCount: Int

    init(message: ChatMessage, messages: Binding<[ChatMessage]>, messageIndex: Int, sessionActive: Bool) {
        self.message = message
        self._messages = messages
        self.messageIndex = messageIndex
        self.sessionActive = sessionActive

        // Input highlight (inputDescription is stable once the tool_call arrives)
        let inputLang = Self.inferInputLanguage(tool: message.tool)
        if !message.inputDescription.isEmpty {
            self.hasInput = true
            self.highlightedInput = SyntaxHighlighter.highlight(message.inputDescription, language: inputLang)
        } else {
            self.hasInput = false
            self.highlightedInput = AttributedString()
        }

        // Output highlight (output is terminal after tool_result; re-highlight on
        // message change via init re-run). Two flavors: collapsed (truncated) +
        // full; identical when output isn't long.
        let outputLang = Self.inferOutputLanguage(
            tool: message.tool,
            inputDescription: message.inputDescription,
            output: message.output
        )
        if let output = message.output, !output.isEmpty {
            self.hasOutput = true
            self.isOutputLongCached = message.isOutputLong
            self.outputLineCount = output.components(separatedBy: "\n").count
            let truncated = message.truncatedOutput ?? output
            self.highlightedOutputCollapsed = SyntaxHighlighter.highlight(truncated, language: outputLang)
            if message.isOutputLong {
                self.highlightedOutputFull = SyntaxHighlighter.highlight(output, language: outputLang)
            } else {
                self.highlightedOutputFull = self.highlightedOutputCollapsed
            }
        } else {
            self.hasOutput = false
            self.isOutputLongCached = false
            self.outputLineCount = 0
            self.highlightedOutputCollapsed = AttributedString()
            self.highlightedOutputFull = AttributedString()
        }
    }

    var body: some View {
        // Full-width tool card. No left bar (too noisy); the card itself
        // (border + surface bg) is the visual container.
        cardBody
    }

    private var cardBody: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Header
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

                    Text(message.toolSummary)
                        .font(PCFont.mono(12))
                        .foregroundStyle(Color.pcFgTertiary)
                        .lineLimit(1)
                        .truncationMode(.tail)

                    Spacer()

                    if message.isRunning(sessionActive: sessionActive) {
                        ProgressView()
                            .tint(.pcFgTertiary)
                            .scaleEffect(0.8)
                    } else {
                        Text("✓")
                            .font(.system(size: 14))
                            .foregroundStyle(Color.pcSuccess)
                    }

                    Image(systemName: "chevron.right")
                        .font(.system(size: 12))
                        .foregroundStyle(Color.pcFgTertiary)
                        .rotationEffect(.degrees(isExpanded ? 90 : 0))
                }
                .padding(PCSpacing.md)
            }
            .buttonStyle(.plain)

            // Body
            if isExpanded {
                Divider()
                    .background(Color.pcBorder)

                VStack(alignment: .leading, spacing: 8) {
                    // Input section
                    if hasInput {
                        Text("输入")
                            .font(PCFont.body(11, weight: .medium))
                            .foregroundStyle(Color.pcFgTertiary)
                            .textCase(.uppercase)
                            .kerning(0.5)

                        ScrollView(.horizontal, showsIndicators: false) {
                            Text(highlightedInput)
                                .font(PCFont.mono(12))
                                .padding(PCSpacing.sm)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .background(Color.pcCodeBg)
                        .cornerRadius(PCRadius.sm)
                    }

                    // Output section
                    if hasOutput {
                        Text("输出")
                            .font(PCFont.body(11, weight: .medium))
                            .foregroundStyle(Color.pcFgTertiary)
                            .textCase(.uppercase)
                            .kerning(0.5)

                        ScrollView(.horizontal, showsIndicators: false) {
                            Text(isOutputExpanded ? highlightedOutputFull : highlightedOutputCollapsed)
                                .font(PCFont.mono(12))
                                .padding(PCSpacing.sm)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .background(Color.pcCodeBg)
                        .cornerRadius(PCRadius.sm)

                        if isOutputLongCached {
                            Button {
                                isOutputExpanded.toggle()
                            } label: {
                                Text(isOutputExpanded ? "收起" : "展开全部 (\(outputLineCount) 行)")
                                    .font(PCFont.body(12))
                                    .foregroundStyle(Color.pcAccent)
                            }
                        }
                    } else if message.isRunning(sessionActive: sessionActive) {
                        HStack(spacing: 8) {
                            ProgressView()
                                .tint(.pcAccent)
                                .scaleEffect(0.8)
                            Text("执行中...")
                                .font(PCFont.body(14))
                                .foregroundStyle(Color.pcFgSecondary)
                        }
                    } else {
                        // Terminal session with no captured output (orphan tool_call).
                        Text("无输出")
                            .font(PCFont.body(13))
                            .foregroundStyle(Color.pcFgTertiary)
                    }
                }
                .padding(PCSpacing.md)
            }
        }
        .background(Color.pcSurface)
        .cornerRadius(PCRadius.md)
        .overlay(
            RoundedRectangle(cornerRadius: PCRadius.md)
                .stroke(Color.pcBorder, lineWidth: 1)
        )
    }

    // MARK: - Language inference (static — used by init)

    /// Infer language for input based on tool type
    private static func inferInputLanguage(tool: String?) -> String? {
        switch tool {
        case "Bash": return "bash"
        case "Read", "Write", "Edit": return nil // path description, not code
        case "Grep", "Glob": return nil // pattern, not code
        default: return nil
        }
    }

    /// Infer language for output based on tool type and output content
    private static func inferOutputLanguage(tool: String?, inputDescription: String, output: String?) -> String? {
        guard let output = output, !output.isEmpty else { return nil }

        switch tool {
        case "Bash": return "bash"
        case "Read", "Write": return detectLanguageFromPath(inputDescription) ?? detectLanguageFromContent(output)
        case "Edit": return detectLanguageFromPath(inputDescription) ?? detectLanguageFromContent(output)
        case "Grep": return detectLanguageFromContent(output)
        default: return detectLanguageFromContent(output)
        }
    }

    /// Detect language from file path extension
    private static func detectLanguageFromPath(_ path: String) -> String? {
        let extMap: [String: String] = [
            "swift": "swift", "go": "go", "ts": "typescript", "tsx": "typescript",
            "js": "javascript", "jsx": "javascript", "py": "python",
            "sh": "bash", "bash": "bash", "zsh": "bash",
            "sql": "sql", "json": "json", "html": "html", "css": "css",
            "vue": "html", "xml": "xml", "yaml": "yaml", "yml": "yaml",
            "md": "markdown", "rs": "rust", "rb": "ruby", "java": "java",
        ]
        // Extract extension from path-like input (e.g. "📝 main.swift" or "/path/to/file.go")
        let components = path.components(separatedBy: .whitespaces)
        for component in components {
            let ext = (component as NSString).pathExtension.lowercased()
            if let lang = extMap[ext] { return lang }
        }
        return nil
    }

    /// Detect language from content heuristics
    private static func detectLanguageFromContent(_ content: String) -> String? {
        let trimmed = content.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.hasPrefix("{") || trimmed.hasPrefix("[") { return "json" }
        if trimmed.hasPrefix("#!") { return "bash" }
        if trimmed.hasPrefix("<?xml") || trimmed.hasPrefix("<!DOCTYPE") { return "html" }
        if trimmed.hasPrefix("package ") && trimmed.contains("import") { return "go" }
        if trimmed.contains("import SwiftUI") || trimmed.contains("func ") && trimmed.contains("var ") { return "swift" }
        if trimmed.hasPrefix("SELECT") || trimmed.hasPrefix("select") { return "sql" }
        return nil
    }
}

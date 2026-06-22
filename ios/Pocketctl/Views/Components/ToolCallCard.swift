import SwiftUI

struct ToolCallCard: View {
    let message: ChatMessage
    @Binding var messages: [ChatMessage]
    let messageIndex: Int

    @State private var isExpanded = false
    @State private var isOutputExpanded = false

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

                    if message.isRunning {
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
                    if !message.inputDescription.isEmpty {
                        Text("输入")
                            .font(PCFont.body(11, weight: .medium))
                            .foregroundStyle(Color.pcFgTertiary)
                            .textCase(.uppercase)
                            .kerning(0.5)

                        ScrollView(.horizontal, showsIndicators: false) {
                            Text(SyntaxHighlighter.highlight(message.inputDescription, language: inputLanguage))
                                .font(PCFont.mono(12))
                                .padding(PCSpacing.sm)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .background(Color.pcCodeBg)
                        .cornerRadius(PCRadius.sm)
                    }

                    // Output section
                    if let output = message.output, !output.isEmpty {
                        Text("输出")
                            .font(PCFont.body(11, weight: .medium))
                            .foregroundStyle(Color.pcFgTertiary)
                            .textCase(.uppercase)
                            .kerning(0.5)

                        let isLong = message.isOutputLong
                        let displayOutput = isOutputExpanded ? output : (message.truncatedOutput ?? output)

                        ScrollView(.horizontal, showsIndicators: false) {
                            Text(SyntaxHighlighter.highlight(displayOutput, language: outputLanguage))
                                .font(PCFont.mono(12))
                                .padding(PCSpacing.sm)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .background(Color.pcCodeBg)
                        .cornerRadius(PCRadius.sm)

                        if isLong {
                            Button {
                                isOutputExpanded.toggle()
                            } label: {
                                Text(isOutputExpanded ? "收起" : "展开全部 (\(output.components(separatedBy: "\n").count) 行)")
                                    .font(PCFont.body(12))
                                    .foregroundStyle(Color.pcAccent)
                            }
                        }
                    } else if message.isRunning {
                        HStack(spacing: 8) {
                            ProgressView()
                                .tint(.pcAccent)
                                .scaleEffect(0.8)
                            Text("执行中...")
                                .font(PCFont.body(14))
                                .foregroundStyle(Color.pcFgSecondary)
                        }
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

    // MARK: - Language inference

    /// Infer language for input based on tool type
    private var inputLanguage: String? {
        switch message.tool {
        case "Bash": return "bash"
        case "Read", "Write", "Edit": return nil // path description, not code
        case "Grep", "Glob": return nil // pattern, not code
        default: return nil
        }
    }

    /// Infer language for output based on tool type and output content
    private var outputLanguage: String? {
        guard let output = message.output, !output.isEmpty else { return nil }

        switch message.tool {
        case "Bash": return "bash"
        case "Read", "Write": return detectLanguageFromPath(message.inputDescription) ?? detectLanguageFromContent(output)
        case "Edit": return detectLanguageFromPath(message.inputDescription) ?? detectLanguageFromContent(output)
        case "Grep": return detectLanguageFromContent(output)
        default: return detectLanguageFromContent(output)
        }
    }

    /// Detect language from file path extension
    private func detectLanguageFromPath(_ path: String) -> String? {
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
    private func detectLanguageFromContent(_ content: String) -> String? {
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

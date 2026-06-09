import SwiftUI

/// Renders markdown content with proper table formatting
struct MarkdownContentView: View {
    let content: String

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(parseSegments().enumerated()), id: \.offset) { _, segment in
                switch segment {
                case .text(let text):
                    renderText(text)

                case .table(let headers, let rows):
                    TableView(headers: headers, rows: rows)

                case .codeBlock(let language, let code):
                    CodeBlockView(code: code, language: language)
                }
            }
        }
    }

    // MARK: - Text rendering with inline formatting

    @ViewBuilder
    private func renderText(_ text: String) -> some View {
        let parts = parseInlineFormatting(text)
        InlineFormattedText(parts: parts)
    }

    private enum InlinePart {
        case plain(String)
        case bold(String)
        case code(String)
    }

    private struct InlineFormattedText: View {
        let parts: [InlinePart]

        var body: some View {
            // Build attributed text by concatenating Text views
            parts.reduce(Text("")) { result, part in
                switch part {
                case .plain(let str):
                    return result + Text(str).font(PCFont.body(15)).foregroundStyle(Color.pcFg)
                case .bold(let str):
                    return result + Text(str).font(PCFont.body(15, weight: .bold)).foregroundStyle(Color.pcFg)
                case .code(let str):
                    return result + Text(str)
                        .font(PCFont.mono(13))
                        .foregroundStyle(Color.pcAccent)
                }
            }
            .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func parseInlineFormatting(_ text: String) -> [InlinePart] {
        var parts: [InlinePart] = []
        var current = ""
        var i = text.startIndex

        while i < text.endIndex {
            // Check for inline code
            if text[i] == "`" {
                if !current.isEmpty {
                    parts.append(.plain(current))
                    current = ""
                }
                let afterTick = text.index(after: i)
                if let endTick = text[afterTick...].firstIndex(of: "`") {
                    let code = String(text[afterTick..<endTick])
                    parts.append(.code(code))
                    i = text.index(after: endTick)
                    continue
                }
            }

            // Check for bold
            if i < text.index(text.endIndex, offsetBy: -1) &&
               text[i] == "*" && text[text.index(after: i)] == "*" {
                if !current.isEmpty {
                    parts.append(.plain(current))
                    current = ""
                }
                let afterBold = text.index(i, offsetBy: 2)
                if let endBold = text[afterBold...].range(of: "**") {
                    let bold = String(text[afterBold..<endBold.lowerBound])
                    parts.append(.bold(bold))
                    i = endBold.upperBound
                    continue
                }
            }

            current.append(text[i])
            i = text.index(after: i)
        }

        if !current.isEmpty {
            parts.append(.plain(current))
        }

        return parts.isEmpty ? [.plain(text)] : parts
    }

    // MARK: - Parsing

    private enum Segment {
        case text(String)
        case table(headers: [String], rows: [[String]])
        case codeBlock(language: String?, code: String)
    }

    private func parseSegments() -> [Segment] {
        let sanitized = sanitizeCommandTags(content)
        let lines = sanitized.components(separatedBy: "\n")
        var segments: [Segment] = []
        var currentText: [String] = []
        var tableLines: [String] = []
        var codeBlockLines: [String] = []
        var codeBlockLanguage: String? = nil
        var inCodeBlock = false

        func flushText() {
            let text = currentText.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty {
                segments.append(.text(text))
            }
            currentText = []
        }

        func flushTable() {
            guard tableLines.count >= 2 else {
                currentText.append(contentsOf: tableLines)
                tableLines = []
                return
            }

            let headerLine = tableLines[0]
            let headers = parseTableRow(headerLine)

            var rows: [[String]] = []
            for i in 2..<tableLines.count {
                rows.append(parseTableRow(tableLines[i]))
            }

            segments.append(.table(headers: headers, rows: rows))
            tableLines = []
        }

        func flushCodeBlock() {
            let code = codeBlockLines.joined(separator: "\n")
            segments.append(.codeBlock(language: codeBlockLanguage, code: code))
            codeBlockLines = []
            codeBlockLanguage = nil
        }

        for line in lines {
            let trimmed = line.trimmingCharacters(in: .whitespaces)

            // Check for code block start/end
            if trimmed.hasPrefix("```") {
                if inCodeBlock {
                    // End of code block
                    inCodeBlock = false
                    flushCodeBlock()
                } else {
                    // Start of code block
                    flushText()
                    if !tableLines.isEmpty { flushTable() }
                    inCodeBlock = true
                    let langPart = trimmed.dropFirst(3).trimmingCharacters(in: .whitespaces)
                    codeBlockLanguage = langPart.isEmpty ? nil : String(langPart)
                }
                continue
            }

            // If inside code block, collect lines
            if inCodeBlock {
                codeBlockLines.append(line)
                continue
            }

            // Table detection
            if isTableLine(trimmed) {
                if isSeparatorLine(trimmed) && !tableLines.isEmpty {
                    tableLines.append(line)
                } else if tableLines.isEmpty {
                    flushText()
                    tableLines.append(line)
                } else {
                    tableLines.append(line)
                }
            } else {
                if !tableLines.isEmpty {
                    flushTable()
                }
                currentText.append(line)
            }
        }

        // Flush remaining content
        if inCodeBlock {
            flushCodeBlock()
        }
        if !tableLines.isEmpty {
            flushTable()
        }
        flushText()

        return segments
    }

    private func isTableLine(_ line: String) -> Bool {
        guard line.hasPrefix("|") || line.contains("|") else { return false }
        let pipeCount = line.filter({ $0 == "|" }).count
        return pipeCount >= 2
    }

    private func isSeparatorLine(_ line: String) -> Bool {
        let stripped = line.replacingOccurrences(of: "|", with: "")
            .replacingOccurrences(of: "-", with: "")
            .replacingOccurrences(of: " ", with: "")
            .replacingOccurrences(of: ":", with: "")
        return stripped.isEmpty
    }

    private func parseTableRow(_ line: String) -> [String] {
        var trimmed = line.trimmingCharacters(in: .whitespaces)
        if trimmed.hasPrefix("|") {
            trimmed = String(trimmed.dropFirst())
        }
        if trimmed.hasSuffix("|") {
            trimmed = String(trimmed.dropLast())
        }
        return trimmed.components(separatedBy: "|").map {
            $0.trimmingCharacters(in: .whitespaces)
        }
    }

    // MARK: - Command tag sanitization

    /// Strip Claude Code command tags and convert to terminal-like display
    private func sanitizeCommandTags(_ text: String) -> String {
        var result = text

        // Remove local-command-caveat wrapper, keep inner content
        result = stripTag(result, tag: "local-command-caveat")

        // Remove command-name tag, show as clean text
        result = stripTag(result, tag: "command-name")

        // Remove command-message tag
        result = stripTag(result, tag: "command-message")

        // Remove empty command-args
        result = result.replacingOccurrences(
            of: #"<command-args>.*?</command-args>"#,
            with: "",
            options: .regularExpression
        )

        // Remove local-command-stdout wrapper, keep inner content
        result = stripTag(result, tag: "local-command-stdout")

        // Clean up excessive blank lines left by tag removal
        result = result.replacingOccurrences(of: #"\n{3,}"#, with: "\n\n", options: .regularExpression)

        return result.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Remove opening and closing tags, keep the content between them
    private func stripTag(_ text: String, tag: String) -> String {
        let openPattern = #"<\#(tag)[^>]*>"#
        let closePattern = #"</\#(tag)>"#
        var result = text
        result = result.replacingOccurrences(of: openPattern, with: "", options: .regularExpression)
        result = result.replacingOccurrences(of: closePattern, with: "", options: .regularExpression)
        return result
    }
}

// MARK: - Table View (GitHub Markdown style)

private struct TableView: View {
    let headers: [String]
    let rows: [[String]]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Header row
            HStack(spacing: 0) {
                ForEach(Array(headers.enumerated()), id: \.offset) { col, header in
                    cellView(text: header, isHeader: true)
                        .frame(minWidth: 70, alignment: colAlignment(col))
                }
            }
            .background(Color.pcCodeBg)

            // Header bottom border
            Rectangle()
                .fill(Color.pcBorder)
                .frame(height: 1)

            // Data rows
            ForEach(Array(rows.enumerated()), id: \.offset) { rowIndex, row in
                HStack(spacing: 0) {
                    ForEach(Array(row.enumerated()), id: \.offset) { col, cell in
                        cellView(text: cell, isHeader: false)
                            .frame(minWidth: 70, alignment: colAlignment(col))
                    }
                    // Fill remaining columns if row shorter than header
                    if row.count < headers.count {
                        ForEach(row.count..<headers.count, id: \.self) { _ in
                            cellView(text: "", isHeader: false)
                                .frame(minWidth: 70)
                        }
                    }
                }
                .background(rowIndex % 2 == 0 ? Color.clear : Color.pcCodeBg.opacity(0.3))

                // Row border
                if rowIndex < rows.count - 1 {
                    Rectangle()
                        .fill(Color.pcBorder.opacity(0.5))
                        .frame(height: 0.5)
                }
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: PCRadius.sm))
        .overlay(
            RoundedRectangle(cornerRadius: PCRadius.sm)
                .stroke(Color.pcBorder, lineWidth: 1)
        )
    }

    @ViewBuilder
    private func cellView(text: String, isHeader: Bool) -> some View {
        if isHeader {
            Text(text)
                .font(PCFont.body(13, weight: .semibold))
                .foregroundStyle(Color.pcFg)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            Text(text)
                .font(PCFont.body(13))
                .foregroundStyle(Color.pcFgSecondary)
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func colAlignment(_ col: Int) -> Alignment {
        // First column left-aligned, others center (common markdown convention)
        return .leading
    }
}

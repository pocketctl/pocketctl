import SwiftUI

/// Renders markdown content with CommonMark-ish support.
///
/// Block types: headings, paragraphs (with inline formatting), fenced code
/// blocks, GFM tables, ordered/unordered lists, task lists, and blockquotes.
/// Inline formatting: **bold**, `code`, [links](url), and ~~strikethrough~~.
///
/// This is a self-contained parser (no third-party dependency) tuned for the
/// limited markdown subset AI coding agents actually emit.
struct MarkdownContentView: View {
    // Bridge to the file-level model types so internal parsing code can keep
    // using the short names (Segment/ListItem/TaskState/InlinePart).
    private typealias Segment = MDSegment
    private typealias ListItem = MDListItem
    private typealias TaskState = MDTaskState
    private typealias InlinePart = MDInlinePart

    let content: String

    /// Pre-computed parsed segments — computed once in init, not on every body call
    private let segments: [Segment]

    init(content: String) {
        self.content = content
        let sanitized = Self.sanitizeCommandTags(content)
        self.segments = Self.parseSegments(sanitized)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(segments.enumerated()), id: \.offset) { _, segment in
                switch segment {
                case .heading(let level, let inline):
                    headingView(level: level, inline: inline)

                case .paragraph(let inline):
                    InlineFormattedText(parts: inline)
                        .fixedSize(horizontal: false, vertical: true)

                case .quote(let inlineParts):
                    QuoteView(parts: inlineParts)

                case .list(let ordered, let items):
                    ListView(ordered: ordered, items: items)

                case .table(let headers, let rows):
                    TableView(headers: headers, rows: rows)

                case .codeBlock(let language, let code):
                    CodeBlockView(code: code, language: language)
                }
            }
        }
    }

    // MARK: - Heading view

    private func headingView(level: Int, inline: [InlinePart]) -> some View {
        let size: CGFloat
        switch level {
        case 1: size = 22
        case 2: size = 19
        case 3: size = 17
        case 4: size = 16
        default: size = 15
        }
        return InlineFormattedText(parts: inline, baseSize: size, baseWeight: .semibold, isHeading: true)
            .fixedSize(horizontal: false, vertical: true)
    }

    // MARK: - Inline formatting parser

    /// Parse inline markdown into typed parts. Supports: `code`, **bold**,
    /// *italic*, ~~strike~~, [text](url). Falls back to plain text otherwise.
    private static func parseInlineFormatting(_ text: String) -> [InlinePart] {
        var parts: [InlinePart] = []
        var current = ""
        var i = text.startIndex

        func flushPlain() {
            if !current.isEmpty {
                parts.append(.plain(current))
                current = ""
            }
        }

        while i < text.endIndex {
            // Inline code: `...`
            if text[i] == "`" {
                let afterTick = text.index(after: i)
                if let endTick = text[afterTick...].firstIndex(of: "`") {
                    flushPlain()
                    let code = String(text[afterTick..<endTick])
                    parts.append(.code(code))
                    i = text.index(after: endTick)
                    continue
                }
            }

            // Link: [text](url)
            if text[i] == "[", let close = findMatching(text, start: i) {
                let textPart = String(text[text.index(after: i)..<close])
                let afterClose = text.index(after: close)
                if afterClose < text.endIndex, text[afterClose] == "(",
                   let parenClose = text[afterClose...].firstIndex(of: ")") {
                    let url = String(text[text.index(after: afterClose)..<parenClose])
                    if !url.isEmpty || !textPart.isEmpty {
                        flushPlain()
                        parts.append(.link(text: textPart, url: url))
                        i = text.index(after: parenClose)
                        continue
                    }
                }
            }

            // Bold: **...** (check before italic since both start with *)
            if i < text.index(text.endIndex, offsetBy: -1, limitedBy: text.endIndex) ?? text.endIndex,
               text[i] == "*",
               let next = text.index(i, offsetBy: 1, limitedBy: text.endIndex), next < text.endIndex,
               text[next] == "*" {
                let afterBold = text.index(i, offsetBy: 2)
                if let endBold = text[afterBold...].range(of: "**") {
                    flushPlain()
                    let bold = String(text[afterBold..<endBold.lowerBound])
                    parts.append(.bold(bold))
                    i = endBold.upperBound
                    continue
                }
            }

            // Italic: *...*
            if text[i] == "*" {
                let afterItalic = text.index(after: i)
                if let endItalic = text[afterItalic...].firstIndex(of: "*") {
                    flushPlain()
                    let italic = String(text[afterItalic..<endItalic])
                    if !italic.isEmpty {
                        parts.append(.italic(italic))
                        i = text.index(after: endItalic)
                        continue
                    }
                }
            }

            // Strikethrough: ~~...~~
            if text[i] == "~",
               let next = text.index(i, offsetBy: 1, limitedBy: text.endIndex), next < text.endIndex,
               text[next] == "~" {
                let afterStrike = text.index(i, offsetBy: 2)
                if let endStrike = text[afterStrike...].range(of: "~~") {
                    flushPlain()
                    let strike = String(text[afterStrike..<endStrike.lowerBound])
                    parts.append(.strikethrough(strike))
                    i = endStrike.upperBound
                    continue
                }
            }

            current.append(text[i])
            i = text.index(after: i)
        }

        flushPlain()
        return parts.isEmpty ? [.plain(text)] : parts
    }

    /// Find the closing ] for a [ ... ] starting at `start`, tolerating
    /// nested brackets. Returns nil if unbalanced.
    private static func findMatching(_ text: String, start: String.Index) -> String.Index? {
        var depth = 0
        var i = start
        while i < text.endIndex {
            if text[i] == "[" { depth += 1 }
            else if text[i] == "]" {
                depth -= 1
                if depth == 0 { return i }
            }
            i = text.index(after: i)
        }
        return nil
    }

    // MARK: - Block-level parsing
    // (Segment / ListItem / TaskState / InlinePart types are declared at
    //  file scope below so the file-private helper views can also use them.)

    private static func parseSegments(_ sanitized: String) -> [Segment] {
        let lines = sanitized.components(separatedBy: "\n")
        var segments: [Segment] = []
        var paragraphLines: [String] = []
        var tableLines: [String] = []
        var codeBlockLines: [String] = []
        var codeBlockLanguage: String? = nil
        var inCodeBlock = false
        var listBuffer: ListBuffer? = nil
        var quoteLines: [String] = []

        func flushParagraph() {
            let text = paragraphLines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty {
                segments.append(.paragraph(parseInlineFormatting(text)))
            }
            paragraphLines = []
        }

        func flushTable() {
            guard tableLines.count >= 2 else {
                paragraphLines.append(contentsOf: tableLines)
                tableLines = []
                return
            }
            let headers = parseTableRow(tableLines[0])
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

        func flushList() {
            if let buf = listBuffer {
                if let seg = buf.finalize() { segments.append(seg) }
                listBuffer = nil
            }
        }

        func flushQuote() {
            if !quoteLines.isEmpty {
                let parts = quoteLines.map { parseInlineFormatting($0) }
                segments.append(.quote(parts))
                quoteLines = []
            }
        }

        func flushAllText() {
            flushList()
            flushQuote()
            flushParagraph()
        }

        for line in lines {
            let trimmed = line.trimmingCharacters(in: .whitespaces)

            // Fenced code block toggle
            if trimmed.hasPrefix("```") {
                if inCodeBlock {
                    inCodeBlock = false
                    flushCodeBlock()
                } else {
                    flushAllText()
                    if !tableLines.isEmpty { flushTable() }
                    inCodeBlock = true
                    let langPart = trimmed.dropFirst(3).trimmingCharacters(in: .whitespaces)
                    codeBlockLanguage = langPart.isEmpty ? nil : String(langPart)
                }
                continue
            }

            if inCodeBlock {
                codeBlockLines.append(line)
                continue
            }

            // Heading: # .. ######
            if let level = headingLevel(trimmed) {
                flushAllText()
                if !tableLines.isEmpty { flushTable() }
                let title = String(trimmed.drop(while: { $0 == "#" }).trimmingCharacters(in: .whitespaces))
                segments.append(.heading(level: level, parseInlineFormatting(title)))
                continue
            }

            // Blockquote: lines starting with >
            if trimmed.hasPrefix(">") {
                flushList()
                flushParagraph()
                if !tableLines.isEmpty { flushTable() }
                let content = String(trimmed.dropFirst().trimmingCharacters(in: .whitespaces))
                quoteLines.append(content)
                continue
            } else if !quoteLines.isEmpty {
                // blank or non-quote line ends the quote
                flushQuote()
            }

            // List item: -, *, +, or digit.
            if isListMarkerLine(trimmed) {
                flushParagraph()
                if !tableLines.isEmpty { flushTable() }
                if listBuffer == nil { listBuffer = ListBuffer() }
                listBuffer!.append(line: trimmed)
                continue
            } else if listBuffer != nil {
                // A non-list line ends the current list group (unless it's a
                // continuation indent, which we don't support beyond the
                // already-captured sub-items).
                if trimmed.isEmpty {
                    // blank line: keep buffering in case list continues after
                    continue
                }
                flushList()
            }

            // Table detection
            if isTableLine(trimmed) {
                flushParagraph()
                flushList()
                if isSeparatorLine(trimmed) && !tableLines.isEmpty {
                    tableLines.append(line)
                } else if tableLines.isEmpty {
                    tableLines.append(line)
                } else {
                    tableLines.append(line)
                }
            } else {
                if !tableLines.isEmpty { flushTable() }
                paragraphLines.append(line)
            }
        }

        if inCodeBlock { flushCodeBlock() }
        if !tableLines.isEmpty { flushTable() }
        flushList()
        flushQuote()
        flushParagraph()

        return segments
    }

    private static func headingLevel(_ line: String) -> Int? {
        var count = 0
        for ch in line {
            if ch == "#" { count += 1 } else { break }
            if count > 6 { return nil }
        }
        // must be followed by whitespace (or end) to be a heading
        if count == 0 { return nil }
        let idx = line.index(line.startIndex, offsetBy: count)
        if idx >= line.endIndex { return count }
        return line[idx].isWhitespace ? count : nil
    }

    private static func isListMarkerLine(_ line: String) -> Bool {
        // "- ", "* ", "+ " or "1. ", "12) "
        if line.hasPrefix("- ") || line.hasPrefix("* ") || line.hasPrefix("+ ") {
            return true
        }
        // ordered: digits followed by . or )
        var idx = line.startIndex
        var sawDigit = false
        while idx < line.endIndex, line[idx].isNumber {
            sawDigit = true
            idx = line.index(after: idx)
        }
        guard sawDigit, idx < line.endIndex else { return false }
        let marker = line[idx]
        if marker == "." || marker == ")" {
            let after = line.index(after: idx)
            return after < line.endIndex && line[after].isWhitespace
        }
        return false
    }

    private static func isTableLine(_ line: String) -> Bool {
        guard line.hasPrefix("|") || line.contains("|") else { return false }
        let pipeCount = line.filter({ $0 == "|" }).count
        return pipeCount >= 2
    }

    private static func isSeparatorLine(_ line: String) -> Bool {
        let stripped = line.replacingOccurrences(of: "|", with: "")
            .replacingOccurrences(of: "-", with: "")
            .replacingOccurrences(of: " ", with: "")
            .replacingOccurrences(of: ":", with: "")
        return stripped.isEmpty
    }

    private static func parseTableRow(_ line: String) -> [String] {
        var trimmed = line.trimmingCharacters(in: .whitespaces)
        if trimmed.hasPrefix("|") { trimmed = String(trimmed.dropFirst()) }
        if trimmed.hasSuffix("|") { trimmed = String(trimmed.dropLast()) }
        return trimmed.components(separatedBy: "|").map {
            $0.trimmingCharacters(in: .whitespaces)
        }
    }

    // MARK: - List buffer (accumulates list lines into a single Segment)

    /// Accumulates consecutive list lines into tree of ListItem, supporting
    /// one level of nesting via leading indentation. Also recognizes GFM
    /// task list syntax: "- [ ]" and "- [x]".
    private final class ListBuffer {
        private(set) var ordered = false
        private(set) var roots: [ListItem] = []
        private var currentRoot: ListItem?
        private var pendingRaw: (String, [String])?  // (markerLine, subLines)

        func append(line trimmedLine: String) {
            // Determine ordered vs unordered by first item seen
            if roots.isEmpty && pendingRaw == nil {
                ordered = isOrderedMarker(trimmedLine)
            }

            // Indented line → sub-item of the current root
            if trimmedLine.hasPrefix("  ") || trimmedLine.hasPrefix("\t") {
                if pendingRaw != nil {
                    pendingRaw!.1.append(trimmedLine.trimmingCharacters(in: .whitespaces))
                }
                return
            }

            // New top-level item: flush the pending one first
            flushPending()

            let (inline, task) = parseItemContent(trimmedLine)
            pendingRaw = (trimmedLine, [])
            // stash parsed inline/task for when we finalize (sub-items may still arrive)
            _stashInline = inline
            _stashTask = task
        }

        private var _stashInline: [InlinePart] = []
        private var _stashTask: TaskState?

        private func flushPending() {
            guard let raw = pendingRaw else { return }
            let subItems = raw.1.map { subLine -> ListItem in
                let (subInline, _) = parseItemContent(subLine)
                return ListItem(taskState: nil, inline: subInline, subItems: [])
            }
            roots.append(ListItem(taskState: _stashTask, inline: _stashInline, subItems: subItems))
            pendingRaw = nil
            _stashInline = []
            _stashTask = nil
        }

        func finalize() -> Segment? {
            flushPending()
            guard !roots.isEmpty else { return nil }
            return .list(ordered: ordered, items: roots)
        }

        // - / * / + marker vs digit marker
        private func isOrderedMarker(_ line: String) -> Bool {
            var idx = line.startIndex
            while idx < line.endIndex, line[idx].isNumber { idx = line.index(after: idx) }
            return idx > line.startIndex
        }

        // Strip the leading marker ("- ", "1. ", etc.) and detect GFM task state.
        private func parseItemContent(_ line: String) -> ([InlinePart], TaskState?) {
            var content = line
            // Remove marker
            if content.hasPrefix("- ") || content.hasPrefix("* ") || content.hasPrefix("+ ") {
                content = String(content.dropFirst(2))
            } else {
                // ordered: digits + . or ) + space
                var idx = content.startIndex
                while idx < content.endIndex, content[idx].isNumber { idx = content.index(after: idx) }
                if idx < content.endIndex, (content[idx] == "." || content[idx] == ")") {
                    let after = content.index(after: idx)
                    if after < content.endIndex {
                        content = String(content[after...]).trimmingCharacters(in: .whitespaces)
                    } else {
                        content = ""
                    }
                }
            }

            content = content.trimmingCharacters(in: .whitespaces)

            // Task list: [ ] or [x] / [X]
            var task: TaskState?
            if content.hasPrefix("[ ]") {
                task = .unchecked
                content = String(content.dropFirst(3)).trimmingCharacters(in: .whitespaces)
            } else if content.lowercased().hasPrefix("[x]") {
                task = .checked
                content = String(content.dropFirst(3)).trimmingCharacters(in: .whitespaces)
            }

            return (parseInlineFormatting(content), task)
        }
    }

    // MARK: - Command tag sanitization

    /// Strip Claude Code command tags and convert to terminal-like display
    private static func sanitizeCommandTags(_ text: String) -> String {
        // Fast path: skip all regex if no XML tags present
        guard text.contains("<") else { return text }

        var result = text

        result = stripTag(result, tag: "local-command-caveat")
        result = stripTag(result, tag: "command-name")
        result = stripTag(result, tag: "command-message")
        result = result.replacingOccurrences(
            of: #"<command-args>.*?</command-args>"#,
            with: "",
            options: .regularExpression
        )
        result = stripTag(result, tag: "local-command-stdout")
        result = stripTag(result, tag: "local-command-stderr")

        result = result.replacingOccurrences(of: #"\n{3,}"#, with: "\n\n", options: .regularExpression)

        return result.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func stripTag(_ text: String, tag: String) -> String {
        let openPattern = #"<\#(tag)[^>]*>"#
        let closePattern = #"</\#(tag)>"#
        var result = text
        result = result.replacingOccurrences(of: openPattern, with: "", options: .regularExpression)
        result = result.replacingOccurrences(of: closePattern, with: "", options: .regularExpression)
        return result
    }
}

// MARK: - Shared markdown model types (file-private, used by MarkdownContentView
// and its helper views)

private enum MDSegment {
    case heading(level: Int, [MDInlinePart])
    case paragraph([MDInlinePart])
    case quote([[MDInlinePart]])
    case list(ordered: Bool, items: [MDListItem])
    case table(headers: [String], rows: [[String]])
    case codeBlock(language: String?, code: String)
}

private struct MDListItem: Identifiable {
    let id = UUID()
    let taskState: MDTaskState?
    let inline: [MDInlinePart]
    let subItems: [MDListItem]
}

private enum MDTaskState {
    case unchecked
    case checked
}

private enum MDInlinePart {
    case plain(String)
    case bold(String)
    case italic(String)
    case code(String)
    case strikethrough(String)
    case link(text: String, url: String)
}

// MARK: - Inline formatted text view

private struct InlineFormattedText: View {
    let parts: [MDInlinePart]
    var baseSize: CGFloat = 15
    var baseWeight: Font.Weight = .regular
    var isHeading: Bool = false

    var body: some View {
        parts.reduce(Text("")) { result, part in
            switch part {
            case .plain(let str):
                return result + Text(str).font(PCFont.body(baseSize, weight: baseWeight)).foregroundStyle(Color.pcFg)
            case .bold(let str):
                return result + Text(str).font(PCFont.body(baseSize, weight: .bold)).foregroundStyle(Color.pcFg)
            case .italic(let str):
                return result + Text(str).font(PCFont.body(baseSize, weight: baseWeight)).italic().foregroundStyle(Color.pcFg)
            case .code(let str):
                return result + Text(str)
                    .font(PCFont.mono(baseSize - 2))
                    .foregroundColor(Color.pcAccent)
            case .strikethrough(let str):
                return result + Text(str)
                    .font(PCFont.body(baseSize, weight: baseWeight))
                    .strikethrough()
                    .foregroundColor(Color.pcFgTertiary)
            case .link(let textPart, _):
                return result + Text(textPart)
                    .font(PCFont.body(baseSize, weight: baseWeight))
                    .foregroundColor(Color.pcAccent)
                    .underline()
            }
        }
        .fixedSize(horizontal: false, vertical: true)
    }
}

// MARK: - Blockquote view

private struct QuoteView: View {
    let parts: [[MDInlinePart]]

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(Array(parts.enumerated()), id: \.offset) { _, inline in
                InlineFormattedText(parts: inline)
            }
        }
        .padding(.leading, 12)
        .overlay(alignment: .leading) {
            Rectangle()
                .fill(Color.pcBorderLight)
                .frame(width: 3)
        }
    }
}

// MARK: - List view

private struct ListView: View {
    let ordered: Bool
    let items: [MDListItem]

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                rowView(index: index, item: item)
            }
        }
    }

    @ViewBuilder
    private func rowView(index: Int, item: MDListItem) -> some View {
        HStack(alignment: .top, spacing: 8) {
            // marker / task checkbox
            if let task = item.taskState {
                taskGlyph(task)
            } else if ordered {
                Text("\(index + 1).")
                    .font(PCFont.body(15))
                    .foregroundStyle(Color.pcFgSecondary)
            } else {
                Circle()
                    .fill(Color.pcFgTertiary)
                    .frame(width: 5, height: 5)
                    .padding(.top, 8)
            }

            VStack(alignment: .leading, spacing: 4) {
                InlineFormattedText(parts: item.inline)
                if !item.subItems.isEmpty {
                    VStack(alignment: .leading, spacing: 3) {
                        ForEach(item.subItems) { sub in
                            HStack(alignment: .top, spacing: 8) {
                                Circle()
                                    .fill(Color.pcFgTertiary)
                                    .frame(width: 4, height: 4)
                                    .padding(.top, 8)
                                InlineFormattedText(parts: sub.inline)
                            }
                        }
                    }
                    .padding(.leading, 8)
                }
            }
        }
    }

    @ViewBuilder
    private func taskGlyph(_ state: MDTaskState) -> some View {
        switch state {
        case .unchecked:
            Image(systemName: "circle")
                .font(.system(size: 14))
                .foregroundStyle(Color.pcFgTertiary)
                .padding(.top, 2)
        case .checked:
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 14))
                .foregroundStyle(Color.pcSuccess)
                .padding(.top, 2)
        }
    }
}

// MARK: - Table View (GitHub Markdown style)

private struct TableView: View {
    let headers: [String]
    let rows: [[String]]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 0) {
                ForEach(Array(headers.enumerated()), id: \.offset) { col, header in
                    cellView(text: header, isHeader: true)
                        .frame(minWidth: 70, alignment: .leading)
                }
            }
            .background(Color.pcCodeBg)

            Rectangle()
                .fill(Color.pcBorder)
                .frame(height: 1)

            ForEach(Array(rows.enumerated()), id: \.offset) { rowIndex, row in
                HStack(spacing: 0) {
                    ForEach(Array(row.enumerated()), id: \.offset) { col, cell in
                        cellView(text: cell, isHeader: false)
                            .frame(minWidth: 70, alignment: .leading)
                    }
                    if row.count < headers.count {
                        ForEach(row.count..<headers.count, id: \.self) { _ in
                            cellView(text: "", isHeader: false)
                                .frame(minWidth: 70)
                        }
                    }
                }
                .background(rowIndex % 2 == 0 ? Color.clear : Color.pcCodeBg.opacity(0.3))

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
}

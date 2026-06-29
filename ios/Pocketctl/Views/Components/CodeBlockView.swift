import SwiftUI

/// Renders a code block with syntax highlighting, language label, and copy button.
///
/// 高亮结果在 init 中一次性预算（full / collapsed 两份），body 只读取常量。
/// 这避免键盘动画期间 body 被反复求值时重复执行逐字符分词——这是会话详情页
/// 唤起键盘卡顿的主要 CPU 来源之一。
struct CodeBlockView: View {
    let code: String
    let language: String?

    @State private var isCopied = false
    @State private var isExpanded = false

    private let collapsedLineLimit = 50

    /// init 中预算：完整高亮结果（展开态用）。
    private let highlightedFull: AttributedString
    /// init 中预算：折叠态高亮结果（前 collapsedLineLimit 行）。
    private let highlightedCollapsed: AttributedString
    /// 总行数（init 中算一次，避免 body 内 components(separatedBy:) 重复）。
    private let lineCount: Int

    init(code: String, language: String?) {
        self.code = code
        self.language = language

        let lines = code.components(separatedBy: "\n")
        self.lineCount = lines.count
        self.highlightedFull = SyntaxHighlighter.highlight(code, language: language)

        if lines.count > 50 {
            let collapsed = lines.prefix(50).joined(separator: "\n")
            self.highlightedCollapsed = SyntaxHighlighter.highlight(collapsed, language: language)
        } else {
            // 短代码无需折叠，两份指向同一结果即可。
            self.highlightedCollapsed = highlightedFull
        }
    }

    private var isLong: Bool {
        lineCount > collapsedLineLimit
    }

    private var displayCode: AttributedString {
        guard isLong, !isExpanded else { return highlightedFull }
        return highlightedCollapsed
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Header: language + copy button
            header

            // Code content with syntax highlighting
            ScrollView(.horizontal, showsIndicators: false) {
                Text(displayCode)
                    .font(PCFont.mono(13))
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            // Expand/collapse toggle for long code
            if isLong {
                Button {
                    withAnimation(.easeInOut(duration: 0.2)) {
                        isExpanded.toggle()
                    }
                } label: {
                    HStack(spacing: 4) {
                        Text(isExpanded ? "收起" : "展开全部 (\(lineCount) 行)")
                            .font(PCFont.body(12))
                        Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                            .font(.system(size: 10))
                    }
                    .foregroundStyle(Color.pcAccent)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                }
            }
        }
        .background(Color.pcCodeBg)
        .cornerRadius(PCRadius.sm)
        .overlay(
            RoundedRectangle(cornerRadius: PCRadius.sm)
                .stroke(Color.pcBorder, lineWidth: 1)
        )
    }

    // MARK: - Header

    private var header: some View {
        HStack {
            // Language label
            if let lang = language, !lang.isEmpty {
                Text(lang)
                    .font(PCFont.mono(11, weight: .medium))
                    .foregroundStyle(Color.pcFgTertiary)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(Color.pcBorder.opacity(0.3))
                    .cornerRadius(4)
            }

            Spacer()

            // Copy button
            Button {
                UIPasteboard.general.string = code
                withAnimation {
                    isCopied = true
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                    withAnimation {
                        isCopied = false
                    }
                }
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: isCopied ? "checkmark" : "doc.on.doc")
                        .font(.system(size: 12))
                    if isCopied {
                        Text("已复制")
                            .font(PCFont.mono(11))
                    }
                }
                .foregroundStyle(isCopied ? Color.pcSuccess : Color.pcFgTertiary)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(Color.pcBorder.opacity(0.2))
    }
}

import SwiftUI

/// Renders a code block with syntax highlighting, language label, and copy button
struct CodeBlockView: View {
    let code: String
    let language: String?

    @State private var isCopied = false
    @State private var isExpanded = false

    private let collapsedLineLimit = 50

    private var isLong: Bool {
        code.components(separatedBy: "\n").count > collapsedLineLimit
    }

    private var displayCode: String {
        guard isLong, !isExpanded else { return code }
        let lines = code.components(separatedBy: "\n")
        return lines.prefix(collapsedLineLimit).joined(separator: "\n")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Header: language + copy button
            header

            // Code content with syntax highlighting
            ScrollView(.horizontal, showsIndicators: false) {
                Text(SyntaxHighlighter.highlight(displayCode, language: language))
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
                        Text(isExpanded ? "收起" : "展开全部 (\(code.components(separatedBy: "\n").count) 行)")
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

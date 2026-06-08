import SwiftUI

/// Renders a code block with syntax highlighting, language label, and copy button
struct CodeBlockView: View {
    let code: String
    let language: String?

    @State private var isCopied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Header: language + copy button
            header

            // Code content with syntax highlighting
            ScrollView(.horizontal, showsIndicators: false) {
                Text(SyntaxHighlighter.highlight(code, language: language))
                    .font(PCFont.mono(13))
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
                    .frame(maxWidth: .infinity, alignment: .leading)
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

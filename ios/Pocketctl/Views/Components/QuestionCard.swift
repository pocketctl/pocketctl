import SwiftUI

/// Renders an AskUserQuestion tool call as a readable question + options card.
/// Display only (no click-to-answer in this version).
struct QuestionCard: View {
    let message: ChatMessage

    // Parsed questions from rawInputJSON
    private var questions: [[String: Any]] {
        guard let json = message.rawInputJSON,
              let data = json.data(using: .utf8),
              let input = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let qs = input["questions"] as? [[String: Any]] else { return [] }
        return qs
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(Array(questions.enumerated()), id: \.offset) { _, q in
                questionBlock(q)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func questionBlock(_ q: [String: Any]) -> some View {
        let header = q["header"] as? String ?? ""
        let question = q["question"] as? String ?? ""
        let multiSelect = q["multiSelect"] as? Bool ?? false
        let options = (q["options"] as? [[String: Any]]) ?? []

        VStack(alignment: .leading, spacing: 10) {
            // Header row: icon + header tag + multi-select badge
            HStack(spacing: 6) {
                Image(systemName: "questionmark.bubble")
                    .font(.system(size: 13))
                    .foregroundStyle(Color.pcAccent)
                if !header.isEmpty {
                    Text(header)
                        .font(PCFont.body(11, weight: .bold))
                        .foregroundStyle(Color.pcAccent)
                        .textCase(.uppercase)
                }
                if multiSelect {
                    Text("多选")
                        .font(PCFont.body(10, weight: .semibold))
                        .foregroundStyle(Color.pcFgTertiary)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 1)
                        .background(Color.pcHoverInput)
                        .clipShape(Capsule())
                }
            }

            // Question text
            Text(question)
                .font(PCFont.body(14, weight: .medium))
                .foregroundStyle(Color.pcFg)
                .fixedSize(horizontal: false, vertical: true)

            // Options
            VStack(spacing: 6) {
                ForEach(Array(options.enumerated()), id: \.offset) { idx, opt in
                    optionRow(idx: idx, opt: opt)
                }
            }
        }
        .padding(14)
        .background(Color.pcSurface)
        .cornerRadius(PCRadius.lg)
        .overlay(
            RoundedRectangle(cornerRadius: PCRadius.lg)
                .stroke(Color.pcBorder, lineWidth: 1)
        )
    }

    @ViewBuilder
    private func optionRow(idx: Int, opt: [String: Any]) -> some View {
        let label = opt["label"] as? String ?? ""
        let desc = opt["description"] as? String ?? ""
        let letter = String(format: "%c", Int(UnicodeScalar("A").value) + idx)

        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 8) {
                // Letter circle
                Text(letter)
                    .font(PCFont.mono(11, weight: .bold))
                    .foregroundStyle(Color.pcAccent)
                    .frame(width: 20, height: 20)
                    .background(Color.pcAccentMuted)
                    .clipShape(Circle())

                Text(label)
                    .font(PCFont.body(13, weight: .semibold))
                    .foregroundStyle(Color.pcFg)
            }

            if !desc.isEmpty {
                Text(desc)
                    .font(PCFont.body(12))
                    .foregroundStyle(Color.pcFgTertiary)
                    .padding(.leading, 28)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.pcBackground)
        .cornerRadius(PCRadius.md)
        .overlay(
            RoundedRectangle(cornerRadius: PCRadius.md)
                .stroke(Color.pcBorder, lineWidth: 1)
        )
    }
}

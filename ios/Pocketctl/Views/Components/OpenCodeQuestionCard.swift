import SwiftUI

struct OpenCodeQuestionCard: View {
    let message: ChatMessage
    let disabled: Bool
    let onSubmit: (String, [[String]]) -> Void
    let onReject: (String) -> Void

    @State private var selected: [Set<String>]
    @State private var custom: [String]

    init(message: ChatMessage, disabled: Bool, onSubmit: @escaping (String, [[String]]) -> Void, onReject: @escaping (String) -> Void) {
        self.message = message
        self.disabled = disabled
        self.onSubmit = onSubmit
        self.onReject = onReject
        _selected = State(initialValue: message.questions.map { _ in Set<String>() })
        _custom = State(initialValue: message.questions.map { _ in "" })
    }

    private var isPending: Bool { message.approvalStatus == "pending" }
    private var controlsDisabled: Bool { disabled || message.interactionSubmitting || !isPending }

    var orderedAnswers: [[String]] {
        message.questions.enumerated().map { index, question in
            var result = question.options.map(\.label).filter { selected.indices.contains(index) && selected[index].contains($0) }
            if custom.indices.contains(index) {
                let value = custom[index].trimmingCharacters(in: .whitespacesAndNewlines)
                if !value.isEmpty { result.append(value) }
            }
            return result
        }
    }

    private var canSubmit: Bool {
        !message.questions.isEmpty && zip(message.questions, orderedAnswers).allSatisfy { question, answer in
            !answer.isEmpty && (question.multiple || answer.count == 1)
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 7) {
                Image(systemName: "questionmark.bubble").foregroundStyle(Color.pcAccent)
                Text("Agent 提问").font(PCFont.body(12, weight: .bold)).foregroundStyle(Color.pcAccent)
                Spacer()
                if isPending { Text(message.interactionSubmitting ? "正在提交…" : "等待你的回答").font(PCFont.body(11)).foregroundStyle(Color.pcFgTertiary) }
            }

            ForEach(Array(message.questions.enumerated()), id: \.element.id) { index, question in
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 6) {
                        if !question.header.isEmpty { Text(question.header).font(PCFont.body(10, weight: .bold)).foregroundStyle(Color.pcAccent) }
                        if question.multiple { Text("多选").font(PCFont.body(10)).foregroundStyle(Color.pcFgTertiary) }
                    }
                    Text(question.question).font(PCFont.body(14, weight: .semibold)).foregroundStyle(Color.pcFg)
                    ForEach(question.options) { option in
                        Button {
                            toggle(option.label, questionIndex: index, multiple: question.multiple)
                        } label: {
                            HStack(alignment: .top, spacing: 8) {
                                Image(systemName: selected[index].contains(option.label) ? (question.multiple ? "checkmark.square.fill" : "circle.inset.filled") : (question.multiple ? "square" : "circle"))
                                    .foregroundStyle(selected[index].contains(option.label) ? Color.pcAccent : Color.pcFgTertiary)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(option.label).font(PCFont.body(13, weight: .semibold)).foregroundStyle(Color.pcFg)
                                    if !option.description.isEmpty { Text(option.description).font(PCFont.body(11)).foregroundStyle(Color.pcFgTertiary) }
                                }
                                Spacer()
                            }
                            .padding(9).background(Color.pcCodeBg).cornerRadius(PCRadius.md)
                            .overlay(RoundedRectangle(cornerRadius: PCRadius.md).stroke(selected[index].contains(option.label) ? Color.pcAccent : Color.pcBorder))
                        }
                        .buttonStyle(.plain).disabled(controlsDisabled)
                    }
                    if question.custom {
                        Group {
                            if question.secret {
                                SecureField("输入敏感答案", text: customBinding(index: index, multiple: question.multiple))
                                    .textContentType(.password)
                            } else {
                                TextField("输入自定义答案", text: customBinding(index: index, multiple: question.multiple))
                            }
                        }
                            .textFieldStyle(.plain)
                            .padding(9).background(Color.pcCodeBg).cornerRadius(PCRadius.md)
                            .overlay(RoundedRectangle(cornerRadius: PCRadius.md).stroke(Color.pcBorder))
                            .disabled(controlsDisabled)
                    }
                }
                .padding(.top, 8)
                .overlay(Rectangle().fill(Color.pcBorder).frame(height: 1), alignment: .top)
            }

            if let error = message.interactionError { Text(error).font(PCFont.body(11)).foregroundStyle(Color.pcError) }
            if isPending {
                HStack(spacing: 8) {
                    Button("提交回答") {
                        if let requestId = message.requestId { onSubmit(requestId, orderedAnswers) }
                    }
                    .buttonStyle(.borderedProminent).disabled(controlsDisabled || !canSubmit)
                    Button("拒绝回答", role: .destructive) {
                        if let requestId = message.requestId { onReject(requestId) }
                    }
                    .buttonStyle(.bordered).disabled(controlsDisabled)
                }
            } else {
                Text(message.interactionResolutionReason == "resolved_elsewhere" ? "已在其他设备处理" : (message.questionRejected ? "已拒绝回答" : (message.questionRedacted ? "已回答（内容已隐藏）" : "已回答")))
                    .font(PCFont.body(12, weight: .semibold)).foregroundStyle(message.interactionResolutionReason == "resolved_elsewhere" ? Color.pcFgSecondary : (message.questionRejected ? Color.pcError : Color.pcSuccess))
            }
        }
        .padding(14).frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.pcSurface).cornerRadius(PCRadius.lg)
        .overlay(RoundedRectangle(cornerRadius: PCRadius.lg).stroke(Color.pcBorder))
    }

    private func toggle(_ label: String, questionIndex: Int, multiple: Bool) {
        guard selected.indices.contains(questionIndex) else { return }
        if multiple {
            if selected[questionIndex].contains(label) { selected[questionIndex].remove(label) }
            else { selected[questionIndex].insert(label) }
        } else {
            selected[questionIndex] = [label]
            custom[questionIndex] = ""
        }
    }

    private func customBinding(index: Int, multiple: Bool) -> Binding<String> {
        Binding(
            get: { custom.indices.contains(index) ? custom[index] : "" },
            set: { value in
                guard custom.indices.contains(index) else { return }
                custom[index] = String(value.prefix(4096))
                if !multiple && !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { selected[index].removeAll() }
            }
        )
    }
}

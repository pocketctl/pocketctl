import SwiftUI

private struct McpFormOption: Identifiable {
    let value: String
    let title: String
    var id: String { value }
}

private struct McpFormField: Identifiable {
    let name: String
    let type: String
    let title: String
    let description: String
    let required: Bool
    let options: [McpFormOption]
    let minimum: Double?
    let maximum: Double?
    let minLength: Int?
    let maxLength: Int?
    let minItems: Int?
    var id: String { name }
}

struct McpElicitationCard: View {
    let message: ChatMessage
    let disabled: Bool
    let onRespond: (String, String, [String: Any]?) -> Void

    private let fields: [McpFormField]
    @State private var textValues: [String: String]
    @State private var boolValues: Set<String>
    @State private var arrayValues: [String: Set<String>]

    init(message: ChatMessage, disabled: Bool, onRespond: @escaping (String, String, [String: Any]?) -> Void) {
        self.message = message
        self.disabled = disabled
        self.onRespond = onRespond
        let parsed = Self.parseFields(message.elicitationSchema)
        self.fields = parsed
        _textValues = State(initialValue: Dictionary(uniqueKeysWithValues: parsed.filter { $0.type != "boolean" && $0.type != "array" }.map { ($0.name, "") }))
        _boolValues = State(initialValue: [])
        _arrayValues = State(initialValue: Dictionary(uniqueKeysWithValues: parsed.filter { $0.type == "array" }.map { ($0.name, Set<String>()) }))
    }

    private var isPending: Bool { message.approvalStatus == "pending" }
    private var controlsDisabled: Bool { disabled || message.interactionSubmitting }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 7) {
                Text("MCP").font(PCFont.body(10, weight: .bold)).foregroundStyle(Color.pcAccent)
                Text(message.mcpServer.isEmpty ? "MCP Server" : message.mcpServer).font(PCFont.body(13, weight: .semibold))
                Spacer()
                if isPending { Text(message.interactionSubmitting ? "正在提交…" : "等待输入").font(PCFont.body(11)).foregroundStyle(Color.pcFgTertiary) }
            }
            if !message.elicitationMessage.isEmpty {
                Text(message.elicitationMessage).font(PCFont.body(14)).foregroundStyle(Color.pcFg)
            }
            if message.elicitationMode == "url", let url = URL(string: message.elicitationURL) {
                Link(message.elicitationURL, destination: url)
                    .font(PCFont.body(12)).lineLimit(2)
            }
            if message.elicitationMode == "form", isPending {
                ForEach(fields) { field in formField(field) }
                if let error = validationError { Text(error).font(PCFont.body(11)).foregroundStyle(Color.pcError) }
            }
            if let error = message.interactionError { Text(error).font(PCFont.body(11)).foregroundStyle(Color.pcError) }
            actions
        }
        .padding(14).frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.pcSurface).cornerRadius(PCRadius.lg)
        .overlay(RoundedRectangle(cornerRadius: PCRadius.lg).stroke(Color.pcBorder))
    }

    @ViewBuilder
    private func formField(_ field: McpFormField) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(field.title + (field.required ? " *" : "")).font(PCFont.body(12, weight: .semibold))
            if !field.description.isEmpty { Text(field.description).font(PCFont.body(11)).foregroundStyle(Color.pcFgTertiary) }
            if field.type == "boolean" {
                Toggle("启用", isOn: Binding(get: { boolValues.contains(field.name) }, set: { enabled in
                    if enabled { boolValues.insert(field.name) } else { boolValues.remove(field.name) }
                })).disabled(controlsDisabled)
            } else if field.type == "array" {
                ForEach(field.options) { option in
                    Toggle(option.title, isOn: Binding(get: { arrayValues[field.name, default: []].contains(option.value) }, set: { enabled in
                        if enabled { arrayValues[field.name, default: []].insert(option.value) }
                        else { arrayValues[field.name, default: []].remove(option.value) }
                    })).disabled(controlsDisabled)
                }
            } else if !field.options.isEmpty {
                Picker(field.title, selection: textBinding(field.name)) {
                    Text("请选择").tag("")
                    ForEach(field.options) { Text($0.title).tag($0.value) }
                }.pickerStyle(.menu).disabled(controlsDisabled)
            } else if field.type == "integer" || field.type == "number" {
                TextField("输入数值", text: textBinding(field.name))
                    .keyboardType(field.type == "integer" ? .numberPad : .decimalPad)
                    .textFieldStyle(.roundedBorder).disabled(controlsDisabled)
            } else {
                TextField("输入内容", text: textBinding(field.name))
                    .textFieldStyle(.roundedBorder).disabled(controlsDisabled)
            }
        }
    }

    @ViewBuilder
    private var actions: some View {
        if isPending {
            HStack(spacing: 8) {
                Button(message.elicitationMode == "form" ? "提交" : "继续") { accept() }
                    .buttonStyle(.borderedProminent).disabled(controlsDisabled || validationError != nil)
                Button("拒绝", role: .destructive) { respond("decline") }.buttonStyle(.bordered).disabled(controlsDisabled)
                Button("取消") { respond("cancel") }.buttonStyle(.bordered).disabled(controlsDisabled)
            }
        } else {
            Text(message.interactionResolutionReason == "resolved_elsewhere" ? "已在其他设备处理" : (message.elicitationAction == "accept" ? "已提交（内容已隐藏）" : message.elicitationAction == "cancel" ? "已取消" : "已拒绝"))
                .font(PCFont.body(12, weight: .semibold)).foregroundStyle(Color.pcFgSecondary)
        }
    }

    private func textBinding(_ name: String) -> Binding<String> {
        Binding(get: { textValues[name, default: ""] }, set: { textValues[name] = $0 })
    }

    private var validationError: String? {
        for field in fields {
            if field.type == "array" {
                let count = arrayValues[field.name, default: []].count
                if field.required && count == 0 || field.minItems.map({ count < $0 }) == true { return "请选择 \(field.title)" }
                continue
            }
            if field.type == "boolean" { continue }
            let value = textValues[field.name, default: ""]
            if field.required && value.isEmpty { return "请填写 \(field.title)" }
            if let min = field.minLength, value.count < min { return "\(field.title) 内容过短" }
            if let max = field.maxLength, value.count > max { return "\(field.title) 内容过长" }
            if (field.type == "integer" || field.type == "number"), !value.isEmpty {
                guard let number = Double(value), field.type != "integer" || number.rounded() == number else { return "\(field.title) 必须是有效数字" }
                if field.minimum.map({ number < $0 }) == true || field.maximum.map({ number > $0 }) == true { return "\(field.title) 超出允许范围" }
            }
        }
        return nil
    }

    private func accept() {
        guard let requestId = message.requestId, validationError == nil else { return }
        if message.elicitationMode != "form" { onRespond(requestId, "accept", nil); return }
        var content: [String: Any] = [:]
        for field in fields {
            if field.type == "boolean" { content[field.name] = boolValues.contains(field.name) }
            else if field.type == "array" { content[field.name] = Array(arrayValues[field.name, default: []]).sorted() }
            else if field.type == "integer" { content[field.name] = Int(textValues[field.name, default: ""]) }
            else if field.type == "number" { content[field.name] = Double(textValues[field.name, default: ""]) }
            else { content[field.name] = textValues[field.name, default: ""] }
        }
        onRespond(requestId, "accept", content)
    }

    private func respond(_ action: String) {
        if let requestId = message.requestId { onRespond(requestId, action, nil) }
    }

    private static func parseFields(_ schemaText: String) -> [McpFormField] {
        guard let data = schemaText.data(using: .utf8),
              let schema = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let properties = schema["properties"] as? [String: [String: Any]] else { return [] }
        let required = Set(schema["required"] as? [String] ?? [])
        return properties.keys.sorted().compactMap { name in
            guard let raw = properties[name], let type = raw["type"] as? String else { return nil }
            let enumValues = raw["enum"] as? [String] ?? []
            let enumNames = raw["enumNames"] as? [String] ?? []
            let directOptions = (raw["oneOf"] as? [[String: Any]] ?? []).compactMap(option)
            let item = raw["items"] as? [String: Any]
            let itemEnums = item?["enum"] as? [String] ?? []
            let itemOptions = (item?["anyOf"] as? [[String: Any]] ?? []).compactMap(option)
            let strings = type == "array" ? itemEnums : enumValues
            let names = type == "array" ? [] : enumNames
            let fallback = strings.enumerated().map { McpFormOption(value: $0.element, title: names.indices.contains($0.offset) ? names[$0.offset] : $0.element) }
            return McpFormField(
                name: name, type: type, title: raw["title"] as? String ?? name,
                description: raw["description"] as? String ?? "", required: required.contains(name),
                options: !directOptions.isEmpty ? directOptions : !itemOptions.isEmpty ? itemOptions : fallback,
                minimum: raw["minimum"] as? Double, maximum: raw["maximum"] as? Double,
                minLength: raw["minLength"] as? Int, maxLength: raw["maxLength"] as? Int,
                minItems: raw["minItems"] as? Int
            )
        }
    }

    private static func option(_ raw: [String: Any]) -> McpFormOption? {
        guard let value = raw["const"] as? String else { return nil }
        return McpFormOption(value: value, title: raw["title"] as? String ?? value)
    }
}

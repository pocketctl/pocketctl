import Foundation

struct OpenCodeSessionAgent: Identifiable, Sendable, Equatable {
    let name: String
    let description: String
    let mode: String
    let color: String?
    let model: String?
    let variant: String?
    let hidden: Bool

    var id: String { name }
    var isSelectable: Bool { !hidden && (mode == "primary" || mode == "all") }

    init?(dict: [String: Any]) {
        guard let name = dict["name"] as? String, !name.isEmpty else { return nil }
        self.name = name
        self.description = dict["description"] as? String ?? ""
        self.mode = dict["mode"] as? String ?? ""
        self.color = dict["color"] as? String
        self.model = dict["model"] as? String
        self.variant = dict["variant"] as? String
        self.hidden = dict["hidden"] as? Bool ?? false
    }

    static func selectable(from dictionaries: [[String: Any]]) -> [OpenCodeSessionAgent] {
        var seen = Set<String>()
        return dictionaries.compactMap(OpenCodeSessionAgent.init).filter { agent in
            agent.isSelectable && seen.insert(agent.name).inserted
        }
    }
}

struct OpenCodeQuestionOption: Identifiable, Sendable, Equatable {
    let label: String
    let description: String
    var id: String { label }

    init?(dict: [String: Any]) {
        guard let label = dict["label"] as? String, !label.isEmpty else { return nil }
        self.label = label
        self.description = dict["description"] as? String ?? ""
    }
}

struct OpenCodeQuestion: Identifiable, Sendable, Equatable {
    let id: String
    let header: String
    let question: String
    let options: [OpenCodeQuestionOption]
    let multiple: Bool
    let custom: Bool
    let secret: Bool

    init?(dict: [String: Any], index: Int) {
        guard let question = dict["question"] as? String, !question.isEmpty else { return nil }
        self.id = dict["id"] as? String ?? String(index)
        self.header = dict["header"] as? String ?? ""
        self.question = question
        self.options = (dict["options"] as? [[String: Any]] ?? []).compactMap(OpenCodeQuestionOption.init)
        self.multiple = dict["multiple"] as? Bool ?? false
        self.custom = dict["custom"] as? Bool ?? false
        self.secret = dict["secret"] as? Bool ?? false
    }

    static func parse(_ dictionaries: [[String: Any]]) -> [OpenCodeQuestion] {
        dictionaries.enumerated().compactMap { OpenCodeQuestion(dict: $0.element, index: $0.offset) }
    }
}

enum OpenCodeInteractionResolution: Sendable {
    case approval(action: String, reason: String?)
    case question(answers: [[String]], rejected: Bool, reason: String?, redacted: Bool)
    case elicitation(action: String, reason: String?, redacted: Bool)
}

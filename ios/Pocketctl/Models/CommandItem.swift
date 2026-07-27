import Foundation

/// A slash command or skill available in a session (from command_list event).
/// Mirrors the backend `protocol.CommandItem` and web's `CommandItem` interface.
struct CommandItem: Identifiable, Sendable {
    let name: String
    let source: String        // builtin | project | user | plugin | pocketctl
    let kind: String          // command | skill
    let description: String?
    let argHint: String?
    let namespace: String?    // only set for plugin source
    let template: String?
    let hints: [String]
    let subtask: Bool
    let agent: String?
    let model: String?

    var id: String { name }

    init(name: String, source: String = "builtin", kind: String = "command", description: String? = nil, argHint: String? = nil, namespace: String? = nil, template: String? = nil, hints: [String] = [], subtask: Bool = false, agent: String? = nil, model: String? = nil) {
        self.name = name
        self.source = source
        self.kind = kind
        self.description = description
        self.argHint = argHint
        self.namespace = namespace
        self.template = template
        self.hints = hints
        self.subtask = subtask
        self.agent = agent
        self.model = model
    }

    init?(dict: [String: Any]) {
        guard let name = dict["name"] as? String else { return nil }
        self.name = name
        self.source = dict["source"] as? String ?? "builtin"
        self.kind = dict["kind"] as? String ?? "command"
        self.description = dict["description"] as? String
        self.hints = dict["hints"] as? [String] ?? []
        self.argHint = (dict["arg_hint"] as? String) ?? (hints.isEmpty ? nil : hints.joined(separator: " "))
        self.namespace = dict["namespace"] as? String
        self.template = dict["template"] as? String
        self.subtask = dict["subtask"] as? Bool ?? false
        self.agent = dict["agent"] as? String
        self.model = dict["model"] as? String
    }

    /// Pocketctl local command definitions (available in every agent session),
    /// shown together with daemon-returned command completion entries.
    static let localCommands: [CommandItem] = [
        CommandItem(name: "cost", source: "pocketctl", description: "查看 token 用量与花费"),
        CommandItem(name: "status", source: "pocketctl", description: "查看主机/模型/版本摘要（账户状态请在终端查询）"),
        CommandItem(name: "help", source: "pocketctl", description: "查看 Pocketctl 本地命令说明"),
        CommandItem(name: "model", source: "pocketctl", description: "查看当前模型；如需切换请在终端执行 /model", argHint: "<model>"),
    ]

    /// SF Symbol for the command/skill, aligned with web CommandPopover's
    /// commandIcon (kind === "command" → terminal; else by source).
    var iconSymbol: String {
        if kind == "command" { return "terminal" }
        switch source {
        case "builtin": return "sparkles"
        case "pocketctl": return "gearshape"
        case "project": return "folder"
        case "user":    return "person"
        case "plugin":  return "shippingbox"
        default:        return "sparkles"
        }
    }
}

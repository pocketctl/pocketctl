import Foundation

/// A slash command or skill available in a session (from command_list event).
/// Mirrors the backend `protocol.CommandItem` and web's `CommandItem` interface.
struct CommandItem: Identifiable, Sendable {
    let name: String
    let source: String        // builtin | project | user | plugin
    let kind: String          // command | skill
    let description: String?
    let argHint: String?
    let namespace: String?    // only set for plugin source

    var id: String { name }

    init?(dict: [String: Any]) {
        guard let name = dict["name"] as? String else { return nil }
        self.name = name
        self.source = dict["source"] as? String ?? "builtin"
        self.kind = dict["kind"] as? String ?? "command"
        self.description = dict["description"] as? String
        self.argHint = dict["arg_hint"] as? String
        self.namespace = dict["namespace"] as? String
    }

    /// SF Symbol for the command/skill, aligned with web CommandPopover's
    /// commandIcon (kind === "command" → terminal; else by source).
    var iconSymbol: String {
        if kind == "command" { return "terminal" }
        switch source {
        case "builtin": return "sparkles"
        case "project": return "folder"
        case "user":    return "person"
        case "plugin":  return "shippingbox"
        default:        return "sparkles"
        }
    }
}

import Foundation

/// A model selectable when creating a session. Comes from the daemon's real
/// `~/.claude/settings.json` via the `list_models` request → `model_list` event.
/// `alias` is the opus/sonnet/haiku alias sent back in `session_create`;
/// `name` is the concrete display name (e.g. "glm-5.2") shown in the picker.
struct ModelOption: Identifiable, Sendable, Hashable {
    let alias: String
    let name: String

    var id: String { alias }

    init?(dict: [String: Any]) {
        guard let alias = dict["alias"] as? String, !alias.isEmpty else { return nil }
        self.alias = alias
        self.name = (dict["name"] as? String) ?? alias
    }
}

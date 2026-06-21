import Foundation

/// Per-daemon-per-agent default working directory, stored locally in UserDefaults.
///
/// Used to pre-fill `NewSessionSheet`'s working directory when creating a session
/// for a specific agent on a specific host. Model selection is intentionally NOT
/// stored here — the host's available models can be reset on the host side, so a
/// locally-persisted default model could point at a stale/removed model. Models
/// are picked live at session-create time from `model_list`.
enum AgentDefaultsStore {
    private static let prefix = "agent_cwd"

    private static func key(daemonId: String, agentType: String) -> String {
        "\(prefix):\(daemonId):\(agentType)"
    }

    /// The default working directory for this daemon+agent, if set.
    static func getCwd(daemonId: String, agentType: String) -> String? {
        let value = UserDefaults.standard.string(forKey: key(daemonId: daemonId, agentType: agentType))
        return (value?.isEmpty == true) ? nil : value
    }

    /// Persist (or clear) the default working directory for this daemon+agent.
    static func setCwd(daemonId: String, agentType: String, cwd: String?) {
        let k = key(daemonId: daemonId, agentType: agentType)
        let trimmed = cwd?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let trimmed, !trimmed.isEmpty {
            UserDefaults.standard.set(trimmed, forKey: k)
        } else {
            UserDefaults.standard.removeObject(forKey: k)
        }
    }
}

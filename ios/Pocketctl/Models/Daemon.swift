import Foundation

struct Daemon: Identifiable, Sendable, Hashable {
    let daemonId: String
    let hostname: String
    let agents: [String]
    var online: Bool
    var lastSeenAt: String?
    var alias: String?

    var id: String { daemonId }

    /// Display name: alias if set, otherwise hostname
    var displayName: String {
        alias ?? hostname
    }
}

extension Daemon {
    /// Create from WebSocket daemon_status event
    static func from(event: [String: Any]) -> Daemon? {
        guard let daemonId = event["daemon_id"] as? String,
              let hostname = event["hostname"] as? String else { return nil }
        let agents = event["agents"] as? [String] ?? []
        let status = event["status"] as? String ?? "offline"
        let aliasValue = event["alias"] as? String
        return Daemon(
            daemonId: daemonId,
            hostname: hostname,
            agents: agents,
            online: status == "online",
            lastSeenAt: event["last_seen_at"] as? String,
            alias: (aliasValue?.isEmpty == true) ? nil : aliasValue
        )
    }
}

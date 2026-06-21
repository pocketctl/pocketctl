import Foundation

/// Agent installed on a daemon, with version info parsed from the
/// `daemon_status` WebSocket event's `agents: [{type, version, latest}]` array.
struct AgentInfo: Identifiable, Sendable, Hashable {
    let type: String
    let version: String
    let latest: String

    var id: String { type }

    /// A newer version is available (current & latest both non-empty and different).
    var canUpgrade: Bool {
        !version.isEmpty && !latest.isEmpty && version != latest
    }
}

struct Daemon: Identifiable, Sendable, Hashable {
    let daemonId: String
    let hostname: String
    let agents: [AgentInfo]
    var online: Bool
    var lastSeenAt: String?
    var alias: String?
    var os: String?
    var ip: String?

    var id: String { daemonId }

    /// Display name: alias if set, otherwise hostname
    var displayName: String {
        alias ?? hostname
    }

    /// Number of installed agents that can be upgraded.
    var upgradableAgentCount: Int {
        agents.filter { $0.canUpgrade }.count
    }
}

extension Daemon {
    /// Create from a WebSocket event — supports both `daemon_status` (single
    /// daemon, fields: status/alias/last_seen_at) and `daemon_list` elements
    /// (fields: daemon_online/daemon_alias/last_heartbeat).
    static func from(event: [String: Any]) -> Daemon? {
        guard let daemonId = event["daemon_id"] as? String,
              let hostname = event["hostname"] as? String else { return nil }
        let agents = parseAgents(event["agents"])
        // `daemon_status` uses status:"online"/"offline"; `daemon_list` uses
        // status OR a daemon_online bool — accept either.
        let statusStr = event["status"] as? String
        let onlineFlag = event["daemon_online"] as? Bool
        let isOnline: Bool = {
            if let s = statusStr { return s == "online" }
            return onlineFlag ?? false
        }()
        // `daemon_status` uses "alias"; `daemon_list` uses "daemon_alias".
        let aliasValue = (event["alias"] as? String) ?? (event["daemon_alias"] as? String)
        let osValue = event["os"] as? String
        let ipValue = event["ip"] as? String
        let lastSeen = (event["last_seen_at"] as? String) ?? (event["last_heartbeat"] as? String)
        return Daemon(
            daemonId: daemonId,
            hostname: hostname,
            agents: agents,
            online: isOnline,
            lastSeenAt: lastSeen,
            alias: (aliasValue?.isEmpty == true) ? nil : aliasValue,
            os: (osValue?.isEmpty == true) ? nil : osValue,
            ip: (ipValue?.isEmpty == true) ? nil : ipValue
        )
    }

    /// Parse agents array — supports the current `[{type, version, latest}]` format
    /// that relay composes from daemon-uploaded `agents` / `agent_versions` / `agent_latests`.
    private static func parseAgents(_ raw: Any?) -> [AgentInfo] {
        guard let arr = raw as? [[String: Any]] else { return [] }
        return arr.compactMap { dict in
            guard let type = dict["type"] as? String else { return nil }
            return AgentInfo(
                type: type,
                version: dict["version"] as? String ?? "",
                latest: dict["latest"] as? String ?? ""
            )
        }
    }
}

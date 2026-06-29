import Foundation

/// 区分 Relay 环境：测试（本地开发） vs 生产（正式服务器）
enum RelayEnvironment: String, CaseIterable, Codable, Sendable {
    case production = "production"
    case staging = "staging"

    var displayName: String {
        switch self {
        case .production: return "生产环境"
        case .staging: return "测试环境"
        }
    }

    /// 测试环境的默认主机地址（可被用户在设置中覆盖）
    static let defaultStagingHost = "192.168.31.198"

    /// 该环境的 HTTP/REST base URL
    var httpBaseURL: String {
        switch self {
        case .production:
            return "https://www.pocketctl.me"
        case .staging:
            return "http://\(stagingHost)"
        }
    }

    /// 该环境的 WebSocket URL
    var wsBaseURL: String {
        switch self {
        case .production:
            return "wss://www.pocketctl.me/ws"
        case .staging:
            return "ws://\(stagingHost)/ws"
        }
    }

    /// 帮助页面/安装脚本中用于注册主机的安装 URL（仅生产环境使用）
    var installURL: String {
        switch self {
        case .production:
            return "https://www.pocketctl.me/install.sh"
        case .staging:
            return "http://\(stagingHost)/install.sh"
        }
    }

    /// 帮助页面中显示的 relay 地址文字
    var relayURLText: String {
        switch self {
        case .production:
            return httpBaseURL
        case .staging:
            return "本地开发 (\(httpBaseURL))"
        }
    }

    /// 当前测试环境的主机地址：优先用户自定义，否则使用默认值
    private var stagingHost: String {
        let custom = RelayEnvironmentManager.shared.customStagingHost
        return custom?.isEmpty == false ? custom! : Self.defaultStagingHost
    }
}

/// 当前活跃的 Relay 环境（持久化在 UserDefaults 中）
final class RelayEnvironmentManager: @unchecked Sendable {
    static let shared = RelayEnvironmentManager()

    /// 测试环境的自定义主机地址（IP 或域名）。持久化，为空时使用默认值 192.168.31.198
    private let hostStorageKey = "pocketctl_relay_staging_host"

    /// 当前环境（仅内存态）：每次 App 冷启动默认为生产环境，
    /// 用户在设置页切换到测试环境后当次会话生效，重启后恢复为生产环境。
    private var _current: RelayEnvironment = .production

    var current: RelayEnvironment {
        get { _current }
        set { _current = newValue }
    }

    /// 测试环境的自定义主机地址（IP 或域名）。为空时使用默认值 192.168.31.198
    var customStagingHost: String? {
        get { UserDefaults.standard.string(forKey: hostStorageKey) }
        set { UserDefaults.standard.set(newValue, forKey: hostStorageKey) }
    }

    /// 切换环境（返回新的环境）
    @discardableResult
    func toggle() -> RelayEnvironment {
        let new: RelayEnvironment
        switch current {
        case .production: new = .staging
        case .staging:    new = .production
        }
        current = new
        return new
    }

    private init() {}
}

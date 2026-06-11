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

    /// 该环境的 HTTP/REST base URL
    /// - Note: 生产地址在编译时通过 Info.plist 或构建配置注入，
    ///         后续生产打 Release 包时替换为正式域名。
    var httpBaseURL: String {
        switch self {
        case .production:
            return "http://39.106.218.47"
        case .staging:
            return "http://localhost:8080"
        }
    }

    /// 该环境的 WebSocket URL
    var wsBaseURL: String {
        switch self {
        case .production:
            return "ws://39.106.218.47/ws"
        case .staging:
            return "ws://localhost:8080/ws"
        }
    }

    /// 帮助页面/安装脚本中用于注册主机的安装 URL（仅生产环境使用）
    var installURL: String {
        switch self {
        case .production:
            return "https://raw.githubusercontent.com/pocketctl/pocketctl/master/scripts/install-daemon.sh"
        case .staging:
            return "http://localhost:8080/install.sh"
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
}

/// 当前活跃的 Relay 环境（持久化在 UserDefaults 中）
final class RelayEnvironmentManager: @unchecked Sendable {
    static let shared = RelayEnvironmentManager()

    private let storageKey = "pocketctl_relay_environment"

    var current: RelayEnvironment {
        get {
            guard let raw = UserDefaults.standard.string(forKey: storageKey),
                  let env = RelayEnvironment(rawValue: raw) else {
                return .production // 默认生产环境
            }
            return env
        }
        set {
            UserDefaults.standard.set(newValue.rawValue, forKey: storageKey)
        }
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

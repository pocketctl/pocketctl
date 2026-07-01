import Foundation
import SwiftUI
import UIKit

@Observable
@MainActor
final class SettingsViewModel {
    // MARK: - State

    var user: User?
    var relayURLText: String = ""
    var notificationsEnabled: Bool = false
    /// 各通知分类的开关态,key = NotificationCategory.id。
    /// UI 通过 `isCategoryEnabled(_)` / `toggleCategory(_:enabled:)` 访问,不直接读写此字典。
    private(set) var notificationPreferences: [String: Bool] = [:]
    var relayURLValidationMessage: String? = nil
    var relayURLIsValid: Bool = true
    var isTestingConnection: Bool = false

    /// 设置页签名卡热力图数据（全局，近 5 个月）。独立于用量页，失败静默。
    private(set) var heatmapSeries: [TokenDailyPoint] = []
    private(set) var heatmapLoading: Bool = false

    var connectionStatus: ConnectionStatus = .unknown

    var showEditProfile = false
    var showRegisterHost = false
    var showPrivacyPolicy = false
    var showUserAgreement = false
    var showAbout = false
    var showHelp = false

    var editDisplayName: String = ""

    // 测试环境地址编辑
    var showStagingHostEdit = false
    var editStagingHost: String = ""
    var stagingHostValidationMessage: String? = nil

    enum ConnectionStatus {
        case unknown
        case connected
        case disconnected
        case testing
    }

    private let pushService = PushService()
    private let apiClient = APIClient()

    // MARK: - Computed

    var currentEnvironment: RelayEnvironment {
        RelayEnvironmentManager.shared.current
    }

    /// 当前订阅方案：优先用接口返回的最新 user，其次用本地缓存，兜底免费版
    var subscriptionPlan: SubscriptionPlan {
        user?.subscriptionPlan ?? KeychainStorage.currentUser?.subscriptionPlan ?? .free
    }

    var effectiveDisplayName: String {
        KeychainStorage.localDisplayName
            ?? user?.displayName
            ?? user?.phone
            ?? "未设置"
    }

    var avatarInitial: String {
        let name = effectiveDisplayName
        if name == "未设置" { return "?" }
        return String(name.prefix(1)).uppercased()
    }

    var displayPhone: String {
        if let phone = user?.phone, !phone.isEmpty {
            let digits = phone.filter { $0.isNumber }
            if digits.count == 11 {
                let a = digits.prefix(3)
                let b = digits.dropFirst(3).prefix(4)
                let c = digits.dropFirst(7)
                return "\(a) \(b) \(c)"
            }
            return phone
        }
        return "未绑定"
    }

    var displayEmail: String {
        if let email = user?.email, !email.isEmpty {
            return email
        }
        return "未绑定"
    }

    var isEmailBound: Bool {
        guard let email = user?.email else { return false }
        return !email.isEmpty
    }

    var isPhoneBound: Bool {
        guard let phone = user?.phone else { return false }
        return !phone.isEmpty
    }

    var appVersion: String {
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.1.0"
        return "v\(version)"
    }

    /// 热力图全局最大单日 (input+output)，作为 5 级分级基准。无数据时返回 1 避免 除 0。
    var heatmapMax: Int {
        max(1, heatmapSeries.map { $0.input + $0.output }.max() ?? 1)
    }

    /// 签名卡近 5 个月总消耗（input+output 求和），用于底部 caption。
    var heatmapTotal: Int {
        heatmapSeries.reduce(0) { $0 + $1.input + $1.output }
    }

    // MARK: - Init

    init() {
        loadFromStorage()
        loadProfile()
    }

    func loadFromStorage() {
        user = KeychainStorage.currentUser
        relayURLText = KeychainStorage.relayURL ?? ""
        notificationsEnabled = KeychainStorage.notificationsEnabled
        loadNotificationPreferences()
    }

    /// 加载各通知分类开关偏好。未显式设置过的分类回退到其默认值。
    private func loadNotificationPreferences() {
        var prefs: [String: Bool] = [:]
        for category in NotificationCategory.all {
            prefs[category.id] = KeychainStorage.notificationCategoryEnabled(category) ?? category.defaultEnabled
        }
        notificationPreferences = prefs
    }

    /// 从后端拉取最新用户资料（含订阅方案），刷新本地缓存
    func loadProfile() {
        Task {
            do {
                let profile = try await apiClient.getUserProfile()
                user = profile
                KeychainStorage.currentUser = profile
            } catch {
                // 拉取失败时保持本地缓存的订阅状态，不阻塞 UI
            }
        }
    }

    /// 加载签名卡热力图（全局，近 5 个月 ≈ 150 天）。失败静默，不阻塞 UI。
    /// 窗口与用量页 `TokenUsageViewModel.fetchHeatmap()` 的 days:150 一致，保证签名与完整页同源。
    func loadHeatmap() async {
        heatmapLoading = true
        heatmapSeries = (try? await apiClient.getTokenDashboard(daemon: "all", days: 150))?.dailySeries ?? []
        heatmapLoading = false
    }

    // MARK: - Actions

    func logout() {
        KeychainStorage.clearAll()
        user = nil
        notificationsEnabled = false
        notificationPreferences = [:]
        relayURLText = ""
    }

    // MARK: - Relay Environment

    /// 切换环境。切到测试环境时不立即切换，而是弹出地址编辑框让用户确认/修改测试服务器地址；
    /// 切回生产环境时直接生效（保留已保存的测试地址，便于下次复用）。
    func switchEnvironment(to env: RelayEnvironment) {
        if env == .staging {
            prepareStagingHostEdit()
        } else {
            RelayEnvironmentManager.shared.current = env
            // 清除旧的自定义 relayURL（已废弃）
            KeychainStorage.relayURL = nil
            relayURLText = ""
            loadFromStorage()
        }
    }

    /// 准备编辑测试环境地址：回显当前地址（自定义优先，否则默认值）并弹出编辑框
    func prepareStagingHostEdit() {
        let current = RelayEnvironmentManager.shared.customStagingHost
        editStagingHost = (current?.isEmpty == false ? current! : RelayEnvironment.defaultStagingHost)
        stagingHostValidationMessage = nil
        // 在编辑框弹出前定向预热 .URL 键盘（与 IP 输入框键盘类型一致）：键盘资源
        // 加载与 sheet 弹出动画并行，等输入框自动聚焦时键盘已「热」，消除首次
        // 呼出键盘 1.5–2.5s 的冷启动延迟。
        KeyboardWarmup.prewarm(.URL)
        showStagingHostEdit = true
    }

    /// 校验并保存测试环境主机地址，成功后切到测试环境并立即生效。
    func saveStagingHost() {
        let trimmed = editStagingHost.trimmingCharacters(in: .whitespacesAndNewlines)

        // 去掉用户误带的 scheme / 路径，只保留 host[:port]
        var host = trimmed
        for prefix in ["http://", "https://", "ws://", "wss://"] {
            if host.lowercased().hasPrefix(prefix) { host = String(host.dropFirst(prefix.count)) }
        }
        host = host.split(separator: "/").first.map(String.init) ?? host

        guard !host.isEmpty else {
            stagingHostValidationMessage = "请输入服务器地址"
            return
        }
        guard isValidHost(host) else {
            stagingHostValidationMessage = "地址格式无效，应为 IP 或域名（可带端口）"
            return
        }

        stagingHostValidationMessage = nil
        RelayEnvironmentManager.shared.customStagingHost = host
        RelayEnvironmentManager.shared.current = .staging
        showStagingHostEdit = false
        loadFromStorage()
    }

    /// 取消编辑测试地址（不切换环境）
    func cancelStagingHostEdit() {
        showStagingHostEdit = false
        stagingHostValidationMessage = nil
    }

    /// 校验 host[:port]：IPv4 / IPv6 / 域名，可选端口
    private func isValidHost(_ host: String) -> Bool {
        // IPv6 带 [] 时单独处理
        if host.hasPrefix("[") {
            // [::1]:8080 或 [::1]
            return host.range(of: #"^\[[0-9a-fA-F:]+\](:\d{1,5})?$"#, options: .regularExpression) != nil
        }
        // IPv4:port 或 IPv4
        if host.contains("."), host.allSatisfy({ $0.isNumber || $0 == "." || $0 == ":" }) {
            let parts = host.split(separator: ":")
            let ip = parts.count > 1 ? String(parts[0]) : host
            let octets = ip.split(separator: ".")
            guard octets.count == 4 else { return false }
            return octets.allSatisfy { Int($0).map { (0...255).contains($0) } ?? false }
        }
        // 域名:port 或 域名
        return host.range(of: #"^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}(:\d{1,5})?$"#, options: .regularExpression) != nil
    }

    // MARK: - Relay URL

    func validateAndSaveRelayURL() {
        let trimmed = relayURLText.trimmingCharacters(in: .whitespacesAndNewlines)

        if trimmed.isEmpty {
            relayURLValidationMessage = nil
            relayURLIsValid = true
            KeychainStorage.relayURL = nil
            return
        }

        guard let url = URL(string: trimmed),
              let scheme = url.scheme,
              ["http", "https", "ws", "wss"].contains(scheme),
              url.host != nil else {
            relayURLValidationMessage = "URL 格式无效，需要 http(s)://host 或 ws(s)://host"
            relayURLIsValid = false
            return
        }

        relayURLValidationMessage = nil
        relayURLIsValid = true
        KeychainStorage.relayURL = trimmed
    }

    func testConnection() async {
        isTestingConnection = true
        connectionStatus = .testing

        let baseURL: String
        let trimmed = relayURLText.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            baseURL = RelayEnvironmentManager.shared.current.httpBaseURL
        } else {
            baseURL = trimmed
                .replacingOccurrences(of: "wss://", with: "https://")
                .replacingOccurrences(of: "ws://", with: "http://")
                .replacingOccurrences(of: "/ws", with: "")
        }

        guard let url = URL(string: baseURL + "/health") else {
            connectionStatus = .disconnected
            isTestingConnection = false
            return
        }

        do {
            let (_, response) = try await URLSession.shared.data(from: url)
            if let http = response as? HTTPURLResponse, http.statusCode == 200 {
                connectionStatus = .connected
            } else {
                connectionStatus = .disconnected
            }
        } catch {
            connectionStatus = .disconnected
        }
        isTestingConnection = false
    }

    // MARK: - Push Notifications

    func toggleNotifications(_ enabled: Bool) {
        if enabled {
            Task {
                await pushService.requestPermission()
                notificationsEnabled = pushService.isAuthorized
                KeychainStorage.notificationsEnabled = notificationsEnabled

                if notificationsEnabled {
                    pushService.registerForRemoteNotifications()
                }
            }
        } else {
            // Unregister device from server
            if let token = KeychainStorage.deviceToken {
                Task {
                    let api = APIClient()
                    _ = try? await api.removeDevice(token: token)
                }
            }
            notificationsEnabled = false
            KeychainStorage.notificationsEnabled = false
            KeychainStorage.deviceToken = nil
        }
    }

    // MARK: - Notification Categories

    /// 某个分类是否可交互(对免费用户,Pro 专属分类不可开关,UI 应灰置)。
    func isCategoryInteractable(_ category: NotificationCategory) -> Bool {
        guard category.requiresPro else { return true }
        // Pro 专属分类:仅当用户已是 Pro(或内测 whitelist)才可操作
        return subscriptionPlan.isPro
    }

    /// 读取某分类的当前开关态(仅用于 UI 展示,不受 Pro 限制)。
    func isCategoryEnabled(_ category: NotificationCategory) -> Bool {
        notificationPreferences[category.id] ?? category.defaultEnabled
    }

    /// 切换某分类开关。
    /// - 对 Pro 专属分类 + 免费用户:忽略本次设置(`interactable` 为 false 时 View 不应调用此方法,
    ///   这里再做一次防御性检查),由上层负责弹出升级提示。
    func toggleCategory(_ category: NotificationCategory, enabled: Bool) {
        guard isCategoryInteractable(category) else { return }
        notificationPreferences[category.id] = enabled
        KeychainStorage.setNotificationCategoryEnabled(enabled, for: category)
    }

    // MARK: - Edit Profile

    func prepareEditProfile() {
        editDisplayName = KeychainStorage.localDisplayName
            ?? user?.displayName
            ?? ""
        showEditProfile = true
    }

    func saveDisplayName() {
        let trimmed = editDisplayName.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            KeychainStorage.localDisplayName = nil
        } else {
            KeychainStorage.localDisplayName = trimmed
        }
        showEditProfile = false
    }
}

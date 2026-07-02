import Foundation
import Security

/// Secure token storage using iOS Keychain
enum KeychainStorage {
    private static let service = "com.pocketctl.app"

    static func save(key: String, value: String) {
        guard let data = value.data(using: .utf8) else { return }
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
        SecItemDelete(query as CFDictionary)

        let attrs: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecValueData as String: data,
        ]
        SecItemAdd(attrs as CFDictionary, nil)
    }

    static func load(key: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess, let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func delete(key: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
        SecItemDelete(query as CFDictionary)
    }

    // MARK: - Convenience keys

    static var accessToken: String? {
        get { load(key: "access_token") }
        set {
            if let v = newValue { save(key: "access_token", value: v) }
            else { delete(key: "access_token") }
        }
    }

    static var refreshToken: String? {
        get { load(key: "refresh_token") }
        set {
            if let v = newValue { save(key: "refresh_token", value: v) }
            else { delete(key: "refresh_token") }
        }
    }

    static var relayURL: String? {
        get { UserDefaults.standard.string(forKey: "pocketctl_relay_url") }
        set { UserDefaults.standard.set(newValue, forKey: "pocketctl_relay_url") }
    }

    static var currentUser: User? {
        get {
            guard let json = load(key: "current_user") else { return nil }
            guard let data = json.data(using: .utf8) else { return nil }
            return try? JSONDecoder().decode(User.self, from: data)
        }
        set {
            if let user = newValue {
                if let data = try? JSONEncoder().encode(user),
                   let json = String(data: data, encoding: .utf8) {
                    save(key: "current_user", value: json)
                }
            } else {
                delete(key: "current_user")
            }
        }
    }

    static var notificationsEnabled: Bool {
        get { UserDefaults.standard.bool(forKey: "pocketctl_notifications_enabled") }
        set { UserDefaults.standard.set(newValue, forKey: "pocketctl_notifications_enabled") }
    }

    /// 生物认证(Face ID / Touch ID)启动锁屏开关,默认关闭。
    static var biometricEnabled: Bool {
        get { UserDefaults.standard.bool(forKey: "pocketctl_biometric_enabled") }
        set { UserDefaults.standard.set(newValue, forKey: "pocketctl_biometric_enabled") }
    }

    /// 某个通知分类的开关偏好(按 NotificationCategory.storageKey 存储)。
    /// 首次读取时无值,调用方应回退到 `defaultEnabled`。
    static func notificationCategoryEnabled(_ category: NotificationCategory) -> Bool? {
        // object(forKey:) 区分「未设置」与「显式设为 false」
        if UserDefaults.standard.object(forKey: category.storageKey) == nil { return nil }
        return UserDefaults.standard.bool(forKey: category.storageKey)
    }

    static func setNotificationCategoryEnabled(_ enabled: Bool, for category: NotificationCategory) {
        UserDefaults.standard.set(enabled, forKey: category.storageKey)
    }

    /// 清除所有通知分类偏好(用于退出登录 / 重置)
    static func clearAllNotificationCategories() {
        for category in NotificationCategory.all {
            UserDefaults.standard.removeObject(forKey: category.storageKey)
        }
    }

    static var deviceToken: String? {
        get { load(key: "device_token") }
        set {
            if let v = newValue { save(key: "device_token", value: v) }
            else { delete(key: "device_token") }
        }
    }

    static var localDisplayName: String? {
        get { UserDefaults.standard.string(forKey: "pocketctl_local_display_name") }
        set { UserDefaults.standard.set(newValue, forKey: "pocketctl_local_display_name") }
    }

    static var daemonAliases: [String: String] {
        get { UserDefaults.standard.dictionary(forKey: "pocketctl_daemon_aliases") as? [String: String] ?? [:] }
        set { UserDefaults.standard.set(newValue, forKey: "pocketctl_daemon_aliases") }
    }

    static func clearAll() {
        accessToken = nil
        refreshToken = nil
        currentUser = nil
        UserDefaults.standard.removeObject(forKey: "pocketctl_relay_url")
        UserDefaults.standard.removeObject(forKey: "pocketctl_notifications_enabled")
        UserDefaults.standard.removeObject(forKey: "pocketctl_local_display_name")
        UserDefaults.standard.removeObject(forKey: "pocketctl_biometric_enabled")
        clearAllNotificationCategories()
    }
}

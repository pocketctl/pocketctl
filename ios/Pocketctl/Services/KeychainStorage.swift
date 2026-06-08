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

    static func clearAll() {
        accessToken = nil
        refreshToken = nil
        UserDefaults.standard.removeObject(forKey: "pocketctl_relay_url")
    }
}

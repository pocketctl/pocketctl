import Foundation
import SwiftUI

@Observable
@MainActor
final class SettingsViewModel {
    // MARK: - State

    var user: User?
    var relayURLText: String = ""
    var notificationsEnabled: Bool = false
    var relayURLValidationMessage: String? = nil
    var relayURLIsValid: Bool = true
    var isTestingConnection: Bool = false
    var connectionStatus: ConnectionStatus = .unknown

    var showEditProfile = false
    var showRegisterHost = false
    var showPrivacyPolicy = false
    var showUserAgreement = false
    var showAbout = false
    var showHelp = false

    var editDisplayName: String = ""

    enum ConnectionStatus {
        case unknown
        case connected
        case disconnected
        case testing
    }

    private let pushService = PushService()

    // MARK: - Computed

    var currentEnvironment: RelayEnvironment {
        RelayEnvironmentManager.shared.current
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

    var isPhoneBound: Bool {
        guard let phone = user?.phone else { return false }
        return !phone.isEmpty
    }

    var appVersion: String {
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.1.0"
        return "v\(version)"
    }

    // MARK: - Init

    init() {
        loadFromStorage()
    }

    func loadFromStorage() {
        user = KeychainStorage.currentUser
        relayURLText = KeychainStorage.relayURL ?? ""
        notificationsEnabled = KeychainStorage.notificationsEnabled
    }

    // MARK: - Actions

    func logout() {
        KeychainStorage.clearAll()
        user = nil
        notificationsEnabled = false
        relayURLText = ""
    }

    // MARK: - Relay Environment

    func switchEnvironment(to env: RelayEnvironment) {
        RelayEnvironmentManager.shared.current = env
        // 清除自定义 relayURL（切换环境时不再使用旧的自定义 URL）
        KeychainStorage.relayURL = nil
        relayURLText = ""
        // 重新加载
        loadFromStorage()
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

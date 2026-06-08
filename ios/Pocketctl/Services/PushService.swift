import Foundation
import UserNotifications

/// Push notification service — uses local notifications for development
final class PushService {
    var isAuthorized = false

    /// Request notification permission
    func requestPermission() async {
        do {
            isAuthorized = try await UNUserNotificationCenter.current()
                .requestAuthorization(options: [.alert, .sound, .badge])
        } catch {
            print("[push] permission error: \(error)")
        }
    }

    /// Schedule a local notification (development mode)
    func scheduleLocalNotification(title: String, body: String, data: [String: String] = [:]) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        if let sessionID = data["session_id"] {
            content.userInfo = ["session_id": sessionID]
        }

        let trigger = UNTimeIntervalNotificationTrigger(timeInterval: 0.1, repeats: false)
        let request = UNNotificationRequest(
            identifier: UUID().uuidString,
            content: content,
            trigger: trigger
        )
        UNUserNotificationCenter.current().add(request)
    }

    /// Register for remote notifications (APNs) — called from AppDelegate or SceneDelegate
    func registerForRemoteNotifications() {
        // UIApplication.shared.registerForRemoteNotifications()
        // Requires UIKit import; call from app entry point
    }

    /// Handle received device token from APNs
    func handleDeviceToken(_ deviceToken: Data) {
        let token = deviceToken.map { String(format: "%02.2hhx", $0) }.joined()
        print("[push] device token: \(token)")
    }
}

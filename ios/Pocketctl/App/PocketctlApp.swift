import SwiftUI
import UserNotifications

/// Global notification state for deep-linking to sessions
@Observable
@MainActor
final class NotificationRouter {
    var navigateToSessionId: String?
    /// 推送携带的通知类型(approval / interactive / session_status …),用于深链落地后
    /// 做差异化处理(如审批类可优先滚动到审批卡)。P0 仅记录,落地行为后续打磨。
    var pendingNotificationType: String?
    /// 推送携带的 request_id(审批/交互),落地后可定位具体审批卡。
    var pendingRequestId: String?
}

@MainActor
let notificationRouter = NotificationRouter()

class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    nonisolated func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    nonisolated func application(_ application: UIApplication,
                     didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Task { @MainActor in
            let pushService = PushService()
            pushService.handleDeviceToken(deviceToken)
        }
    }

    nonisolated func application(_ application: UIApplication,
                     didFailToRegisterForRemoteNotificationsWithError error: Error) {
        print("[push] failed to register: \(error)")
    }

    // MARK: - UNUserNotificationCenterDelegate

    /// App in foreground: show banner + sound
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound, .badge])
    }

    /// User tapped notification: navigate to session
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        let userInfo = response.notification.request.content.userInfo
        // Extract Sendable primitives before crossing into the @MainActor
        // closure — Swift 6 strict concurrency disallows capturing the
        // task-isolated `userInfo` dictionary across actors.
        let sessionId = userInfo["session_id"] as? String
        let type = userInfo["type"] as? String
        let requestId = userInfo["request_id"] as? String
        if let sessionId {
            Task { @MainActor in
                notificationRouter.navigateToSessionId = sessionId
                notificationRouter.pendingNotificationType = type
                notificationRouter.pendingRequestId = requestId
            }
        }
        completionHandler()
    }
}

@main
struct PocketctlApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

    var body: some Scene {
        WindowGroup {
            ContentView()
                .preferredColorScheme(.dark)
        }
    }
}

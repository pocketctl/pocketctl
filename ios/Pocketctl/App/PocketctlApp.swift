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
    /// insights 类推送(日报/周报)的深链信号。置 true 后由 DaemonListView
    /// 消费,导航到全局用量统计页,然后清空。
    var navigateToUsage: Bool = false
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
        Task { @MainActor in
            // insights 类推送(日报/周报)没有 session_id,路由到全局用量页。
            if type == "insights" {
                notificationRouter.navigateToUsage = true
                notificationRouter.pendingNotificationType = type
                return
            }
            // 会话类推送:靠 session_id 定位到具体会话详情。
            if let sessionId {
                notificationRouter.navigateToSessionId = sessionId
                notificationRouter.pendingNotificationType = type
                notificationRouter.pendingRequestId = requestId
            }
        }
        // completionHandler 在 nonisolated 同步上下文调用,不跨 actor 边界
        // (Swift 6 严格并发禁止将 @escaping closure 发送到 Task)。
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

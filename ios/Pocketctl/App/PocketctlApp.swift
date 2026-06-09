import SwiftUI
import UserNotifications

/// Global notification state for deep-linking to sessions
@Observable
@MainActor
final class NotificationRouter {
    var navigateToSessionId: String?
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
        if let sessionId = userInfo["session_id"] as? String {
            Task { @MainActor in
                notificationRouter.navigateToSessionId = sessionId
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

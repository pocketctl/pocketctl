import SwiftUI

private enum AppState {
    case splash
    case login
    case main
}

struct ContentView: View {
    @State private var appState: AppState = .splash
    @State private var isLoggedIn = false
    /// 整个生命周期内是否已预热过键盘（避免重复预热）
    @State private var hasKeyboardWarmedUp = false

    var body: some View {
        switch appState {
        case .splash:
            SplashView()
                .onAppear {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                        if let token = KeychainStorage.accessToken, !token.isEmpty {
                            isLoggedIn = true
                            appState = .main
                        } else {
                            appState = .login
                        }
                    }
                }
        case .login:
            LoginView(isLoggedIn: $isLoggedIn)
                .onChange(of: isLoggedIn) { _, newValue in
                    if newValue { appState = .main }
                }
        case .main:
            DaemonListView(isLoggedIn: $isLoggedIn)
                .onChange(of: isLoggedIn) { _, newValue in
                    if !newValue { appState = .login }
                }
                .onOpenURL { url in
                    // Handle pocketctl://session/<id> deep links
                    handleDeepLink(url)
                }
                .onChange(of: notificationRouter.navigateToSessionId) { _, sessionId in
                    if sessionId != nil {
                        // Clear after a delay to allow navigation
                        DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
                            notificationRouter.navigateToSessionId = nil
                        }
                    }
                }
                .onAppear {
                    // 键盘冷启动预热：自动登录路径下整个会话从未弹过键盘，
                    // 进入主界面后延后约 0.3s（避开首屏渲染峰值）后台预热一次，
                    // 让用户首次点 TextField（如设置→改测试环境 IP）时键盘已「热」。
                    guard !hasKeyboardWarmedUp else { return }
                    hasKeyboardWarmedUp = true
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                        KeyboardWarmup.warmup()
                    }
                }
        }
    }

    private func handleDeepLink(_ url: URL) {
        guard url.scheme == "pocketctl",
              url.host == "session",
              let sessionId = url.pathComponents.dropFirst().first else { return }
        notificationRouter.navigateToSessionId = sessionId
    }
}

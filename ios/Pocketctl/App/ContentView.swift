import SwiftUI

private enum AppState {
    case splash
    case login
    case main
}

struct ContentView: View {
    @State private var appState: AppState = .splash
    @State private var isLoggedIn = false

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
        }
    }
}

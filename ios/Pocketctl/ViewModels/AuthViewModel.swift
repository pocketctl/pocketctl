import Foundation

@Observable
@MainActor
final class AuthViewModel {
    var phone: String = ""
    var code: String = ""
    var isLoading = false
    var isSendingCode = false
    var error: String?
    var countdown: Int = 0
    var isLoggedIn = false
    var user: User?

    private let apiClient: APIClient
    private var countdownTimer: Timer?

    init(apiClient: APIClient = APIClient()) {
        self.apiClient = apiClient
        // Check existing token
        if let token = KeychainStorage.accessToken, !token.isEmpty {
            isLoggedIn = true
        }
    }

    var canSendCode: Bool {
        isValidPhone && !isSendingCode && countdown == 0
    }

    var canLogin: Bool {
        code.count == 6 && !isLoading
    }

    /// Whether the phone number is a valid Chinese mobile number (1开头, 11位数字)
    var isValidPhone: Bool {
        let digits = phone.filter { $0.isNumber }
        guard digits.count == 11 else { return false }
        return digits.first == "1"
    }

    /// Send SMS verification code
    func sendCode() async {
        guard canSendCode else { return }
        isSendingCode = true
        error = nil

        do {
            let normalized = phoneDigits
            _ = try await apiClient.sendSMS(phone: normalized)
            startCountdown()
        } catch {
            self.error = error.localizedDescription
        }
        isSendingCode = false
    }

    /// Verify SMS code and login
    func login() async {
        guard canLogin else { return }
        isLoading = true
        error = nil

        do {
            let normalized = phoneDigits
            let response = try await apiClient.verifySMS(phone: normalized, code: code)
            saveTokens(response)
            isLoggedIn = true
            user = response.user
        } catch {
            self.error = error.localizedDescription
        }
        isLoading = false
    }

    /// Pure digits of the phone number (no spaces)
    private var phoneDigits: String {
        phone.filter { $0.isNumber }
    }

    /// Logout
    func logout() {
        KeychainStorage.clearAll()
        isLoggedIn = false
        user = nil
        phone = ""
        code = ""
    }

    // MARK: - Private

    private func saveTokens(_ response: AuthResponse) {
        KeychainStorage.accessToken = response.access_token
        KeychainStorage.refreshToken = response.refresh_token
    }

    private func startCountdown() {
        countdown = 60
        countdownTimer?.invalidate()
        let t = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.countdown -= 1
                if self.countdown <= 0 {
                    self.countdownTimer?.invalidate()
                }
            }
        }
        countdownTimer = t
    }
}

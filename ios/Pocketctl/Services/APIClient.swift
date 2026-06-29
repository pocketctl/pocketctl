import Foundation

/// HTTP REST client for relay server auth and device APIs
final class APIClient: @unchecked Sendable {
    /// 当前环境的 HTTP base URL（每次请求动态读取，确保切换环境/修改测试地址后立即生效）
    var baseURL: String {
        RelayEnvironmentManager.shared.current.httpBaseURL
    }

    init() {}

    // MARK: - Auth

    func login(email: String, password: String) async throws -> AuthResponse {
        try await post(path: "/api/auth/login", body: ["email": email, "password": password])
    }

    func register(email: String, password: String, displayName: String?) async throws -> AuthResponse {
        var body: [String: Any] = ["email": email, "password": password]
        if let name = displayName { body["displayName"] = name }
        return try await post(path: "/api/auth/register", body: body)
    }

    func sendSMS(phone: String) async throws -> SMSResponse {
        try await post(path: "/api/auth/sms/send", body: ["phone": phone])
    }

    func verifySMS(phone: String, code: String) async throws -> AuthResponse {
        try await post(path: "/api/auth/sms/verify", body: ["phone": phone, "code": code])
    }

    // MARK: - Email Verification Code Auth (current, backend-supported flow)

    func sendEmailCode(email: String) async throws -> SMSResponse {
        try await post(path: "/api/auth/email/send", body: ["email": email])
    }

    /// Verify email code → login-or-register → returns tokens + user.
    func loginViaEmail(email: String, code: String) async throws -> AuthResponse {
        try await post(path: "/api/auth/email/verify", body: ["email": email, "code": code])
    }

    // MARK: - QR Scan-Login (iOS is the confirming device)

    /// Confirm a QR login session scanned from the web client. Requires the
    /// iOS user to be already authenticated (Bearer token added automatically).
    func confirmQrLogin(qrToken: String) async throws -> SuccessResponse {
        try await authorizedPost(path: "/api/auth/qr/confirm", body: ["qr_token": qrToken])
    }

    func refreshToken(_ token: String) async throws -> AuthResponse {
        try await post(path: "/api/auth/refresh", body: ["refresh_token": token])
    }

    // MARK: - Devices

    func registerDevice(token: String, platform: String = "ios", deviceName: String? = nil) async throws -> SuccessResponse {
        var body: [String: Any] = ["deviceToken": token, "platform": platform]
        if let name = deviceName { body["deviceName"] = name }
        return try await authorizedPost(path: "/api/devices/register", body: body)
    }

    func removeDevice(token: String) async throws -> SuccessResponse {
        try await authorizedDelete(path: "/api/devices/\(token)")
    }

    // MARK: - User Profile

    /// 获取当前用户资料（含订阅方案 plan）
    func getUserProfile() async throws -> User {
        try await authorizedGet(path: "/api/user/profile")
    }

    // MARK: - Daemon Alias

    func setDaemonAlias(daemonId: String, alias: String?) async throws -> AliasResponse {
        try await authorizedPut(path: "/api/daemons/\(daemonId)/alias", body: ["alias": alias as Any])
    }

    // MARK: - Token Usage

    func getTokenSummary() async throws -> TokenSummary {
        try await authorizedGet(path: "/api/tokens/summary")
    }

    func getTokenDashboard(daemon: String = "all", days: Int = 30) async throws -> TokenDashboard {
        try await authorizedGet(path: "/api/tokens/dashboard?daemon=\(daemon)&days=\(days)")
    }

    func getTokensByDaemon(daemonId: String) async throws -> TokensByDaemon {
        try await authorizedGet(path: "/api/tokens/by-daemon/\(daemonId)")
    }

    func getSessionTokenTrend(sessionId: String) async throws -> SessionTokenTrend {
        try await authorizedGet(path: "/api/tokens/session/\(sessionId)/trend")
    }

    // MARK: - Daemon Operations

    func upgradeAgent(daemonId: String, agent: String) async throws -> SuccessResponse {
        try await authorizedPost(path: "/api/daemons/\(daemonId)/upgrade-agent", body: ["agent": agent])
    }

    func restartDaemon(daemonId: String) async throws -> SuccessResponse {
        try await authorizedPost(path: "/api/daemons/\(daemonId)/restart", body: [:])
    }

    func forceKickDaemon(daemonId: String) async throws -> SuccessResponse {
        try await authorizedPost(path: "/api/daemons/\(daemonId)/forceKick", body: [:])
    }

    func deleteDaemon(daemonId: String) async throws -> SuccessResponse {
        try await authorizedDelete(path: "/api/daemons/\(daemonId)")
    }

    // MARK: - Internal

    private func authorizedHeaders() -> [String: String] {
        var headers = ["Content-Type": "application/json"]
        if let token = KeychainStorage.accessToken {
            headers["Authorization"] = "Bearer \(token)"
        }
        return headers
    }

    private func post<T: Decodable>(path: String, body: [String: Any]) async throws -> T {
        guard let url = URL(string: baseURL + path) else { throw APIError.invalidURL }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.allHTTPHeaderFields = ["Content-Type": "application/json"]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await URLSession.shared.data(for: request)
        try checkResponse(response, data: data)
        return try JSONDecoder().decode(T.self, from: data)
    }

    private func authorizedPost<T: Decodable>(path: String, body: [String: Any]) async throws -> T {
        guard let url = URL(string: baseURL + path) else { throw APIError.invalidURL }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.allHTTPHeaderFields = authorizedHeaders()
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await URLSession.shared.data(for: request)
        try checkResponse(response, data: data)
        return try JSONDecoder().decode(T.self, from: data)
    }

    private func authorizedDelete<T: Decodable>(path: String) async throws -> T {
        guard let url = URL(string: baseURL + path) else { throw APIError.invalidURL }
        var request = URLRequest(url: url)
        request.httpMethod = "DELETE"
        request.allHTTPHeaderFields = authorizedHeaders()

        let (data, response) = try await URLSession.shared.data(for: request)
        try checkResponse(response, data: data)
        return try JSONDecoder().decode(T.self, from: data)
    }

    private func authorizedPut<T: Decodable>(path: String, body: [String: Any]) async throws -> T {
        guard let url = URL(string: baseURL + path) else { throw APIError.invalidURL }
        var request = URLRequest(url: url)
        request.httpMethod = "PUT"
        request.allHTTPHeaderFields = authorizedHeaders()
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await URLSession.shared.data(for: request)
        try checkResponse(response, data: data)
        return try JSONDecoder().decode(T.self, from: data)
    }

    private func authorizedGet<T: Decodable>(path: String) async throws -> T {
        guard let url = URL(string: baseURL + path) else { throw APIError.invalidURL }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.allHTTPHeaderFields = authorizedHeaders()

        let (data, response) = try await URLSession.shared.data(for: request)
        try checkResponse(response, data: data)
        // Token API uses snake_case JSON keys (cache_read, daemon_id, …); decode
        // with snake_case conversion so structs can use camelCase properties.
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try decoder.decode(T.self, from: data)
    }

    private func checkResponse(_ response: URLResponse, data: Data) throws {
        guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }
        if http.statusCode >= 400 {
            let errorMsg = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
            if http.statusCode == 401 {
                // Distinguish auth failure from verification code errors
                let msg = errorMsg ?? "认证失败"
                throw APIError.serverError(statusCode: http.statusCode, message: msg == "invalid or expired verification code" ? "验证码无效或已过期，请重新获取" : msg)
            }
            throw APIError.serverError(statusCode: http.statusCode, message: errorMsg ?? "unknown error")
        }
    }
}

// MARK: - Response types

struct AuthResponse: Decodable {
    let access_token: String
    let refresh_token: String
    let user: User
}

struct SMSResponse: Decodable {
    let success: Bool
    let message: String?
}

struct SuccessResponse: Decodable {
    let success: Bool
}

struct AliasResponse: Decodable {
    let success: Bool
    let alias: String?
}

// MARK: - Token Usage Types

struct TokenSummary: Decodable {
    let total: Int
    let today: Int
    let thisWeek: Int
    let thisMonth: Int
}

struct TokenDailyPoint: Decodable {
    let date: String
    let input: Int
    let output: Int
    let cacheRead: Int
    let requests: Int
}

struct TokenModelRow: Decodable {
    let model: String
    let input: Int
    let output: Int
    let cacheRead: Int
    let requests: Int
    let total: Int
    let pct: Double
}

struct TokenDaemonRow: Decodable {
    let daemonId: String
    let hostname: String
    let alias: String?
    let input: Int
    let output: Int
    let cacheRead: Int
    let requests: Int
    let total: Int
}

struct TokenDashboard: Decodable {
    let summary: TokenSummary
    let dailySeries: [TokenDailyPoint]
    let byModel: [TokenModelRow]
    let byDaemon: [TokenDaemonRow]
}

struct TokenSessionRow: Decodable {
    let sessionId: String
    let title: String
    let totalTokens: Int
    let tokInput: Int
    let tokOutput: Int
    let tokCacheRead: Int
    let tokCacheCreate: Int
    let model: String
    let agentType: String
    let status: String
}

struct TokensByDaemon: Decodable {
    let total: Int
    let today: Int
    let thisMonth: Int
    let sessions: [TokenSessionRow]
}

struct SessionTokenTrend: Decodable {
    let trend: [TokenDailyPoint]
    let archived: Bool
}

// MARK: - Errors

enum APIError: LocalizedError {
    case invalidURL
    case invalidResponse
    case unauthorized
    case serverError(statusCode: Int, message: String)

    var errorDescription: String? {
        switch self {
        case .invalidURL: return "无效的 URL"
        case .invalidResponse: return "无效的响应"
        case .unauthorized: return "认证失败，请重新登录"
        case .serverError(_, let msg): return msg
        }
    }
}

import Foundation

/// HTTP REST client for relay server auth and device APIs
final class APIClient: @unchecked Sendable {
    let baseURL: String

    init() {
        // 始终使用 RelayEnvironmentManager 获取当前环境的 baseURL
        // 不再依赖 KeychainStorage.relayURL（已废弃，仅用于向后兼容）
        if let stored = KeychainStorage.relayURL, !stored.isEmpty {
            // 如果用户手动设置了自定义 relay URL（旧版兼容），使用它
            self.baseURL = stored
                .replacingOccurrences(of: "wss://", with: "https://")
                .replacingOccurrences(of: "ws://", with: "http://")
                .replacingOccurrences(of: "/ws", with: "")
        } else {
            // 使用环境管理器的 baseURL
            self.baseURL = RelayEnvironmentManager.shared.current.httpBaseURL
        }
    }

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

    // MARK: - Daemon Alias

    func setDaemonAlias(daemonId: String, alias: String?) async throws -> AliasResponse {
        try await authorizedPut(path: "/api/daemons/\(daemonId)/alias", body: ["alias": alias as Any])
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

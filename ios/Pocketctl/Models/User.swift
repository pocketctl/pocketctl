import Foundation

struct User: Codable, Identifiable, Sendable {
    let id: Int
    let email: String
    let phone: String?
    let displayName: String?
    let plan: String?
    let quota: QuotaStatus?

    enum CodingKeys: String, CodingKey {
        case id, email, phone, plan, quota
        case displayName = "display_name"
    }

    /// 服务端方案字段仅用于内部配额兼容。
    var subscriptionPlan: SubscriptionPlan {
        SubscriptionPlan(rawValue: plan ?? "free") ?? .free
    }
}

enum SubscriptionPlan: String, Sendable {
    case free
    case pro

    var isPro: Bool { self == .pro }
}

struct QuotaResource: Codable, Sendable, Hashable {
    let used: Int
    let reserved: Int?
    let limit: Int?
    let overLimit: Bool

    var reached: Bool {
        guard let limit else { return false }
        return used + (reserved ?? 0) >= limit
    }

    enum CodingKeys: String, CodingKey {
        case used, reserved, limit
        case overLimit = "over_limit"
    }
}

struct QuotaResources: Codable, Sendable, Hashable {
    let boundHosts: QuotaResource
    let concurrentSessions: QuotaResource

    enum CodingKeys: String, CodingKey {
        case boundHosts = "bound_hosts"
        case concurrentSessions = "concurrent_sessions"
    }
}

struct QuotaStatus: Codable, Sendable, Hashable {
    let plan: String?
    let resources: QuotaResources

    static func from(dict: [String: Any]) -> QuotaStatus? {
        guard JSONSerialization.isValidJSONObject(dict),
              let data = try? JSONSerialization.data(withJSONObject: dict) else { return nil }
        return try? JSONDecoder().decode(QuotaStatus.self, from: data)
    }
}

import Foundation

struct User: Codable, Identifiable, Sendable {
    let id: Int
    let email: String
    let phone: String?
    let displayName: String?
    let plan: String?

    enum CodingKeys: String, CodingKey {
        case id, email, phone, plan
        case displayName = "display_name"
    }

    /// 订阅方案枚举（plan 字段为 free 或缺失视为免费版，其余视为专业版）
    var subscriptionPlan: SubscriptionPlan {
        SubscriptionPlan(rawValue: plan ?? "free") ?? .free
    }
}

enum SubscriptionPlan: String, Sendable {
    case free
    case pro

    var displayName: String {
        switch self {
        case .free: return "免费版"
        case .pro: return "专业版"
        }
    }

    /// 方案说明
    var description: String {
        switch self {
        case .free: return "免费版：1 台主机，基础监控"
        case .pro: return "专业版：无限主机 · 推送通知 · 实时消息"
        }
    }

    var isPro: Bool { self == .pro }
}

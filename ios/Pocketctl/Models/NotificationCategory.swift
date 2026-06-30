import SwiftUI

/// 推送通知分类。
///
/// 对应 `docs/plans/2026-06-30-ios-push-notifications-design.md` 中的分级规划:
/// - A 审批与交互、B 会话完结、C 主机状态:免费开放(产品命脉,不能限)
/// - D 增值洞察:Pro 专属(日报/周报/高危提醒/自定义规则)
///
/// 设置页据此渲染分类开关列表;Pro 类型对免费用户灰置并展示 PRO 徽章。
/// 真正的推送门控在 relay 端按用户 plan 判定,这里只负责本地偏好与 UI 呈现。
struct NotificationCategory: Identifiable, Sendable {
    let id: String
    let title: String
    let subtitle: String
    let icon: String             // SF Symbol
    let iconBg: Color
    let iconFg: Color
    let requiresPro: Bool

    /// 本地存储 key(与 KeychainStorage 的 UserDefaults 偏好对齐)
    var storageKey: String { "pocketctl_notif_\(id)" }

    /// 该分类在「免费用户」下的默认开关状态。
    /// 免费开放的 A/B/C 默认开;Pro 专属的 D 默认关(且对免费用户不可开)。
    var defaultEnabled: Bool { !requiresPro }
}

extension NotificationCategory {
    /// 设置页渲染顺序固定,4 大分类。
    static let all: [NotificationCategory] = [.approval, .sessionStatus, .hostStatus, .insights]

    /// A 审批与交互 —— agent 需要你授权工具调用 / 回答问题时实时提醒(命脉,免费)
    static let approval = NotificationCategory(
        id: "approval",
        title: "审批与交互",
        subtitle: "Agent 请求授权或等待输入时提醒",
        icon: "hand.raised.fill",
        iconBg: .pcAccentMuted,
        iconFg: .pcAccent,
        requiresPro: false
    )

    /// B 会话完结 —— 任务完成 / 报错 / 被杀时通知(免费)
    static let sessionStatus = NotificationCategory(
        id: "session_status",
        title: "会话完结",
        subtitle: "任务完成、报错或中断时通知",
        icon: "checkmark.seal.fill",
        iconBg: .pcSuccessBg,
        iconFg: .pcSuccess,
        requiresPro: false
    )

    /// C 主机状态 —— daemon 掉线 / 上线时通知(免费)
    static let hostStatus = NotificationCategory(
        id: "host_status",
        title: "主机状态",
        subtitle: "开发机上线 / 掉线时通知",
        icon: "desktopcomputer",
        iconBg: .pcWarningBg,
        iconFg: .pcWarning,
        requiresPro: false
    )

    /// D 增值洞察 —— Token 日报、周报、高危操作提醒、自定义规则(Pro 专属)
    static let insights = NotificationCategory(
        id: "insights",
        title: "增值洞察",
        subtitle: "Token 日报 / 周报 / 高危操作提醒",
        icon: "chart.bar.fill",
        iconBg: .pcSubAgentBg,
        iconFg: .pcSubAgent,
        requiresPro: true
    )
}

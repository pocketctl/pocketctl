import Foundation

enum ClaudePermissionMode: String, CaseIterable, Identifiable, Codable {
    case manual, auto, acceptEdits, dontAsk, plan, bypassPermissions
    var id: String { rawValue }
    var title: String { switch self { case .manual: "请求批准"; case .auto: "自动判断"; case .acceptEdits: "自动编辑"; case .dontAsk: "不主动询问"; case .plan: "仅规划"; case .bypassPermissions: "跳过权限" } }
    var description: String { switch self { case .manual: "执行工具前请求确认"; case .auto: "Claude 根据风险决定是否询问"; case .acceptEdits: "自动执行编辑类工具"; case .dontAsk: "不申请未获授权的操作"; case .plan: "只分析和规划"; case .bypassPermissions: "不经确认执行工具，风险较高" } }
    var icon: String { switch self { case .manual: "hand.raised"; case .auto: "wand.and.stars"; case .acceptEdits: "pencil.and.outline"; case .dontAsk: "hand.raised.slash"; case .plan: "list.clipboard"; case .bypassPermissions: "exclamationmark.shield" } }
}

enum CodexPermissionPreset: String, CaseIterable, Identifiable, Codable {
    case requestApproval = "request_approval", agentManaged = "agent_managed", fullAccess = "full_access", custom
    var id: String { rawValue }
    var title: String { switch self { case .requestApproval: "请求批准"; case .agentManaged: "Agent 管理"; case .fullAccess: "完全访问"; case .custom: "自定义" } }
    var description: String { switch self { case .requestApproval: "执行敏感操作前请求远程批准（需要 Codex 0.144.1+ managed 模式）"; case .agentManaged: "由 Codex 根据操作风险决定是否请求批准（需要 Codex 0.144.1+ managed 模式）"; case .fullAccess: "完全访问计算机，风险较高"; case .custom: "使用自定义权限组合" } }
    var icon: String { switch self { case .requestApproval: "hand.raised"; case .agentManaged: "apple.terminal"; case .fullAccess: "exclamationmark.shield"; case .custom: "gearshape" } }
    var supported: Bool { true }
}

struct AgentPermissionConfig: Equatable, Codable {
    var agent: String
    var mode: ClaudePermissionMode?
    var preset: CodexPermissionPreset?
    var approvalPolicy: String?
    var sandboxMode: String?
    var dangerouslyBypass = false

    static func defaultConfig(for agent: String) -> AgentPermissionConfig? {
        switch agent {
        case "claude-code": AgentPermissionConfig(agent: agent, mode: .acceptEdits)
        case "codex": AgentPermissionConfig(agent: agent, preset: .custom)
        default: nil
        }
    }

    var title: String { mode?.title ?? preset?.title ?? "权限不可用" }
    var dictionary: [String: Any] {
        var value: [String: Any] = ["agent": agent]
        if let mode { value["mode"] = mode.rawValue }
        if let preset { value["preset"] = preset.rawValue }
        if let approvalPolicy { value["approval_policy"] = approvalPolicy }
        if let sandboxMode { value["sandbox_mode"] = sandboxMode }
        if dangerouslyBypass { value["dangerously_bypass"] = true }
        return value
    }

    static func from(_ dictionary: [String: Any]) -> AgentPermissionConfig? {
        guard let agent = dictionary["agent"] as? String else { return nil }
        return AgentPermissionConfig(agent: agent, mode: (dictionary["mode"] as? String).flatMap(ClaudePermissionMode.init), preset: (dictionary["preset"] as? String).flatMap(CodexPermissionPreset.init), approvalPolicy: dictionary["approval_policy"] as? String, sandboxMode: dictionary["sandbox_mode"] as? String, dangerouslyBypass: dictionary["dangerously_bypass"] as? Bool ?? false)
    }
}

import Foundation
import LocalAuthentication

/// 生物认证服务(Face ID / Touch ID)。仅在登录态有效且用户在设置里开启时,
/// App 启动进入主界面前弹出生物认证锁屏,认证通过才进入。
///
/// 设计要点:
/// - 开关状态存 UserDefaults(`pocketctl_biometric_enabled`),默认关闭
/// - 认证失败可重试;用户取消或认证失败时保持锁屏,不进入主界面
/// - 设备不支持生物认证时,设置里的开关置灰不可用
enum BiometricAuthService {
    /// 设备是否支持生物认证(Face ID / Touch ID)。
    /// 无法 enrol(未设置密码/未录入生物特征)也视为不支持,开关不可启用。
    static var isAvailable: Bool {
        let ctx = LAContext()
        var error: NSError?
        return ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error)
    }

    /// 生物认证类型用于 UI 文案("Face ID" / "Touch ID" / "生物认证")。
    static var displayName: String {
        let ctx = LAContext()
        var error: NSError?
        guard ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error) else {
            return "生物认证"
        }
        switch ctx.biometryType {
        case .faceID: return "Face ID"
        case .touchID: return "Touch ID"
        default: return "生物认证"
        }
    }

    /// 执行一次生物认证挑战。返回是否通过。
    /// `reason` 显示在系统弹窗上,解释为什么需要认证。
    @discardableResult
    static func authenticate(reason: String) async -> Bool {
        let ctx = LAContext()
        var error: NSError?
        guard ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error) else {
            return false
        }
        do {
            return try await ctx.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason)
        } catch {
            // 用户取消 / 认证失败 → 返回 false,由调用方决定是否重试。
            return false
        }
    }
}

import UIKit

/// 键盘冷启动预热。
///
/// iOS 的键盘 bundle、输入法引擎、联想/纠错字典、`UIRemoteKeyboardWindow` 等资源均为懒加载，
/// 首次让某个 `TextField` 成为 first responder 时需要一次性加载，冷启动场景下可达 1.5–2.5s。
///
/// 本工具在 App 进入主界面后，用一个完全不可见的离屏 `UITextField` 触发一次
/// `becomeFirstResponder() -> resignFirstResponder()`，强制系统预加载上述资源。
/// 用户全程无感知，后续真正点击输入框时键盘已是「热」的，弹出延迟降到 ~50–200ms。
enum KeyboardWarmup {

    /// 触发键盘预热。整个 App 生命周期内只需调用一次，内部自带幂等保护。
    /// - Note: 内部所有 UIKit 操作均在主线程执行；从任意线程调用都安全。
    @MainActor
    static func warmup() {
        // 幂等：整个进程只预热一次
        guard !hasWarmedUp else { return }
        hasWarmedUp = true

        // 找到当前 key window（iOS 13+ 多场景），用显式循环避免在 Swift 6 严格并发下
        // 对 main actor-isolated 属性取 key path（`\.windows`）的编译错误。
        guard let window = Self.keyWindow() else { return }

        // 离屏、完全不可见的 TextField，仅为触发键盘加载
        let field = UITextField()
        field.frame = .zero
        field.alpha = 0.01
        field.isUserInteractionEnabled = false
        // 不需要任何输入：用一个「无害」的键盘类型，避免触发额外加载
        field.keyboardType = .default
        // 加到 window 上但不参与布局
        window.addSubview(field)

        field.becomeFirstResponder()
        // 下一轮 runloop 立即收起键盘并移除视图，避免任何可见闪烁
        DispatchQueue.main.async {
            field.resignFirstResponder()
            field.removeFromSuperview()
        }
    }

    // MARK: - Private

    /// 查找当前 key window，回退到第一个 window。
    @MainActor
    private static func keyWindow() -> UIWindow? {
        var found: UIWindow?
        for scene in UIApplication.shared.connectedScenes {
            guard let windowScene = scene as? UIWindowScene else { continue }
            for window in windowScene.windows {
                if window.isKeyWindow { return window }
                if found == nil { found = window }
            }
        }
        return found
    }

    /// 幂等标志。仅从 `@MainActor` 上下文访问（warmup/keyWindow 均为 @MainActor）。
    @MainActor private static var hasWarmedUp = false
}

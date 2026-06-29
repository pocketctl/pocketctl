import SwiftUI

/// 自定义「左缘右滑返回」手势判定，转场动画交由 `NavigationStack` 原生 pop 执行。
///
/// 背景问题：本项目所有页面都用自定义导航栏并隐藏系统导航栏（`.navigationBarHidden(true)`），
/// 导致系统边缘滑动手势失效。`SwipeBackModifier` 的做法是重新打开系统的
/// `interactivePopGestureRecognizer`，但它是 `UIScreenEdgePanGestureRecognizer`，
/// 触发区域只在屏幕最左缘约 20–30pt 的窄条，且会与本页内的 `ScrollView` 垂直滚动、
/// `SwipeToDelete` 的左滑删除手势互相争抢事件所有权，表现为「多次滑动无反应」。
///
/// 为什么不做跟手位移：
/// 纯 SwiftUI 在 `NavigationStack` 内无法同时驱动「当前页移出」和「上一页露出」两层。
/// 用 `.offset` 平移当前页会露出背景色/阴影，表现为「重影」。因此本修饰符只负责
/// 手势判定——当用户从左缘起手向右滑、位移或速度达到阈值时，直接 `dismiss()`，
/// 由系统执行原生 pop 动画（上一页会正确跟随滑入，无重影）。
///
/// 关键实现要点：
/// 1. 直接把 `.gesture()` 挂在含 `ScrollView` 的视图上会被 ScrollView 的 pan 完全吞掉。
///    这里用一个「左缘窄条透明 overlay」承载手势，窄条只覆盖屏幕左缘 `edgeWidth`，
///    不影响 ScrollView 的滚动和卡片的点击/左滑删除。
/// 2. 起手点天然在窄条内（overlay 只占左缘），方向向右才激活。
/// 3. 与 `SwipeToDelete` 协调：卡片左滑删除通常起手于屏幕中右部、且方向向左，
///    与本手势（左缘起手、向右）方向相反，互不冲突。
private struct SwipeToPopModifier: ViewModifier {
    /// 触发返回手势的最大起手 X 坐标（距屏幕左缘）。从该范围内起手并向右拖才识别。
    static var edgeWidth: CGFloat { 50 }
    /// 手势识别前的最小拖拽距离，避免误触。
    private let minimumDistance: CGFloat = 12
    /// 释放判定：横向位移达到屏幕宽度的此比例即视为返回。
    private let popRatio: CGFloat = 0.3
    /// 释放判定：预测终点速度超过此值（pt）即视为返回，对应「快速甩一下」的手感。
    private let popVelocity: CGFloat = 600

    @Environment(\.dismiss) private var dismiss

    /// 本次拖拽是否为有效的「向右」手势。方向不对则忽略，事件放行给下层。
    @State private var isActive = false

    func body(content: Content) -> some View {
        let screenWidth = UIScreen.main.bounds.width

        return content
            // 不做 offset 平移——避免露出背景产生重影。转场交给系统原生 pop。
            .overlay(alignment: .leading) {
                Color.clear
                    .frame(width: SwipeToPopModifier.edgeWidth)
                    .contentShape(Rectangle())
                    .gesture(
                        DragGesture(minimumDistance: minimumDistance)
                            .onChanged { value in
                                if !isActive {
                                    if value.translation.width > 0 { isActive = true }
                                }
                            }
                            .onEnded { value in
                                guard isActive else { return }
                                isActive = false

                                let distance = value.translation.width
                                let velocity = value.predictedEndLocation.x - value.location.x
                                if distance > screenWidth * popRatio || velocity > popVelocity {
                                    dismiss()
                                }
                            }
                    )
            }
    }
}

extension View {
    /// 启用「左缘右滑返回」手势：从屏幕左缘起手向右拖（位移 >30% 屏宽或快速甩动）
    /// 即可返回上一屏。转场动画使用系统原生 pop，无重影。
    ///
    /// 仅应作用于「被 push 的」非根页面，根页面（导航栈第一屏）不应使用。
    func swipeToPop() -> some View { modifier(SwipeToPopModifier()) }
}

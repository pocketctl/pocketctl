import SwiftUI

struct SplashView: View {
    /// 动画起始锚点，保证每次启动都从「光带在左端浮现」开始。
    @State private var startTime: Date?

    var body: some View {
        ZStack {
            Color.pcBackground.ignoresSafeArea()

            VStack(spacing: 12) {
                // Logo
                Image(systemName: "terminal.fill")
                    .font(.system(size: 44))
                    .foregroundStyle(Color.pcAccent)

                // Wordmark
                Text("pocketctl")
                    .font(PCFont.display(32, weight: .bold))
                    .foregroundStyle(Color.pcAccent)
                    .kerning(-0.5)

                // Tagline
                Text("Your coding agents, in your pocket.")
                    .font(PCFont.body(15))
                    .foregroundStyle(Color.pcFgSecondary)
            }

            // Progress bar at bottom
            VStack {
                Spacer()
                splashProgress
                    .padding(.bottom, 80)
            }
        }
        .onAppear { startTime = Date() }
    }

    /// 底部不确定进度条。
    ///
    /// 复刻 `ui-design/screens/splash.html` 的 `splash-progress` 关键帧：一道光带从左端
    /// 出现，边右移边变宽（中段最宽，约轨道的 60%），再边右移边收缩，在右端消失；
    /// 2s 一周期、ease-in-out、无限循环。两端宽度均为 0，故循环跳回时不可见。
    ///
    /// 用 `TimelineView(.animation)` 逐帧确定性地计算光带的宽度与偏移，而非依赖
    /// `PhaseAnimator`——后者在循环边界对宽度/偏移两个属性的插值可能不同步，导致
    /// 第二轮起光带在裁剪边界处溢出。此处循环回零时宽度恒为 0，从数学上杜绝溢出。
    private var splashProgress: some View {
        TimelineView(.animation) { timeline in
            let geom = bandGeometry(at: timeline.date)
            ZStack(alignment: .leading) {
                // 轨道
                RoundedRectangle(cornerRadius: 2)
                    .fill(Color.pcBorder)
                    .frame(width: 120, height: 3)
                // 扫光
                RoundedRectangle(cornerRadius: 2)
                    .fill(Color.pcAccent)
                    .frame(width: geom.width, height: 3)
                    .offset(x: geom.offset)
            }
            .frame(width: 120, height: 3, alignment: .leading)
            .clipShape(RoundedRectangle(cornerRadius: 2, style: .continuous))
        }
    }

    /// 由时间相位计算光带的宽度与左偏移，对应 `splash-progress` 的 0% / 50% / 100%。
    ///
    /// 周期内分两段，各 1s、各走一次 ease-in-out：
    /// - 前半段 [0, 0.5)：宽度 0→72，偏移 0→60，光带在左端浮现并向右胀开；
    /// - 后半段 [0.5, 1)：宽度 72→0，偏移 60→120，光带向右收缩并在右端消失。
    private func bandGeometry(at now: Date) -> (width: CGFloat, offset: CGFloat) {
        let cycle = 2.0 // 秒，对应 `splash-progress 2s ... infinite`
        let elapsed = startTime.map { now.timeIntervalSince($0) } ?? 0
        let p = elapsed.truncatingRemainder(dividingBy: cycle) / cycle // 相位 0..<1

        // 段内局部进度 0..<1
        let half = p < 0.5 ? p / 0.5 : (p - 0.5) / 0.5
        let eased = Self.easeInOut(half)

        if p < 0.5 {
            return (CGFloat(eased * 72), CGFloat(eased * 60))
        } else {
            return (CGFloat((1 - eased) * 72), CGFloat(60 + eased * 60))
        }
    }

    /// 二次 ease-in-out，近似 CSS `cubic-bezier(0.42, 0, 0.58, 1)`。
    private static func easeInOut(_ t: Double) -> Double {
        t < 0.5 ? 2 * t * t : 1 - pow(-2 * t + 2, 2) / 2
    }
}

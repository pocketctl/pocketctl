import SwiftUI

struct SplashView: View {
    /// 轨道宽度（pt）。
    private let trackWidth: CGFloat = 120
    /// 光带峰值宽度，约为轨道的 60%，对应 HTML 的 `width: 60%`。
    private let bandPeak: CGFloat = 72

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
    }

    /// 底部不确定进度条。
    ///
    /// 复刻 `ui-design/screens/splash.html` 的 `splash-progress` 关键帧：一道光带从左端
    /// 出现，边右移边变宽（中段最宽），再边右移边收缩，在右端消失；2s 一周期、
    /// ease-in-out、无限循环。两端宽度均为 0，故循环跳回时不可见。
    ///
    /// 关键：光带几何被数学 clamp 到 [0, trackWidth] 内，绘制坐标永远不超出轨道边界，
    /// 不依赖任何裁剪机制（`.frame()` 不裁剪内容、Canvas 也不自动裁剪，因此裁剪兜底
    /// 在本工程会失效导致溢出）。`.clipped()` 仅作额外保险。
    private var splashProgress: some View {
        TimelineView(.animation) { timeline in
            Canvas { context, size in
                let cornerRadius: CGFloat = 2
                let height = size.height

                // 轨道
                let trackRect = CGRect(x: 0, y: 0, width: size.width, height: height)
                context.fill(
                    Path(roundedRect: trackRect, cornerRadius: cornerRadius),
                    with: .color(Color.pcBorder)
                )

                // 扫光（几何已 clamp，必然落在轨道内）
                let (width, offset) = bandGeometry(at: timeline.date)
                guard width > 0 else { return }
                let bandRect = CGRect(x: offset, y: 0, width: width, height: height)
                context.fill(
                    Path(roundedRect: bandRect, cornerRadius: cornerRadius),
                    with: .color(Color.pcAccent)
                )
            }
            .frame(width: trackWidth, height: 3)
            .clipped()
        }
    }

    /// 由时间相位计算光带的宽度与左偏移，对应 `splash-progress` 的 0% / 50% / 100%。
    ///
    /// 先按关键帧算出"逻辑"宽度/偏移，再 clamp 到轨道边界内：光带左沿恒 ≥ 0，
    /// 右沿恒 ≤ trackWidth。等效于 HTML 容器 `overflow:hidden` 的裁剪效果，但由
    /// 几何保证而非依赖渲染裁剪。
    private func bandGeometry(at now: Date) -> (width: CGFloat, offset: CGFloat) {
        let cycle = 2.0 // 秒，对应 `splash-progress 2s ... infinite`
        let p = now.timeIntervalSinceReferenceDate
            .truncatingRemainder(dividingBy: cycle) / cycle // 相位 0..<1

        // 段内局部进度 0..<1
        let half = p < 0.5 ? p / 0.5 : (p - 0.5) / 0.5
        let eased = Self.easeInOut(half)

        // 逻辑几何（可能越出轨道）
        let logicWidth: CGFloat
        let logicOffset: CGFloat
        if p < 0.5 {
            logicWidth = CGFloat(eased * Double(bandPeak))      // 0 → 72
            logicOffset = CGFloat(eased * 60)                   // 0 → 60
        } else {
            logicWidth = CGFloat((1 - eased) * Double(bandPeak)) // 72 → 0
            logicOffset = CGFloat(60 + eased * 60)              // 60 → 120
        }

        // Clamp 到轨道边界 [0, trackWidth]，从数学上杜绝溢出
        let left = max(0, logicOffset)
        let right = min(trackWidth, logicOffset + logicWidth)
        return (max(0, right - left), left)
    }

    /// 二次 ease-in-out，近似 CSS `cubic-bezier(0.42, 0, 0.58, 1)`。
    private static func easeInOut(_ t: Double) -> Double {
        t < 0.5 ? 2 * t * t : 1 - pow(-2 * t + 2, 2) / 2
    }
}

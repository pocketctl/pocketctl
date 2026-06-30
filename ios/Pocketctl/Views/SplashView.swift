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
    /// 关键：光带几何由构造保证恒落在 [0, trackWidth] 内（见 `bandGeometry`），
    /// 不会出现需要 clamp 才能压回边界的"越界 → 在边缘堆叠/被裁断"的视觉，
    /// 因此每个周期都干净一致。`.clipped()` 仅作额外保险。
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

                // 扫光（几何由构造保证，必然落在轨道内）
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

    /// 由时间相位计算光带的宽度与左偏移。
    ///
    /// 用单一相位 `q∈[0,1)` 同时驱动「宽度呼吸」与「左→右平移」，让二者天然同步：
    ///   - 宽度 `w = bandPeak · sin(π·q)`：q=0 与 q=1 处宽度为 0（两端不可见），
    ///     q=0.5 处达到峰值 `bandPeak`，构成"呼吸"。
    ///   - 左沿 `left = (trackWidth − w) · q`：把"剩余可用轨道"按进度线性分配到左侧。
    ///
    /// 由此右沿 `left + w = trackWidth·q + w·(1−q)`，在 q∈[0,1] 上恒满足
    /// `0 ≤ left` 且 `left + w ≤ trackWidth`（因 `bandPeak ≤ trackWidth`）。
    /// 即光带由构造保证完全落在轨道内，无需任何 clamp/裁剪，故不会在左右两侧
    /// 溢出或堆叠，每个周期表现一致。
    private func bandGeometry(at now: Date) -> (width: CGFloat, offset: CGFloat) {
        let cycle = 2.0 // 秒，对应 `splash-progress 2s ... infinite`
        let raw = now.timeIntervalSinceReferenceDate
            .truncatingRemainder(dividingBy: cycle) / cycle // 相位 0..<1
        let q = Self.easeInOut(raw) // ease-in-out，起止平滑

        let w = CGFloat(Double(bandPeak) * sin(.pi * q))
        let left = (trackWidth - w) * CGFloat(q)
        return (max(0, w), left)
    }

    /// 二次 ease-in-out，近似 CSS `cubic-bezier(0.42, 0, 0.58, 1)`。
    private static func easeInOut(_ t: Double) -> Double {
        t < 0.5 ? 2 * t * t : 1 - pow(-2 * t + 2, 2) / 2
    }
}

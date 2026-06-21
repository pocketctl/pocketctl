import SwiftUI

/// Token usage analytics page (restores `token-usage.html`): 2×2 overview,
/// token breakdown, 30-day input/output bar chart, model distribution donut,
/// and per-session consumption. Supports global (no daemonId) and single-host
/// entry points via standard navigation push (system-provided back button).
struct TokenUsageView: View {
    let daemonId: String?
    let apiClient: APIClient

    @State private var viewModel: TokenUsageViewModel?

    private let palette: [Color] = [.pcAccent, .pcSuccess, .pcWarning, .pcSubAgent, .pcWaiting, .pcError]

    var body: some View {
        ZStack {
            Color.pcBackground.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: PCSpacing.lg) {
                    if let vm = viewModel {
                        if vm.dashboard == nil && vm.isLoading {
                            ProgressView().frame(maxWidth: .infinity, minHeight: 200)
                        } else if vm.dashboard != nil {
                            overviewGrid(vm)
                            breakdownCard(vm)
                            barChartCard(vm)
                            donutCard(vm)
                            sessionsSection(vm)
                        } else if let err = vm.loadError {
                            Text(err).foregroundStyle(Color.pcError).padding()
                        }
                    }
                }
                .padding(.horizontal, PCSpacing.lg)
                .padding(.top, PCSpacing.md)
                .padding(.bottom, PCSpacing.xxxxl)
            }
        }
        .navigationTitle("用量分析")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            if viewModel == nil {
                let vm = TokenUsageViewModel(daemonId: daemonId, apiClient: apiClient)
                viewModel = vm
                await vm.load()
            }
        }
    }

    // MARK: - 2×2 overview

    private func overviewGrid(_ vm: TokenUsageViewModel) -> some View {
        LazyVGrid(columns: [GridItem(.flexible(), spacing: PCSpacing.sm), GridItem(.flexible(), spacing: PCSpacing.sm)], spacing: PCSpacing.sm) {
            summaryCard(label: "总消耗", value: formatTokens(vm.total), valueColor: .pcAccent)
            summaryCard(label: "今日消耗", value: formatTokens(vm.today), trend: vm.todayTrendPct)
            summaryCard(label: "近 7 天", value: formatTokens(vm.thisWeek))
            summaryCard(label: "近 30 天", value: formatTokens(vm.thisMonth))
        }
    }

    private func summaryCard(label: String, value: String, valueColor: Color = .pcFg, trend: Double? = nil) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(PCFont.body(11))
                .foregroundStyle(Color.pcFgTertiary)
            Text(value)
                .font(PCFont.display(22, weight: .bold))
                .foregroundStyle(valueColor)
            if let trend = trend {
                HStack(spacing: 2) {
                    Text(trend >= 0 ? "↑" : "↓")
                    Text(String(format: "%.1f%%", abs(trend)) + " 较昨日")
                }
                .font(PCFont.body(11))
                .foregroundStyle(trend >= 0 ? Color.pcSuccess : Color.pcError)
            } else if label == "今日消耗" {
                Text("—").font(PCFont.body(11)).foregroundStyle(Color.pcFgTertiary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(Color.pcSurface)
        .overlay(RoundedRectangle(cornerRadius: PCRadius.lg).stroke(Color.pcBorder, lineWidth: 1))
        .cornerRadius(PCRadius.lg)
    }

    // MARK: - Breakdown

    private func breakdownCard(_ vm: TokenUsageViewModel) -> some View {
        VStack(spacing: 0) {
            sectionTitle("Token 细分").padding(.horizontal, 16).padding(.top, 14).padding(.bottom, 4)
            metricRow(label: "输入量", value: formatTokens(vm.sumInput), sub: "含 \(formatTokens(vm.sumCache)) cache")
            metricRow(label: "输出量", value: formatTokens(vm.sumOutput), sub: "平均 \(formatTokens(vm.avgPerRequest))/请求")
            metricRow(label: "Cache 命中", value: formatTokens(vm.sumCache), sub: String(format: "命中率 %.0f%%", vm.cacheHitRate))
            metricRow(label: "请求次数", value: formatTokens(vm.sumRequests), sub: nil, last: !(vm.topModel != nil))
            if let top = vm.topModel {
                metricRow(label: "最常用模型", value: top.model, sub: String(format: "%.0f%%", top.pct), valueMono: false, last: true)
            }
        }
        .background(Color.pcSurface)
        .overlay(RoundedRectangle(cornerRadius: PCRadius.lg).stroke(Color.pcBorder, lineWidth: 1))
        .cornerRadius(PCRadius.lg)
    }

    private func metricRow(label: String, value: String, sub: String?, valueMono: Bool = true, last: Bool = false) -> some View {
        HStack {
            Text(label).font(PCFont.body(15)).foregroundStyle(Color.pcFg)
            Spacer()
            Text(value)
                .font(valueMono ? PCFont.mono(15, weight: .semibold) : PCFont.body(15, weight: .semibold))
                .foregroundStyle(Color.pcFg)
            if let sub {
                Text(sub).font(PCFont.body(12)).foregroundStyle(Color.pcFgTertiary)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .overlay(last ? nil : Rectangle().fill(Color.pcBorder).frame(height: 0.5).padding(.leading, 16), alignment: .bottom)
    }

    // MARK: - Bar chart

    private func barChartCard(_ vm: TokenUsageViewModel) -> some View {
        VStack(alignment: .leading, spacing: PCSpacing.sm) {
            HStack {
                sectionTitle("每日消耗（30 天）")
                Spacer()
                HStack(spacing: 10) {
                    legendDot(.pcAccent); Text("输入").font(PCFont.body(11)).foregroundStyle(Color.pcFgTertiary)
                    legendDot(.pcSuccess); Text("输出").font(PCFont.body(11)).foregroundStyle(Color.pcFgTertiary)
                }
            }
            if vm.dailySeries.isEmpty {
                Text("暂无数据").font(PCFont.body(13)).foregroundStyle(Color.pcFgTertiary).frame(maxWidth: .infinity, alignment: .center).padding(.vertical, 40)
            } else {
                TokenBarChart(series: vm.dailySeries).frame(height: 120)
            }
        }
        .padding(16)
        .background(Color.pcSurface)
        .overlay(RoundedRectangle(cornerRadius: PCRadius.lg).stroke(Color.pcBorder, lineWidth: 1))
        .cornerRadius(PCRadius.lg)
    }

    // MARK: - Donut

    private func donutCard(_ vm: TokenUsageViewModel) -> some View {
        VStack(alignment: .leading, spacing: PCSpacing.sm) {
            sectionTitle("模型分布")
            HStack(spacing: 16) {
                TokenDonutChart(total: vm.total, slices: vm.byModel.map { (paletteColor($0.model), $0.pct) })
                    .frame(width: 90, height: 90)
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(Array(vm.byModel.prefix(5).enumerated()), id: \.offset) { _, m in
                        HStack(spacing: 8) {
                            RoundedRectangle(cornerRadius: 2).fill(paletteColor(m.model)).frame(width: 10, height: 10)
                            Text(m.model.isEmpty ? "unknown" : m.model)
                                .font(PCFont.body(14)).foregroundStyle(Color.pcFgSecondary)
                            Spacer()
                            Text(String(format: "%.0f%%", m.pct))
                                .font(PCFont.body(14, weight: .semibold)).foregroundStyle(Color.pcFg)
                        }
                    }
                }
            }
        }
        .padding(16)
        .background(Color.pcSurface)
        .overlay(RoundedRectangle(cornerRadius: PCRadius.lg).stroke(Color.pcBorder, lineWidth: 1))
        .cornerRadius(PCRadius.lg)
    }

    private func paletteColor(_ model: String) -> Color {
        guard let vm = viewModel, let idx = vm.byModel.firstIndex(where: { $0.model == model }) else { return .pcFgTertiary }
        return palette[idx % palette.count]
    }

    // MARK: - Sessions

    private func sessionsSection(_ vm: TokenUsageViewModel) -> some View {
        VStack(alignment: .leading, spacing: PCSpacing.xs) {
            sectionTitle("会话消耗明细")
            if vm.sessions.isEmpty {
                Text("暂无会话").font(PCFont.body(13)).foregroundStyle(Color.pcFgTertiary).padding(.vertical, 20)
            } else {
                LazyVStack(spacing: PCSpacing.xs) {
                    ForEach(Array(vm.displayedSessions.enumerated()), id: \.offset) { idx, s in
                        HStack(spacing: 10) {
                            Circle().fill(sessionDotColor(s.status)).frame(width: 7, height: 7)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(s.title.isEmpty ? String(s.sessionId.prefix(8)) : s.title)
                                    .font(PCFont.body(14, weight: .medium))
                                    .foregroundStyle(Color.pcFg)
                                    .lineLimit(1)
                                Text("\(s.model.isEmpty ? "unknown" : s.model) · \(sessionStatusLabel(s.status))")
                                    .font(PCFont.body(11)).foregroundStyle(Color.pcFgTertiary)
                            }
                            Spacer()
                            Text(formatTokens(s.totalTokens))
                                .font(PCFont.mono(14, weight: .semibold)).foregroundStyle(Color.pcFg)
                        }
                        .padding(12)
                        .background(Color.pcSurface)
                        .overlay(RoundedRectangle(cornerRadius: PCRadius.md).stroke(Color.pcBorder, lineWidth: 1))
                        .cornerRadius(PCRadius.md)
                        .onAppear {
                            if idx == vm.displayedSessions.count - 1 {
                                vm.loadMoreSessions()
                            }
                        }
                    }
                }
            }
        }
    }

    private func sessionDotColor(_ status: String) -> Color {
        ["exited", "completed", "error", "killed"].contains(status) ? .pcAccent : .pcSuccess
    }
    private func sessionStatusLabel(_ status: String) -> String {
        switch status {
        case "running", "busy": return "运行中"
        case "exited", "completed": return "已完成"
        case "error", "killed": return "已停止"
        default: return status
        }
    }

    private func sectionTitle(_ s: String) -> some View {
        Text(s)
            .font(PCFont.body(13, weight: .semibold))
            .foregroundStyle(Color.pcFgSecondary)
    }
    private func legendDot(_ c: Color) -> some View {
        RoundedRectangle(cornerRadius: 2).fill(c.opacity(0.7)).frame(width: 7, height: 7)
    }
}

// MARK: - Bar chart (input/output stacked, bottom-aligned)

struct TokenBarChart: View {
    let series: [TokenDailyPoint]

    var body: some View {
        GeometryReader { geo in
            let maxVal = max(series.map { $0.input + $0.output }.max() ?? 1, 1)
            HStack(alignment: .bottom, spacing: 2) {
                ForEach(series.indices, id: \.self) { i in
                    let p = series[i]
                    VStack(spacing: 1) {
                        Rectangle()
                            .fill(Color.pcSuccess.opacity(0.7))
                            .frame(height: max(1, geo.size.height * CGFloat(p.output) / CGFloat(maxVal)))
                        Rectangle()
                            .fill(Color.pcAccent.opacity(0.7))
                            .frame(height: max(1, geo.size.height * CGFloat(p.input) / CGFloat(maxVal)))
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
                }
            }
        }
    }
}

// MARK: - Donut chart (conic via Canvas)

struct TokenDonutChart: View {
    let total: Int
    let slices: [(color: Color, pct: Double)]

    var body: some View {
        Canvas { context, size in
            let center = CGPoint(x: size.width / 2, y: size.height / 2)
            let radius = min(size.width, size.height) / 2
            var start = Angle.degrees(-90)
            let tot = slices.reduce(0.0) { $0 + $1.pct }
            let norm = tot > 0 ? 100.0 / tot : 1.0
            for s in slices {
                let sweep = Angle.degrees(360 * s.pct * norm / 100)
                let path = Path { p in
                    p.move(to: center)
                    p.addArc(center: center, radius: radius, startAngle: start, endAngle: start + sweep, clockwise: false)
                }
                context.fill(path, with: .color(s.color))
                start += sweep
            }
        }
        .overlay {
            Circle().fill(Color.pcSurface).frame(width: 56, height: 56)
            VStack(spacing: 0) {
                Text(formatTokens(total))
                    .font(PCFont.body(14, weight: .bold)).foregroundStyle(Color.pcFg)
                Text("总量")
                    .font(PCFont.body(8)).foregroundStyle(Color.pcFgTertiary)
            }
        }
    }
}

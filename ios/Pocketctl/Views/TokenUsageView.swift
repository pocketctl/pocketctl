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
                            heatmapCard(vm)
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

    // MARK: - Heatmap（消耗热力图，近 9 个月；对齐 web `TokenUsage.vue`）

    private func heatmapCard(_ vm: TokenUsageViewModel) -> some View {
        VStack(alignment: .leading, spacing: PCSpacing.sm) {
            HStack {
                sectionTitle("消耗热力图（近 5 个月）")
                Spacer()
                // 图例条：少 ▢▢▣▣■ 多（5 级，对齐 web `.heatmap-legend-bar`）
                HStack(spacing: 4) {
                    Text("少").font(PCFont.body(10)).foregroundStyle(Color.pcFgTertiary)
                    ForEach(0..<5, id: \.self) { lv in
                        RoundedRectangle(cornerRadius: 2)
                            .fill(TokenHeatmap.color(level: lv))
                            .frame(width: 10, height: 10)
                    }
                    Text("多").font(PCFont.body(10)).foregroundStyle(Color.pcFgTertiary)
                }
            }
            if vm.heatmapSeries.isEmpty {
                Text("暂无数据")
                    .font(PCFont.body(13))
                    .foregroundStyle(Color.pcFgTertiary)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding(.vertical, 40)
            } else {
                TokenHeatmap(series: vm.heatmapSeries, maxVal: vm.heatmapMax)
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

// MARK: - Heatmap（GitHub 风格消耗热力图，对齐 web `TokenUsage.vue` 的 heatmapCols/heatLevel）

/// GitHub 风格日历对齐消耗热力图。列数（周数）/cell 尺寸/滚动/交互均可配置。
/// 默认 22 周、cell 13pt、横向滚动默认靠右、可点击 tooltip（用量页）；
/// 签名卡传 scrollable=false：方格按容器宽度等分 + aspectRatio(1) 自适应填满，cellSize 此时无效。
/// 5 级强度：level 0 = 无数据（中性灰），1–4 = `pcAccent` 透明度 0.22/0.42/0.66/0.92。
struct TokenHeatmap: View {
    let series: [TokenDailyPoint]
    let maxVal: Int
    let weeks: Int
    let cellSize: CGFloat
    let cellGap: CGFloat
    let interactive: Bool
    let scrollable: Bool

    @State private var selected: TokenHeatmapCell?

    /// - Parameters:
    ///   - weeks: 列数（周数）。默认 22（≈近 5 个月）。
    ///   - cellSize/cellGap: 单元格尺寸与间隙。默认 13/3（对齐 web 12px/gap 3px，略放大适合手指点击）。
    ///   - interactive: 是否启用点击 tooltip。默认 true（用量页）。签名卡传 false。
    ///   - scrollable: 是否横向滚动。默认 true（用量页）。签名卡传 false（cell 缩小后 22 周可铺满屏宽）。
    init(series: [TokenDailyPoint],
         maxVal: Int,
         weeks: Int = 22,
         cellSize: CGFloat = 13,
         cellGap: CGFloat = 3,
         interactive: Bool = true,
         scrollable: Bool = true) {
        self.series = series
        self.maxVal = maxVal
        self.weeks = weeks
        self.cellSize = cellSize
        self.cellGap = cellGap
        self.interactive = interactive
        self.scrollable = scrollable
    }

    /// 预计算网格：与 web `heatmapCols` 完全同构。使用本地时区格式化日期，
    /// 不走 UTC（web 曾因此导致单元格查表失败，见 TokenUsage.vue:304-314 注释）。
    private var columns: [TokenHeatmapColumn] {
        let cal = Calendar(identifier: .gregorian)
        let map = Dictionary(uniqueKeysWithValues: series.map { (normDate($0.date), $0) })
        let today = cal.startOfDay(for: Date())
        // weekday: 1=Sunday ... 7=Saturday（与 web getFullYear/getDay 的 0=Sunday 对齐）
        let todayDow = cal.component(.weekday, from: today)
        let thisSunday = cal.date(byAdding: .day, value: -(todayDow - 1), to: today)!

        var cols: [TokenHeatmapColumn] = []
        for w in stride(from: weeks - 1, through: 0, by: -1) {
            var cells: [TokenHeatmapCell] = []
            for dow in 0..<7 {
                let dt = cal.date(byAdding: .day, value: -w * 7 + dow, to: thisSunday)!
                let future = dt > today
                let ds = fmtLocalDate(dt)
                let day = future ? nil : map[ds]
                let value = day.map { $0.input + $0.output } ?? 0
                let level = day != nil ? heatLevel(value) : 0
                cells.append(TokenHeatmapCell(
                    key: "w\(w)-d\(dow)",
                    date: day != nil ? ds : "",
                    value: value,
                    level: level,
                    hasData: day != nil,
                    month: cal.component(.month, from: dt)
                ))
            }
            cols.append(TokenHeatmapColumn(id: w, cells: cells))
        }
        return cols
    }

    /// web `heatLevel`: p=value/max; >0.75→4, >0.5→3, >0.25→2, >0→1, else 0
    private func heatLevel(_ v: Int) -> Int {
        let p = Double(v) / Double(maxVal)
        if p > 0.75 { return 4 }
        if p > 0.5 { return 3 }
        if p > 0.25 { return 2 }
        if v > 0 { return 1 }
        return 0
    }

    /// 稳定的 "YYYY-MM-DD"（取前 10 字符），兼容后端可能返回的 ISO 时间戳。
    private func normDate(_ s: String) -> String { String(s.prefix(10)) }

    /// 本地时区日期格式化（与 web `fmtLocalDate` 一致，避免 UTC 偏移导致查表失败）。
    private func fmtLocalDate(_ d: Date) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = .current
        f.dateFormat = "yyyy-MM-dd"
        return f.string(from: d)
    }

    /// 5 级配色（level 0 = 无数据中性灰；1–4 = accent 渐增透明度）。
    static func color(level: Int) -> Color {
        switch level {
        case 0: return Color.pcHoverInput
        case 1: return Color.pcAccent.opacity(0.22)
        case 2: return Color.pcAccent.opacity(0.42)
        case 3: return Color.pcAccent.opacity(0.66)
        default: return Color.pcAccent.opacity(0.92)
        }
    }

    var body: some View {
        let cols = columns
        return VStack(alignment: .leading, spacing: PCSpacing.xs) {
            // 选中日的浮层提示（仅 interactive）
            if interactive, let sel = selected, !sel.date.isEmpty {
                HStack(spacing: 6) {
                    Text(sel.date).font(PCFont.mono(12, weight: .semibold)).foregroundStyle(Color.pcFg)
                    Text("·").foregroundStyle(Color.pcFgTertiary)
                    Text(formatTokens(sel.value)).font(PCFont.mono(12, weight: .semibold)).foregroundStyle(Color.pcAccent)
                    Text("tokens").font(PCFont.body(10)).foregroundStyle(Color.pcFgTertiary)
                }
                .padding(.horizontal, 10).padding(.vertical, 5)
                .background(Color.pcHoverInput)
                .overlay(RoundedRectangle(cornerRadius: PCRadius.sm).stroke(Color.pcBorderLight, lineWidth: 1))
                .cornerRadius(PCRadius.sm)
            }
            grid(cols)
        }
    }

    /// 网格：scrollable 时横向滚动并默认靠右；否则直接铺排（签名卡）。
    @ViewBuilder
    private func grid(_ cols: [TokenHeatmapColumn]) -> some View {
        if scrollable {
            ScrollViewReader { proxy in
                ScrollView(.horizontal, showsIndicators: false) {
                    heatmapRow(cols)
                        .padding(.trailing, 2)
                }
                .onAppear {
                    // 定位到最右侧一列（最近一周 = id 0）；延迟一帧确保布局完成
                    DispatchQueue.main.async {
                        withAnimation(nil) { proxy.scrollTo(0, anchor: .trailing) }
                    }
                }
            }
        } else {
            heatmapRow(cols)
        }
    }

    private func heatmapRow(_ cols: [TokenHeatmapColumn]) -> some View {
        HStack(alignment: .top, spacing: cellGap) {
            ForEach(cols) { col in
                heatmapColumn(col)
                    .id(col.id)
                    // 非滚动（签名卡）：每列等分容器宽度，配合方格 aspectRatio(1) 自适应填满，不依赖 cellSize；
                    // 滚动（用量页）：列宽由内部 cellSize 决定，固定不变才能横向滚动。
                    .frame(maxWidth: scrollable ? nil : .infinity, alignment: .topLeading)
            }
        }
    }

    /// 单列（一周）：顶部月份标签（仅该列周一所在月份首次出现时显示）+ 7 个 cell。
    private func heatmapColumn(_ col: TokenHeatmapColumn) -> some View {
        VStack(alignment: .leading, spacing: cellGap) {
            // 月份标签：取该列第一个 cell 的月份，简化为每列都标（与 web 行为接近）
            // 滚动模式固定 cellSize 宽；非滚动模式跟随列宽（已被 heatmapRow 设为 .infinity）
            Text(shortMonth(col.cells.first?.month ?? 0))
                .font(PCFont.body(9))
                .foregroundStyle(Color.pcFgTertiary)
                .frame(width: scrollable ? cellSize : nil, alignment: .leading)
            ForEach(col.cells) { cell in
                heatmapCell(cell)
            }
        }
    }

    @ViewBuilder
    private func heatmapCell(_ cell: TokenHeatmapCell) -> some View {
        // 滚动（用量页）：固定 cellSize；非滚动（签名卡）：等分列宽 + aspectRatio(1) 自适应为正方形，填满容器宽度。
        let shape = RoundedRectangle(cornerRadius: 2)
        let fill = shape
            .fill(TokenHeatmap.color(level: cell.level))
            .overlay(
                shape
                    .stroke(Color.pcAccent, lineWidth: 1)
                    .opacity(interactive && selected?.date == cell.date && cell.hasData ? 1 : 0)
            )
        let sized = scrollable
            ? AnyView(fill.frame(width: cellSize, height: cellSize))
            : AnyView(fill.frame(maxWidth: .infinity).aspectRatio(1, contentMode: .fit))
        if interactive {
            sized
                .contentShape(Rectangle())
                .onTapGesture {
                    guard cell.hasData else { return }
                    selected = (selected?.date == cell.date) ? nil : cell
                }
        } else {
            sized
        }
    }

    private func shortMonth(_ m: Int) -> String {
        let names = ["", "1月", "2月", "3月", "4月", "5月", "6月",
                     "7月", "8月", "9月", "10月", "11月", "12月"]
        return (1...12).contains(m) ? names[m] : ""
    }
}

private struct TokenHeatmapColumn: Identifiable {
    let id: Int               // 周序号（0 = 最近一周）
    let cells: [TokenHeatmapCell]
}

private struct TokenHeatmapCell: Identifiable {
    let key: String           // 稳定标识（"w{week}-d{dow}"），保证 ForEach 身份稳定
    let date: String          // "YYYY-MM-DD"，无数据时为 ""
    let value: Int            // input + output
    let level: Int            // 0–4
    let hasData: Bool
    let month: Int
    var id: String { key }
}

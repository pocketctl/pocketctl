import Foundation

/// View model for `TokenUsageView`. Drives the token dashboard.
///
/// `daemonId == nil` means the global view (all daemons); otherwise scoped to
/// one daemon. Session breakdown: single-daemon uses `by-daemon` sessions;
/// global merges each daemon's sessions (N requests, where N = host count).
@Observable
@MainActor
final class TokenUsageViewModel {
    let daemonId: String?
    private let apiClient: APIClient

    private(set) var dashboard: TokenDashboard?
    private(set) var daemonDetail: TokensByDaemon?
    private(set) var mergedSessions: [TokenSessionRow] = []
    private(set) var yesterdayTokens: Int?
    private(set) var isLoading = false
    private(set) var loadError: String?

    /// 热力图独立数据源（近 9 个月，≈270 天）。与 30 天 dashboard 解耦：
    /// 单独请求、单独容错，失败时静默（卡片显示「暂无数据」，不影响其他卡片）。
    private(set) var heatmapDashboard: TokenDashboard?

    private var scope: String { daemonId ?? "all" }
    var isGlobal: Bool { daemonId == nil }

    init(daemonId: String?, apiClient: APIClient) {
        self.daemonId = daemonId
        self.apiClient = apiClient
    }

    // MARK: - Overview (2×2)

    var total: Int { dashboard?.summary.total ?? 0 }
    var today: Int { dashboard?.summary.today ?? 0 }
    var thisWeek: Int { dashboard?.summary.thisWeek ?? 0 }
    var thisMonth: Int { dashboard?.summary.thisMonth ?? 0 }

    /// Today-vs-yesterday percentage; nil if yesterday unknown or zero.
    var todayTrendPct: Double? {
        guard let y = yesterdayTokens, y > 0 else { return nil }
        return (Double(today) - Double(y)) / Double(y) * 100
    }

    // MARK: - Breakdown (sum across byModel)

    var sumInput: Int { (dashboard?.byModel ?? []).reduce(0) { $0 + $1.input } }
    var sumOutput: Int { (dashboard?.byModel ?? []).reduce(0) { $0 + $1.output } }
    var sumCache: Int { (dashboard?.byModel ?? []).reduce(0) { $0 + $1.cacheRead } }
    var sumRequests: Int { (dashboard?.byModel ?? []).reduce(0) { $0 + $1.requests } }
    var cacheHitRate: Double { sumInput > 0 ? Double(sumCache) / Double(sumInput) * 100 : 0 }
    var avgPerRequest: Int { sumRequests > 0 ? sumOutput / sumRequests : 0 }
    var topModel: (model: String, pct: Double)? {
        guard let m = dashboard?.byModel.first, !m.model.isEmpty else { return nil }
        return (m.model, m.pct)
    }

    var dailySeries: [TokenDailyPoint] { dashboard?.dailySeries ?? [] }
    var byModel: [TokenModelRow] { dashboard?.byModel ?? [] }

    /// 热力图数据（近 5 个月）。独立于 30 天柱状图。
    var heatmapSeries: [TokenDailyPoint] { heatmapDashboard?.dailySeries ?? [] }
    /// 全局最大单日 (input+output)，作为 5 级热力分级的基准。
    var heatmapMax: Int {
        max(1, heatmapSeries.map { $0.input + $0.output }.max() ?? 1)
    }

    var sessions: [TokenSessionRow] {
        if isGlobal { return mergedSessions }
        return (daemonDetail?.sessions ?? []).sorted { $0.totalTokens > $1.totalTokens }
    }

    // MARK: - Session pagination (lazy-load 10 at a time)

    private(set) var displayedSessionCount = 10

    var displayedSessions: [TokenSessionRow] {
        Array(sessions.prefix(displayedSessionCount))
    }

    var hasMoreSessions: Bool {
        displayedSessionCount < sessions.count
    }

    func loadMoreSessions() {
        guard hasMoreSessions else { return }
        displayedSessionCount += 10
    }

    func load() async {
        isLoading = true
        loadError = nil
        do {
            dashboard = try await apiClient.getTokenDashboard(daemon: scope, days: 30)
            await fetchYesterday()
            if isGlobal {
                await fetchGlobalSessions()
            } else if let id = daemonId {
                daemonDetail = try? await apiClient.getTokensByDaemon(daemonId: id)
            }
        } catch {
            loadError = error.localizedDescription
        }
        isLoading = false
        // 热力图独立加载：不阻塞主流程，失败静默。
        await fetchHeatmap()
    }

    /// 热力图数据（近 5 个月，≈150 天）。独立窗口，对齐 web 端单独请求的思路。
    private func fetchHeatmap() async {
        heatmapDashboard = try? await apiClient.getTokenDashboard(daemon: scope, days: 150)
    }

    /// Yesterday total via a 2-day dashboard (series tail = today, prior = yesterday).
    private func fetchYesterday() async {
        guard let two = try? await apiClient.getTokenDashboard(daemon: scope, days: 2) else { return }
        let pts = two.dailySeries
        if pts.count >= 2 {
            let y = pts[pts.count - 2]
            yesterdayTokens = y.input + y.output + y.cacheRead
        } else if pts.count == 1 {
            yesterdayTokens = 0
        }
    }

    /// Global session breakdown: fetch each daemon's sessions, merge, sort desc.
    private func fetchGlobalSessions() async {
        var all: [TokenSessionRow] = []
        for d in dashboard?.byDaemon ?? [] {
            if let bd = try? await apiClient.getTokensByDaemon(daemonId: d.daemonId) {
                all.append(contentsOf: bd.sessions)
            }
        }
        mergedSessions = all.sorted { $0.totalTokens > $1.totalTokens }
    }
}

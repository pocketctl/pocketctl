# 设置页「消耗热力图迷你签名卡」设计

- 日期：2026-07-01
- 分支：develop
- 状态：待评审
- 动机：提升账户区的活跃感 / 仪式感，让用户打开设置就能看到自己的编码活动签名（类 GitHub Profile）。

## 背景

iOS 端「用量分析」页（`TokenUsageView`）已有一个完整的 GitHub 风格消耗热力图组件 `TokenHeatmap`（`ios/Pocketctl/Views/TokenUsageView.swift:340`）：22 周 × 7 天日历对齐网格、5 级配色、横向滚动默认靠右、点击 tooltip、月份标签，数据来自 `GET /api/tokens/dashboard?days=150`，经 `TokenUsageViewModel.fetchHeatmap()` 独立加载（失败静默）。

该组件目前只在二级页面展示。设置页（`SettingsView`）顶部是 `profileSection`（头像 + 昵称 + 编辑资料，`:440`），紧接「账户」分区。用户希望在账户区上方增加一个热力图，作为账户区的"活动签名"。

## 目标

- 在设置页 `profileSection` 之后、「账户」分区之前，插入一张紧凑、非交互的消耗热力图卡片。
- 复用现有 `TokenHeatmap` 的网格 / 分级 / 配色逻辑，不重复造轮子。
- 点击整卡跳转已有的全局用量分析页（`TokenUsageView(daemonId: nil)`）。
- 不拖慢设置页：数据异步、失败静默、不阻塞下方设置项。

## 非目标

- 不改「用量分析」页的现有完整热力图行为（仍是 22 周、横向滚动、可点击 tooltip）。
- 不引入按主机维度的迷你卡（设置页签名固定全局 `daemon: "all"`）。
- 不加货币 / 成本维度（消耗 = token 计数，与全项目语义一致）。
- 不加「少 ▢▢▣▣■ 多」图例（迷你卡空间紧，图例留在完整页）。

## 设计

### 1. 放置位置与形态

在 `SettingsView.body` 的 `ScrollView > VStack` 中，`profileSection`（`:28`）之后、「账户」`sectionHeader`（`:30`）之前，插入新的 `heatmapSignatureCard`。

布局示意（iPhone 14，屏宽 390pt）：

```
┌─────────────────────────────┐
│        (头像 72pt)            │  profileSection（不动）
│         昵称                  │
│       编辑资料                │
└─────────────────────────────┘
┌─────────────────────────────┐
│ 3月      4月      5月      │
│ ▢▢▣▢■▢▣ ▣■■▢▣▢■  …■▣■    │  22 周 × 7 天
│ ▢▢▢▣▢■▣ …                  │  cell 9pt, gap 3pt
│ …(共 7 行)…                  │  不滚动、不可点击格子
│ 近 5 个月 · 1.2M tokens   › │  caption + chevron
└─────────────────────────────┘
账户                          ← 原有，不变
   邮箱  …
```

**交互**：整张卡可点 → 复用已有的 `showGlobalUsage` 状态（`SettingsView.swift:9`）跳转 `TokenUsageView(daemonId: nil, apiClient: apiClient)`。卡内格子不单独交互（太挤），详情进完整页看。

**尺寸验证**：卡片内宽 ≈ 350pt（屏宽 390 − 左右 `PCSpacing.lg`(16)×2）。每列 = cell 9 + gap 3 = 12pt，22 周 = 264pt，**无需横向滚动**即可完整铺满近 5 个月，比用量页的 13pt 滚动版更省空间、更适合签名卡定位。

### 2. 组件复用策略：参数化 `TokenHeatmap`

现有 `TokenHeatmap` 写死 `weeks=22`、`cellSize=13`、`cellGap=3`、带横向滚动 + 点击 tooltip。网格计算（`columns`）、分级（`heatLevel`）、配色（`color(level:)`）全部可复用。

把这几个值提成 init 参数（带默认值 = 现状，保证用量页零改动）：

| 参数 | 类型 | 默认值（=现状） | 迷你卡传入 |
|---|---|---|---|
| `weeks` | `Int` | `22` | `22` |
| `cellSize` | `CGFloat` | `13` | `9` |
| `cellGap` | `CGFloat` | `3` | `3` |
| `interactive` | `Bool` | `true` | `false` |
| `scrollable` | `Bool` | `true` | `false` |

- 把 `private static let weeks = 22` 改为实例属性 `let weeks: Int`，由 init 注入。
- `interactive: false` 时：不渲染选中 tooltip 浮层、格子 `onTapGesture` 不挂载、不持有 `selected` 状态。
- `scrollable: false` 时：去掉外层 `ScrollView` / `ScrollViewReader`，直接渲染 `HStack`（此时因 cell 缩小、22 周已能铺满，不会溢出）。
- 用量页 `TokenUsageView.heatmapCard` 调用处保持默认参数，行为不变。

**为什么不新建 `MiniHeatmap`**：网格 / 分级 / 配色逻辑完全相同，参数化改动更小、更不容易发散。若未来两者差异变大（例如迷你卡要完全不同的渲染），再拆分。

### 3. 数据获取

`SettingsViewModel` 目前不碰 token 数据。按 `TokenUsageViewModel.fetchHeatmap()` 的成熟模式加一层，失败静默、不阻塞：

```swift
// SettingsViewModel.swift（新增）
private(set) var heatmapSeries: [TokenDailyPoint] = []
private(set) var heatmapLoading: Bool = false

/// 热力图全局最大单日 (input+output)，作为 5 级分级基准。无数据时返回 1 避免 除 0。
var heatmapMax: Int {
    max(1, heatmapSeries.map { $0.input + $0.output }.max() ?? 1)
}

/// 签名卡近 5 个月总消耗（input+output 求和）。
var heatmapTotal: Int {
    heatmapSeries.reduce(0) { $0 + $1.input + $1.output }
}

func loadHeatmap() async {
    heatmapLoading = true
    // 150 天，与用量页热力图窗口一致（22 周 ≈ 154 天），保证签名与完整页同源。
    heatmapSeries = (try? await apiClient.getTokenDashboard(daemon: "all", days: 150))?.dailySeries ?? []
    heatmapLoading = false
}
```

- 在 `SettingsView.onAppear`（或 `profileSection` 首次出现）里 `Task { await viewModel.loadHeatmap() }`，fire-and-forget。
- 150 天与用量页 `TokenUsageViewModel.fetchHeatmap()` 的 `days: 150` 一致，两处看到的"签名"与"完整版"是同一段数据。
- 失败 / 未到时：`heatmapSeries` 为空 → 卡片渲染占位（见视觉细节），不报错、不影响下方设置项。
- `SettingsViewModel` 已持有 `apiClient`（若没有则新增一个 `private let apiClient = APIClient()`，与 `SettingsView` 一致）。

### 4. 视觉细节

- **卡片样式**对齐其它设置分组：`Color.pcSurface` 背景、`PCRadius.lg`(16) 圆角、`Color.pcBorder` 描边、`padding(16)`；外层 `padding(.horizontal, PCSpacing.lg)` 与账户 / 服务器等分组对齐。
- **无显式标题**：它是"签名"而非"设置项"，网格自带月份标签即可，不加 "sectionHeader"。
- **网格**：`TokenHeatmap(series:maxVal:cellSize:9, cellGap:3, interactive:false, scrollable:false)`。
- **底部 caption**：`HStack { Text("近 5 个月 · \(formatTokens(viewModel.heatmapTotal)) tokens"); Spacer(); chevron.right }`。
  - `formatTokens` 为现有全局函数（`ios/Pocketctl/Views/AgentManageView.swift:420`），直接复用。
  - chevron 用 `.pcFgTertiary`，暗示可点进完整页。
- **占位（数据未到 / 失败 / 空用户）**：渲染 7 行 × 22 列全 level-0 灰格（`TokenHeatmap.color(level: 0)`）+ caption 显示「近 5 个月 · —」或「加载中…」，保持卡片高度稳定，避免数据到达时跳动。
- **不加图例**（「少 ▢▢▣▣■ 多」），空间紧，图例留在完整页。

## 涉及文件

| 文件 | 改动 |
|---|---|
| `ios/Pocketctl/Views/TokenUsageView.swift` | `TokenHeatmap` 参数化：`weeks`/`cellSize`/`cellGap`/`interactive`/`scrollable`（带默认值，用量页调用零改动） |
| `ios/Pocketctl/ViewModels/SettingsViewModel.swift` | 新增 `heatmapSeries` / `heatmapMax` / `heatmapTotal` / `loadHeatmap()` |
| `ios/Pocketctl/Views/SettingsView.swift` | 新增 `heatmapSignatureCard`；在 `profileSection` 后插入；`onAppear` 触发 `loadHeatmap()`；整卡可点跳 `TokenUsageView(daemonId: nil)` |

无后端改动（API 已支持 `days` 参数）。无 Web 改动。

## 验收

- [ ] 设置页头像区下方出现迷你热力图卡，22 周 × 7 天、cell 9pt、不滚动、无格子 tooltip。
- [ ] 数据加载中 / 失败 / 空用户时，卡片渲染占位灰格，不报错、不影响下方设置项。
- [ ] 点击整卡跳转全局用量分析页（`TokenUsageView(daemonId: nil)`），完整页热力图仍为 22 周可滚动可点击。
- [ ] 用量页 `heatmapCard` 行为完全不变（默认参数）。
- [ ] 卡片内宽 350pt 下 22 周网格不溢出、不出现横向滚动条。
- [ ] caption 显示 `近 5 个月 · {formatTokens(total)} tokens` + 右侧 chevron。

# 设置页消耗热力图迷你签名卡 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 iOS 设置页头像区下方插入一张紧凑、非交互的消耗热力图「签名卡」，点击跳转全局用量分析页。

**Architecture:** 参数化复用现有 `TokenHeatmap`（`TokenUsageView.swift:340`）—— 把写死的 `weeks`/`cellSize`/`cellGap`/滚动/交互提成带默认值的 init 参数，用量页零改动；迷你卡传 `cellSize:9, interactive:false, scrollable:false`。数据由 `SettingsViewModel` 新增一层异步 `loadHeatmap()`（复用 `APIClient.getTokenDashboard`，150 天，失败静默），`SettingsView.onAppear` fire-and-forget 触发。整卡可点 → 复用已有 `showGlobalUsage` + `navigationDestination` 跳转。

**Tech Stack:** SwiftUI (iOS 17+), `@Observable` VM, 既有 `APIClient` / `TokenDailyPoint` / `formatTokens` / 设计 token（`Color.pc*`、`PCSpacing`、`PCRadius`、`PCFont`）。

**Spec:** `docs/superpowers/specs/2026-07-01-settings-heatmap-design.md`

**测试策略（重要）：** 本项目无 Swift 测试 target（无 XCTest / `@Test` / 测试 scheme），既有 iOS 功能均无单元测试。本计划采用**验证驱动**：每个任务以 `xcodebuild` 编译通过 + 模拟器运行视觉验收为准，不强行引入无法运行的 TDD。这与 spec 的验收清单和项目现状一致。

**环境：** 工作目录 `/Users/muwenbin/projects/pocketctl`。iOS 工程路径 `ios/Pocketctl.xcodeproj`（用 `ios-dev` 技能或 MCP `ios_build_app` 构建）。

---

## 文件结构

| 文件 | 责任 | 改动类型 |
|---|---|---|
| `ios/Pocketctl/Views/TokenUsageView.swift` | `TokenHeatmap` 参数化（`weeks`/`cellSize`/`cellGap`/`interactive`/`scrollable`）；用量页调用保持默认参数 | 修改 |
| `ios/Pocketctl/ViewModels/SettingsViewModel.swift` | 新增热力图数据层：`heatmapSeries` / `heatmapLoading` / `heatmapMax` / `heatmapTotal` / `loadHeatmap()` | 修改（新增） |
| `ios/Pocketctl/Views/SettingsView.swift` | 新增 `heatmapSignatureCard`；`profileSection` 后插入；`onAppear` 触发加载 | 修改（新增） |

无新文件、无后端改动、无 Web 改动。

---

## Task 1：参数化 `TokenHeatmap`

把 `TokenHeatmap`（`TokenUsageView.swift:340`）写死的尺寸 / 行为参数提成 init 参数，带默认值 = 现状，使用量页 `TokenUsageView.heatmapCard`（`:171`）零改动。

**Files:**
- Modify: `ios/Pocketctl/Views/TokenUsageView.swift:340-490`（`TokenHeatmap` 结构体）

- [ ] **Step 1：改属性声明**

把 `TokenHeatmap` 顶部的常量声明从：

```swift
struct TokenHeatmap: View {
    let series: [TokenDailyPoint]
    let maxVal: Int

    @State private var selected: TokenHeatmapCell?

    private static let weeks = 22
    /// cell 尺寸与间隙，对齐 web 的 12px/gap 3px（略放大到 13pt 以适合手指点击）。
    private let cellSize: CGFloat = 13
    private let cellGap: CGFloat = 3
```

改成（`weeks` 从 static 提为实例 `let`，`cellSize`/`cellGap` 去掉默认值改由 init 注入，新增 `interactive`/`scrollable`）：

```swift
struct TokenHeatmap: View {
    let series: [TokenDailyPoint]
    let maxVal: Int
    let weeks: Int
    let cellSize: CGFloat
    let cellGap: CGFloat
    let interactive: Bool
    let scrollable: Bool

    @State private var selected: TokenHeatmapCell?
```

- [ ] **Step 2：新增 init（默认值 = 现状，保证用量页零改动）**

在 `@State private var selected` 下方、`columns` 计算属性之前插入：

```swift
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
```

- [ ] **Step 3：修 `columns` 计算属性里的 `TokenHeatmap.weeks` 引用**

`columns`（原 `:353`）里有一处 `for w in stride(from: TokenHeatmap.weeks - 1, through: 0, by: -1)`。把 `TokenHeatmap.weeks` 改为实例属性 `weeks`：

```swift
        for w in stride(from: weeks - 1, through: 0, by: -1) {
```

（这是唯一一处对 `TokenHeatmap.weeks` 静态引用，已确认全文无其它。）

- [ ] **Step 4：改 `body`，按 `interactive`/`scrollable` 条件渲染**

把整个 `var body: some View`（原 `:418-453`）替换为：

```swift
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
            }
        }
    }
```

（把原 body 里内联的 `ScrollView`/`ScrollViewReader`/`HStack` 抽成 `grid(_:)` + `heatmapRow(_:)`，按 `scrollable` 分支。）

- [ ] **Step 5：改 `heatmapCell`，按 `interactive` 条件挂载 tap / 选中描边**

把 `heatmapCell(_:)`（原 `:469-483`）替换为：

```swift
    private func heatmapCell(_ cell: TokenHeatmapCell) -> some View {
        RoundedRectangle(cornerRadius: 2)
            .fill(TokenHeatmap.color(level: cell.level))
            .frame(width: cellSize, height: cellSize)
            .overlay(
                RoundedRectangle(cornerRadius: 2)
                    .stroke(Color.pcAccent, lineWidth: 1)
                    .opacity(interactive && selected?.date == cell.date && cell.hasData ? 1 : 0)
            )
            .contentShape(Rectangle())
            .onTapGesture {
                guard interactive, cell.hasData else { return }
                selected = (selected?.date == cell.date) ? nil : cell
            }
    }
```

（描边与 tap 都加 `interactive` 前置判断；签名卡格子不可点、无选中描边。）

- [ ] **Step 6：编译验证**

Run（工作目录 `/Users/muwenbin/projects/pocketctl`）：

```bash
xcodebuild -project ios/Pocketctl.xcodeproj -scheme Pocketctl -destination 'generic/platform=iOS Simulator' -configuration Debug build -quiet 2>&1 | tail -20
```

Expected: `** BUILD SUCCEEDED **`。

若 scheme 名不是 `Pocketctl`，先 `xcodebuild -project ios/Pocketctl.xcodeproj -list` 查实际 scheme。

- [ ] **Step 7：确认用量页调用点零改动**

`heatmapCard`（原 `:171`）里的调用仍是：

```swift
TokenHeatmap(series: vm.heatmapSeries, maxVal: vm.heatmapMax)
```

因新 init 所有新参数都有默认值，此调用无需修改、行为不变。肉眼确认该行未被改坏即可。

- [ ] **Step 8：提交**

```bash
git add ios/Pocketctl/Views/TokenUsageView.swift
git commit -m "refactor(ios): TokenHeatmap 参数化(weeks/cellSize/interactive/scrollable),用量页零改动"
```

---

## Task 2：`SettingsViewModel` 加热力图数据层

复用 `TokenUsageViewModel.fetchHeatmap()` 的成熟模式，在 `SettingsViewModel` 加一层异步加载，失败静默。

**Files:**
- Modify: `ios/Pocketctl/ViewModels/SettingsViewModel.swift`

- [ ] **Step 1：新增状态属性**

在 `SettingsViewModel` 的 `// MARK: - State` 区块（`:8-19` 附近），`var isTestingConnection: Bool = false` 之后、`var connectionStatus` 之前，新增热力图状态：

```swift
    /// 设置页签名卡热力图数据（全局，近 5 个月）。独立于用量页，失败静默。
    private(set) var heatmapSeries: [TokenDailyPoint] = []
    private(set) var heatmapLoading: Bool = false
```

- [ ] **Step 2：新增计算属性 `heatmapMax` / `heatmapTotal`**

在 `// MARK: - Computed` 区块（`:45` 之后，`currentEnvironment` 之前或之后均可），新增：

```swift
    /// 热力图全局最大单日 (input+output)，作为 5 级分级基准。无数据时返回 1 避免 除 0。
    var heatmapMax: Int {
        max(1, heatmapSeries.map { $0.input + $0.output }.max() ?? 1)
    }

    /// 签名卡近 5 个月总消耗（input+output 求和），用于底部 caption。
    var heatmapTotal: Int {
        heatmapSeries.reduce(0) { $0 + $1.input + $1.output }
    }
```

- [ ] **Step 3：新增 `loadHeatmap()` 方法**

在 `// MARK: - Init` 区块的 `loadProfile()`（`:129-139`）之后（即 `Actions` 区之前），新增：

```swift
    /// 加载签名卡热力图（全局，近 5 个月 ≈ 150 天）。失败静默，不阻塞 UI。
    /// 窗口与用量页 `TokenUsageViewModel.fetchHeatmap()` 的 days:150 一致，保证签名与完整页同源。
    func loadHeatmap() async {
        heatmapLoading = true
        heatmapSeries = (try? await apiClient.getTokenDashboard(daemon: "all", days: 150))?.dailySeries ?? []
        heatmapLoading = false
    }
```

说明：`apiClient` 已是 VM 私有属性（`SettingsViewModel.swift:43`），无需新增。`getTokenDashboard` 签名见 `ios/Pocketctl/Services/APIClient.swift:86`，`daemon` 默认 `"all"`、返回 `TokenDashboard`（含 `dailySeries: [TokenDailyPoint]`）。`TokenDailyPoint` 已有 `input`/`output` 字段。

- [ ] **Step 4：编译验证**

```bash
xcodebuild -project ios/Pocketctl.xcodeproj -scheme Pocketctl -destination 'generic/platform=iOS Simulator' -configuration Debug build -quiet 2>&1 | tail -20
```

Expected: `** BUILD SUCCEEDED **`。

- [ ] **Step 5：提交**

```bash
git add ios/Pocketctl/ViewModels/SettingsViewModel.swift
git commit -m "feat(ios): SettingsViewModel 加签名卡热力图数据层(150天,失败静默)"
```

---

## Task 3：`SettingsView` 新增签名卡 + onAppear 触发

在 `profileSection` 之后、「账户」分区之前插入 `heatmapSignatureCard`，整卡可点跳转用量页，`onAppear` 触发数据加载。

**Files:**
- Modify: `ios/Pocketctl/Views/SettingsView.swift`

- [ ] **Step 1：插入签名卡到布局**

在 `SettingsView.body` 的 `ScrollView > VStack`（`:26`）里，`profileSection`（`:28`）之后、「账户」`sectionHeader("账户")`（`:30`）之前，插入：

```swift
                        // 签名卡热力图（消耗活动签名，点击进完整用量页）
                        heatmapSignatureCard
                            .padding(.horizontal, PCSpacing.lg)
                            .padding(.bottom, PCSpacing.sm)
```

- [ ] **Step 2：新增 `onAppear` 触发热力图加载**

在 `NavigationStack` 内的 `ScrollView` 之后或 `ZStack` 层级，找到现有的 `.onAppear`（目前只在 staging sheet 内有，`:744`，那是 sheet 级别）。在 `NavigationStack` 的内容上加设置页级的 `onAppear`。定位 `ZStack { ... }` 的结尾闭合处（账户/服务器/主机等所有 section 渲染完之后、`.navigationDestination` 之前），加：

```swift
            .onAppear { Task { await viewModel.loadHeatmap() } }
```

具体位置：在 `settingsGroup { ... }`（最后一组「其他」/「退出登录」）结束之后、`.navigationDestination(isPresented: $showGlobalUsage)`（`:287`）之前。若该处已有 modifier，并入即可。

- [ ] **Step 3：实现 `heatmapSignatureCard`**

在 `SettingsView` 里 `profileSection`（`:440-462`）之后，新增这个计算属性：

```swift
    // MARK: - 签名卡热力图

    /// 设置页顶部消耗活动签名：22 周 × 7 天迷你热力图 + 底部 caption，整卡可点进完整用量页。
    /// 非交互（格子不可点、无 tooltip）、不滚动（cell 9pt 下 22 周可铺满屏宽）。
    private var heatmapSignatureCard: some View {
        Button {
            showGlobalUsage = true
        } label: {
            VStack(alignment: .leading, spacing: PCSpacing.sm) {
                TokenHeatmap(
                    series: viewModel.heatmapSeries,
                    maxVal: viewModel.heatmapMax,
                    cellSize: 9,
                    cellGap: 3,
                    interactive: false,
                    scrollable: false
                )

                // 底部 caption：近 5 个月 · {total} tokens ›
                HStack(spacing: 6) {
                    Text("近 5 个月")
                        .font(PCFont.body(11))
                        .foregroundStyle(Color.pcFgTertiary)
                    Text("·")
                        .font(PCFont.body(11))
                        .foregroundStyle(Color.pcFgTertiary)
                    Text(formatTokens(viewModel.heatmapTotal))
                        .font(PCFont.mono(11, weight: .semibold))
                        .foregroundStyle(Color.pcAccent)
                    Text("tokens")
                        .font(PCFont.body(10))
                        .foregroundStyle(Color.pcFgTertiary)
                    Spacer()
                    Image(systemName: "chevron.right")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(Color.pcFgTertiary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16)
            .background(Color.pcSurface)
            .overlay(RoundedRectangle(cornerRadius: PCRadius.lg).stroke(Color.pcBorder, lineWidth: 1))
            .cornerRadius(PCRadius.lg)
        }
        .buttonStyle(.plain)
    }
```

说明：
- `formatTokens` 是现有全局函数（`ios/Pocketctl/Views/AgentManageView.swift:420`），直接可用。
- `showGlobalUsage` 已存在（`:9`），`navigationDestination`（`:287`）已接好 `TokenUsageView(daemonId: nil, apiClient: apiClient)`，无需新增导航代码。
- 数据未到 / 失败时 `heatmapSeries` 为空 → `TokenHeatmap` 渲染全 level-0 灰格（`columns` 计算里 `day == nil → level 0`），caption 显示 `formatTokens(0)`（即「0」），卡片高度稳定不跳动。若想显示「加载中…」更友好，可在此处读 `viewModel.heatmapLoading` 做文案分支（见 Step 4 可选项）。

- [ ] **Step 4（可选）：加载中文案优化**

若希望加载中显示「加载中…」而非「0 tokens」，把 caption 的 total 文案改为条件：

```swift
                    if viewModel.heatmapLoading && viewModel.heatmapSeries.isEmpty {
                        Text("加载中…")
                            .font(PCFont.body(11))
                            .foregroundStyle(Color.pcFgTertiary)
                    } else {
                        Text(formatTokens(viewModel.heatmapTotal))
                            .font(PCFont.mono(11, weight: .semibold))
                            .foregroundStyle(Color.pcAccent)
                    }
```

（「tokens」标签放在 else 内。此步可选，spec 验收只要占位不报错、高度稳定。）

- [ ] **Step 5：编译验证**

```bash
xcodebuild -project ios/Pocketctl.xcodeproj -scheme Pocketctl -destination 'generic/platform=iOS Simulator' -configuration Debug build -quiet 2>&1 | tail -20
```

Expected: `** BUILD SUCCEEDED **`。

- [ ] **Step 6：模拟器运行 + 视觉验收**

用 `ios-dev` 技能或 MCP 构建+运行到 iPhone 模拟器：

```bash
# 启动模拟器（若未启动）
xcrun simctl boot "iPhone 16" 2>/dev/null; open -a Simulator
# 构建 + 安装 + 运行（或用 ios_build_and_run MCP）
```

登录后进入「设置」页，逐条核对 spec 验收清单：

- [ ] 头像区下方出现迷你热力图卡，22 周 × 7 天、cell ≈9pt、**不滚动**、格子**不可点**无 tooltip。
- [ ] 数据加载中 / 失败 / 空用户时，卡片渲染占位灰格，不报错、不影响下方设置项（账户/服务器/主机等正常）。
- [ ] 点击整卡 → 跳转全局用量分析页（`TokenUsageView`），完整页热力图仍为 22 周可滚动、可点击 tooltip。
- [ ] 卡片内宽（~350pt）下 22 周网格不溢出、无横向滚动条。
- [ ] caption 显示 `近 5 个月 · {formatTokens(total)} tokens` + 右侧 chevron。

- [ ] **Step 7：提交**

```bash
git add ios/Pocketctl/Views/SettingsView.swift
git commit -m "feat(ios): 设置页头像区下加消耗热力图迷你签名卡,点击进用量页"
```

---

## 完成标准（对齐 spec 验收）

全部任务完成且 `** BUILD SUCCEEDED **` + 模拟器视觉验收通过，即满足 `docs/superpowers/specs/2026-07-01-settings-heatmap-design.md` 的验收清单。三个文件改动，无后端 / Web 改动。

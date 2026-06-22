# UI 设计稿还原分析报告

**日期**：2026-06-20
**范围**：`ui-design/screens/` 目录下 4 个页面（2 新增 + 2 修改）→ iOS App 还原分析

---

## 总览

```
ui-design/screens/
├── agent-manage.html   ★ 新增 — Agent 版本管理 + 升级 + 配置
├── token-usage.html    ★ 新增 — Token 用量分析看板（移动端版）
├── daemon-list.html    ✎ 修改 — 主机列表重构（概览卡片 + 功能行 + 最近会话）
└── settings.html       ✎ 修改 — 设置页重构（订阅 + 主机迷你列表 + 扫码入口）
```

---

## 一、Agent 管理页 (`agent-manage.html`) ★ 新增

### 1.1 页面结构

```
┌─────────────────────────────────┐
│ ← 主机    Agent 管理            │  ← Nav Bar
├─────────────────────────────────┤
│ ● MacBook-Pro  192.168.1.100   │  ← 主机信息条
├─────────────────────────────────┤
│ 已安装 Agent (4)                │  ← Section 标题
├─────────────────────────────────┤
│ ┌─ Agent Card ────────────────┐ │
│ │ CC  Claude Code             │ │  ← Icon + 名称
│ │     ● 运行中 · 3 个活跃会话  │ │  ← 状态行
│ │ ─────────────────────────── │ │
│ │ 当前版本  v2.3.1            │ │  ← 版本行
│ │ 最新版本  v2.4.0  可升级     │ │  ← 版本对比
│ │ ─────────────────────────── │ │
│ │ 1.25M  48K  620K            │ │  ← Token mini（总/今日/Cache）
│ │ ─────────────────────────── │ │
│ │ [升级到 v2.4.0]  [配置]     │ │  ← 操作按钮
│ └─────────────────────────────┘ │
│ ...（Codex / OpenCode / Cursor）│
│ ┌─────────────────────────────┐ │
│ │ ＋ 添加 Agent                │ │  ← 虚线按钮
│ └─────────────────────────────┘ │
└─────────────────────────────────┘

状态切换：右上角 [全部] [可升级]
```

### 1.2 元素与交互

| 元素 | 交互 | 状态变化 |
|------|------|---------|
| Agent 卡片 | 静态展示 | running/idle 状态色 + 活跃会话数 |
| 版本行 | 静态展示 | 最新版本绿色 + "可升级"橙色标签 vs 灰色 "✓ 最新" |
| 升级按钮 | `tap → "升级中…" → 2s → "已是最新"` | 蓝色 → 灰色 disabled |
| 配置按钮 | `tap → bottom sheet 弹出` | 蒙层 + sheet 从底部滑入 (0.25s ease) |
| 配置弹窗 | 模型选择(pills) + 工作目录输入 | selected 态蓝色边框 |
| 状态切换 | `tap [全部]/[可升级]` | 过滤卡片显示/隐藏 |
| 添加 Agent | `tap` | 虚线边框按钮，无弹窗（占位） |
| 返回按钮 | `tap → daemon-list.html` | — |

### 1.3 动效清单

| 动效 | 实现 | 用途 |
|------|------|------|
| 配置弹窗滑入 | `@keyframes cfgSlide` (0.25s ease, translateY 100%→0) | 配置 bottom sheet |
| 升级按钮状态 | class 切换 (upgrading → disabled) | 升级流程反馈 |
| 模型选择 | `:active` 无过渡，即时切换 | 模型 pill 选中 |
| 点击反馈 | `:active` 背景色变化 | 按钮/卡片 |

### 1.4 数据需求 vs 已有接口

| 数据项 | 来源 | 状态 |
|--------|------|------|
| 主机信息（hostname, IP, OS, online） | WS `daemon_list` 已返回 | ✅ 已支持 |
| Agent 列表（名称、类型） | WS `daemon_list` → `daemon.agents` JSONB | ✅ 已支持 |
| Agent 版本（当前/最新） | `daemon.agents` 在 daemon 注册时写入 | ⚠️ 版本对比逻辑缺失 — 需 daemon 端上报最新版本号 |
| Agent 运行状态 + 活跃会话数 | 当前无 agent 级别的会话统计 | ❌ 缺失 — `sessionCounts` 只统计 daemon 级，不区分 agent |
| Agent Token 消耗（总/今日/Cache） | 当前只统计 session 级，不区分 agent | ❌ 缺失 — 需要 agent 维度的 token 聚合 |
| 升级 Agent | `POST /api/daemons/:id/upgrade-agent` | ✅ 已支持 |
| 配置 Agent（默认模型、工作目录） | 无对应 API | ❌ 缺失 — 需要新增配置存储 + API |
| "添加 Agent" | daemon 端安装新 agent 后自动注册 | ⚠️ 无 API — daemon 自动发现 agent，但无远程安装能力 |

### 1.5 缺失接口汇总

| # | 接口 | 说明 |
|---|------|------|
| 1 | `GET /api/daemons/:id/agents` | 返回该主机下各 agent 的详细信息（版本、状态、token 消耗、会话数） |
| 2 | `PUT /api/daemons/:id/agents/:agent/config` | 设置 agent 默认模型、工作目录等配置 |
| 3 | Agent 级 token 聚合 | 在 `getTokensByDaemon` 等查询中增加 agent 维度分组 |

---

## 二、Token 用量页 (`token-usage.html`) ★ 新增

### 2.1 页面结构

```
┌─────────────────────────────────┐
│ ← 设置    用量分析               │
├─────────────────────────────────┤
│ ┌──────────┐ ┌──────────┐      │
│ │ 总消耗    │ │ 今日消耗  │      │  ← 2×2 概览卡片
│ │ 12.5M    │ │ 380K ↑5.2%│      │
│ ├──────────┤ ├──────────┤      │
│ │ 近 7 天  │ │ 近 30 天  │      │
│ │ 2.1M ↓3% │ │ 12.5M    │      │
│ └──────────┘ └──────────┘      │
├─────────────────────────────────┤
│ Token 细分                      │
│ 输入量        8.1M  含900K cache│
│ 输出量        3.1M  平均12K/请求│
│ Cache 命中    900K  命中率 11%  │  ← 指标列表
│ 请求次数      2.8K  日均95次    │
│ 最常用模型    glm-5.2  67%     │
├─────────────────────────────────┤
│ 每日消耗（30天）                 │
│ ▓▓▓▓▓▓▓░▓▓▓▓▓▓░▓░▓ (柱状图)   │  ← 堆叠柱状图
│ ■ 输入  ■ 输出                  │
├─────────────────────────────────┤
│ 模型分布                        │
│  ◉ 环形图  │ glm-5.2    67%    │  ← Donut + 图例
│   12.5M   │ glm-5-turbo 30%    │
│            │ glm-4.7      3%    │
├─────────────────────────────────┤
│ 会话消耗明细                    │
│ ● 重构用户认证模块  2.1M 运行中  │  ← Session 列表
│ ● 修复CI构建错误    1.5M 已完成  │
│ ● 部署脚本优化      880K 运行中  │
│ ● sess_d9b2e6f5     620K 已完成 │
└─────────────────────────────────┘
```

### 2.2 元素与交互

| 元素 | 类型 | 说明 |
|------|------|------|
| 概览卡片 2×2 | 静态数据 | 总/今日/7天/30天 + 趋势箭头 |
| 柱状图 | CSS div 渲染 | 30 天堆叠（输入蓝+输出绿） |
| 环形图 | CSS conic-gradient | 模型占比 + 中心总量 |
| 指标列表 | 静态数据 | 5 行明细指标 |
| 会话列表 | 静态 + tap 跳转 | 点击进入 session-detail |

### 2.3 动效

无 JavaScript 动画。柱状图和环形图用纯 CSS/HTML 渲染，数据驱动。

### 2.4 数据需求 vs 已有接口

| 数据项 | 已有接口 | 匹配度 |
|--------|---------|--------|
| 总消耗 | `GET /api/tokens/dashboard` → `summary.total` | ✅ |
| 今日消耗 + 趋势 | `summary.today`，但无昨日对比值 | ⚠️ API 不返回趋势百分比 |
| 近 7 天 + 趋势 | `summary.thisWeek`，无上周对比 | ⚠️ API 不返回趋势百分比 |
| 近 30 天 | `summary.thisMonth` | ✅ |
| 每日柱状图（30 天） | `dashboard` → `dailySeries` 返回 daily input/output | ✅ |
| 模型分布 | `dashboard` → `byModel` 返回 model/pct/total | ✅ |
| 输入量 | 需从 `dailySeries` 或 sessions 中 sum | ⚠️ 无直接的聚合指标 |
| 输出量 | 同上 | ⚠️ |
| Cache 命中 + 命中率 | `byModel` 有 cache_read，命中率需计算 | ⚠️ |
| 请求次数 | `dailySeries` 有 requests，需 sum | ⚠️ |
| 最常用模型 | `byModel` 按 total 排序取第一 | ✅ |
| 会话消耗明细 | `GET /api/tokens/by-daemon/:id` → sessions 列表 | ✅ |

### 2.5 缺失数据点

| # | 数据 | 说明 |
|---|------|------|
| 1 | 趋势百分比 | API 需返回昨日/上周同期值用于计算 ↑↓% |
| 2 | 聚合指标 API | 当前 dashboard 返回原始序列，缺"输入总量/输出总量/Cache命中总量/请求总次数/命中率/最常用模型"的预计算汇总 |
| 3 | Session 消耗列表带分页 | `by-daemon` 返回所有 sessions，无分页参数 |

---

## 三、主机列表页 (`daemon-list.html`) ✎ 修改

### 3.1 改版变化

```
旧版：简单卡片列表，每张卡片显示 hostname + 状态 + 会话数
新版：
┌──────────────────────────────────┐
│ 我的主机                          │  ← Large Title
│ 2 台主机 · 1 台在线      [M]     │  ← 摘要 + 头像钮
├──────────────────────────────────┤
│ ┌─ 概览状态卡 ─────────────────┐ │  ★ 新增
│ │ 1     1     92K     3       │ │
│ │ 在线   离线   今日Token 活跃  │ │
│ └──────────────────────────────┘ │
├──────────────────────────────────┤
│ ┌─ 主机卡片 ───────────────────┐ │
│ │ ● MacBook-Pro [编辑] 在线 ⋯ │ │  ← 别名编辑 + 操作菜单
│ │ Claude Code v2.4.0 Codex…   │ │  ★ Agent 标签（紧凑横排）
│ │ ──────────────────────────── │ │
│ │ 💬 会话列表  3活跃·12历史  ›│ │  ★ 功能列表行
│ │ ➕ 新建会话               ›│ │
│ │ 📊 Token消耗  1.57M·60K   ›│ │
│ │ 🔧 Agent管理  4个·2可升级 ›│ │
│ │ ──────────────────────────── │ │
│ │ 最后活跃: 2 分钟前           │ │
│ └──────────────────────────────┘ │
│ ┌─ 离线主机(灰色) ────────────┐ │
│ │ ○ Dev-Server  离线          │ │  ← 离线样式
│ │ 新建会话/Agent管理 → 置灰    │ │
│ └──────────────────────────────┘ │
├──────────────────────────────────┤
│ 最近会话                         │  ★ 新增
│ ● 重构用户认证模块 · 3分钟前     │
│ ● 修复CI构建错误 · 8分钟前      │
│ ● sess_a3f7b2c1 · 1小时前       │
└──────────────────────────────────┘

⋮ 操作菜单 (bottom sheet):
  重启 daemon
  编辑别名
  强制踢下线
  注销主机
  取消
```

### 3.2 新增元素详解

#### 概览状态卡

```
online_count | offline_count | today_tokens | active_sessions
```

#### Agent 标签

显示该主机已安装的 agent 类型 + 版本（"Claude Code v2.4.0"、"Codex v1.8.0"），有更新时显示橙色可升级提示。

#### 功能列表行

每个行 = icon + label + value + chevron。代替旧版的大按钮布局，更紧凑且 iOS 风格。

#### 别名编辑

- 行内 edit 按钮（hover 显示）
- 点击 → 输入框展开 + 确认/取消按钮
- 确认 → 预览更新
- 重置 → 恢复默认 hostname

#### 操作菜单（Action Sheet）

- 蒙层 + 底部滑入 (0.25s ease)
- 5 个操作 + 取消

#### 最近会话

跨主机显示最近 3 条会话（标题 + 主机名 + 时间）

### 3.3 数据需求 vs 已有接口

| 数据/功能 | 现有接口 | 状态 |
|-----------|---------|------|
| 概览：在线/离线数 | WS `daemon_list` 包含 online/offline 状态 | ✅ 客户端可计算 |
| 概览：今日 Token | `GET /api/tokens/summary` | ⚠️ 需额外请求；可考虑集成到 daemon_list |
| 概览：活跃会话数 | WS `daemon_list` 已含 `active_sessions` | ✅ |
| Agent 标签（名称+版本） | WS `daemon_list` → `daemon.agents` | ✅ |
| Agent 可升级标识 | 无对应数据 | ❌ 需要 daemon 上报 latest version |
| 功能行 value（会话数、Token 数） | 来自 WS + REST 混合 | ⚠️ 分属不同数据源 |
| 别名编辑 | `PUT /api/daemons/:id/alias` | ✅ |
| 重启 daemon | `POST /api/daemons/:id/restart` | ✅ |
| 强制踢下线 | `POST /api/daemons/:id/forceKick` | ✅ |
| 注销主机 | `DELETE /api/daemons/:id` | ✅ |
| 最近会话（跨主机） | `GET /api/sessions` (listSessionsByUser) | ⚠️ 无 limit 参数，返回全部 |
| 离线主机显示 | DB `daemons WHERE status='offline'` | ✅ 已在 `handleListDaemons` 中实现 |
| 空状态 | 纯 UI | ✅ |

### 3.4 缺失接口/数据

| # | 需求 | 说明 |
|---|------|------|
| 1 | Agent 最新版本号 | Daemon 需上报各 agent 的 `latest_version` 字段 |
| 2 | 功能行 Token 值（单主机） | 当前只能从 `GET /api/tokens/by-daemon/:id` 单独获取，daemon_list 不包含 |
| 3 | 最近会话 API | 需 `GET /api/sessions/recent?limit=3` 或类似的带 limit 的跨主机查询 |

---

## 四、设置页 (`settings.html`) ✎ 修改

### 4.1 改版变化

```
旧版：简单设置列表
新版：
┌──────────────────────────────────┐
│ ←       设置          [扫码图标] │  ★ Nav 右侧扫码入口
├──────────────────────────────────┤
│           [M]                    │
│       dev@pocketctl.io          │  ← 头像 + 邮箱/手机
│        编辑资料                  │
├──────────────────────────────────┤
│ 账户                            │
│ ✉️ 邮箱  dev@pocketctl.io   ›  │
├──────────────────────────────────┤
│ 我的主机                        │
│ ● MacBook-Pro   在线         ›  │  ★ 主机迷你列表
│ ○ Dev-Server    离线         ›  │
│ ＋ 注册新主机                   │  ★ 添加入口
├──────────────────────────────────┤
│ 订阅                            │
│ 当前方案     [免费版]           │  ★ Plan Badge
│ ─────────────────────────────   │
│ ⭐ 升级专业版 ¥48/月           │  ★ 升级 CTA
│    无限主机·推送通知·实时消息    │
├──────────────────────────────────┤
│ 其他                            │
│ 用量分析                     ›  │
│ 帮助与反馈                   ›  │
│ 关于 pocketctl               ›  │
│ 隐私政策                     ›  │
│ 用户协议                     ›  │
├──────────────────────────────────┤
│        退出登录                  │  ★ 红色居中
└──────────────────────────────────┘
```

### 4.2 新增元素

| 元素 | 说明 |
|------|------|
| 扫码按钮（右上角） | 跳转 `scan-login.html`，用于授权 Web 端登录 |
| 主机迷你列表 | 在线状态点 + hostname + chip + chevron |
| 注册新主机入口 | ＋ 按钮，引导用户在新机器安装 daemon |
| Plan badge | 免费版=灰色 / 专业版=蓝色 |
| 升级 CTA 卡片 | 星标 icon + 标题+价格 + 权益描述 |
| 用量分析入口 | 跳转 `token-usage.html` |

### 4.3 数据需求 vs 已有接口

| 数据/功能 | 现有接口 | 状态 |
|-----------|---------|------|
| 用户头像字母 | 客户端从邮箱/手机提取首字母 | ✅ 纯前端 |
| 邮箱/手机显示 | `GET /api/user/profile` | ❌ 缺失 — 没有 GET profile 接口 |
| 编辑资料 | `PUT /api/user/profile`, `PUT /api/user/email` | ✅ |
| 主机迷你列表 | WS `daemon_list` | ✅ |
| 注册新主机 | 需引导用户执行 CLI 命令 | ✅ 纯 UI（类似空状态的安装指南） |
| 当前方案 badge | `users.plan` 字段已有 | ⚠️ 需要 API 返回 plan |
| 升级 CTA | 纯 UI，跳转支付页 | ✅ 不需要后端 |
| 用量分析入口 | 页面跳转 | ✅ |
| 退出登录 | 客户端清除 token | ✅ 纯前端 |
| 扫码登录入口 | 页面跳转 | ✅ |

### 4.4 缺失接口

| # | 接口 | 说明 |
|---|------|------|
| 1 | `GET /api/user/profile` | 返回当前用户的 display_name, email, phone, plan, avatar_url 等 |
| 2 | Plan 信息返回 | 可在上述接口中返回 `{ plan: 'free', permissions: {...} }` |

---

## 五、全局设计系统分析

### 5.1 色彩系统（Dark Theme）

```
--bg:          #0d1117   ← 主背景（GitHub 暗色）
--surface:     #161b22   ← 卡片/列表背景
--accent:      #58a6ff   ← 主色调（蓝色）
--success:     #3fb950   ← 在线/成功（绿色）
--warning:     #d29922   ← 警告/可升级（橙色）
--error:       #f85149   ← 错误/危险（红色）
--fg:          #e6edf3   ← 主文字
--fg-secondary:#8b949e   ← 次级文字
--fg-tertiary:#484f58    ← 第三级文字
```

### 5.2 动效系统

| 名称 | 关键帧 | 用途 | 使用页面 |
|------|--------|------|---------|
| `pulse-green` | box-shadow 脉冲 | 在线状态点呼吸 | 全局 shared.css |
| `pulse-amber` | box-shadow 脉冲 | 忙碌状态点 | 全局 |
| `fade-in` | opacity + translateY(8px→0) | 列表项入场 | 全局 |
| `spin` | rotate(360°) | 加载 spinner | 全局 |
| `blink-cursor` | opacity 闪烁 | 输入光标 | 全局 |
| `slideUp` | translateY(100%→0) | Action Sheet 弹出 | daemon-list |
| `cfgSlide` | translateY(100%→0) 0.25s ease | 配置弹窗弹出 | agent-manage |

### 5.3 iOS 还原要点

| iOS 特性 | 设计稿实现 | SwiftUI 还原方式 |
|----------|-----------|-----------------|
| Dynamic Island | `dynamic-island` div (126×37px, 黑色) | `.ignoresSafeArea()` + 顶部 padding |
| Status Bar | 9:41 + 信号/WiFi/电池 SVG | 用系统 status bar，不需要自定义 |
| Home Indicator | 134×5px 圆角条 | 系统自动处理 |
| Large Title | 34px/700 weight | `.navigationBarTitleDisplayMode(.large)` |
| List Row (Settings 风格) | 44px min-height, chevron, icon+label+value | `List` + `Section` |
| Action Sheet | Bottom sheet + 蒙层 + 滑入动画 | `.actionSheet()` 或自定义 `.sheet()` |
| Card | surface 背景 + border + radius-lg | `RoundedRectangle` + `.background(.ultraThinMaterial)` |
| Chip/Badge | rounded-full + 半透明背景 | `Capsule` shape |
| Config Sheet | 底部滑入可拖拽面板 | `.sheet(.presentationDetents([.medium]))` |
| Donut 环形图 | CSS conic-gradient | `Canvas` 或 Swift Charts `SectorMark` |
| 柱状图 | CSS div 堆叠 | Swift Charts `BarMark` 堆叠 |

---

## 六、接口缺失汇总

### 6.1 需要新增的 API

| # | 方法 | 路径 | 说明 | 优先级 |
|---|------|------|------|--------|
| 1 | `GET` | `/api/user/profile` | 获取当前用户信息（name, email, plan, avatar） | **P0** |
| 2 | `GET` | `/api/daemons/:id/agents` | 获取主机下 agent 详细信息（版本/状态/token/会话数） | **P0** |
| 3 | `GET` | `/api/sessions/recent` | 最近会话（跨主机，支持 limit 参数） | P1 |
| 4 | `PUT` | `/api/daemons/:id/agents/:agent/config` | Agent 配置（默认模型、工作目录） | P1 |

### 6.2 需要增强的现有 API

| # | 接口 | 增强内容 |
|---|------|---------|
| 5 | `GET /api/tokens/dashboard` | 增加趋势百分比（vs 昨日/上周）、聚合指标汇总（输入总量/输出总量/cache命中/命中率/请求次数/最常用模型） |
| 6 | `GET /api/tokens/by-daemon/:id` | 增加 agent 维度分组、session 列表分页参数 |
| 7 | WS `daemon_list` | agent 信息中增加 `latest_version` 字段用于升级判断 |

### 6.3 需要 Daemon 端增强

| # | 需求 | 说明 |
|---|------|------|
| 8 | Agent 最新版本上报 | Daemon 注册时查询各 agent 最新版本并上报到 relay |
| 9 | Agent 配置同步 | Daemon 接收 relay 转发的 agent 配置变更并写入本地配置文件 |

---

## 七、当前系统无法直接实现的功能

| 功能 | 原因 |
|------|------|
| Agent 版本对比 + 升级提示 | Daemon 不上报各 agent 的最新版本号，relay 无法判断是否可升级 |
| Agent 级 Token 统计 | Token 只统计到 session 级，不区分该 session 用的是哪个 agent |
| Agent 远程配置（模型/工作目录） | 无对应的 WS 消息类型和 relay→daemon 配置同步机制 |
| "添加 Agent" 远程安装 | Daemon 只能自动发现已安装的 agent，不支持远程安装新 agent |
| 订阅付费流程 | 无计费系统（Stripe 等），无支付回调；设计稿显示 ¥48/月与已确定的 ¥19/月不一致 |
| 设置页"注册新主机"的引导 | 暂无 CLI 安装脚本托管地址（`pocketctl.com/install.sh` 显示为占位 URL） |

---

## 八、设计稿与已确定方案的不一致项

| 不一致 | 设计稿 | 已确定方案 | 建议 |
|--------|--------|-----------|------|
| 设置页 Pro 价格 | ¥48/月 | ¥19/月 | 以 ¥19/月 为准更新设计稿 |
| 设置页 Pro 权益描述 | "无限主机·推送通知·实时消息" | 不限主机（非付费点） | 改为实际权益：并发 10 个·历史永久·全量推送·数据导出 |
| Plan 层级 | 仅 free/pro | 已预留 max 扩展 | 保持设计稿即可，扩展名后续加 |

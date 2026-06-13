# pocketctl iOS APP — Open Design UI 设计提示词

> 设计平台：Open Design  
> 目标设备：iPhone 15 Pro, iOS 17+, 支持 Dynamic Island 和 Home Indicator  
> 设计系统：Apple iOS (SF Pro, 原生 iOS 组件)  
> 市场定位：国内开发者工具，远程监控 AI 编程助手  
> 认证方案：手机号 + 短信验证码为主，Apple Sign In（iOS 必须），预留微信登录  
> 导航策略：智能跳转（1 个 Daemon 自动跳到 Session 列表）

---

## 通用设计方向（每次生成前先设定）

```
Design system: Apple iOS (SF Pro, native iOS components, Dynamic Island safe area)
Style: Dark theme, developer-tool aesthetic inspired by GitHub Dark mode
Primary colors: Background #0d1117 / Surface #161b22 / Accent blue #58a6ff / Success green #238636
Typography: SF Pro Display for headings, SF Pro Text for body, SF Mono for code/session IDs
Target: iPhone 15 Pro frame, iOS 17+, support Dynamic Island and Home Indicator
Tone: Professional, minimal, information-dense — a power tool for developers managing AI agents remotely
```

---

## 页面 0：启动页 / Splash Screen

```
Generate a mobile splash screen for "pocketctl" iOS app — a developer tool
for monitoring AI coding agents remotely from your phone.

Layout:
- Solid dark background (#0d1117)
- Center: pocketctl logo mark (a minimal geometric icon combining a terminal
  prompt ">" with a pocket/phone outline, in accent blue #58a6ff)
- Below logo mark: wordmark "pocketctl" in SF Pro Display bold, #58a6ff
- Below wordmark: tagline "Your coding agents, in your pocket." in SF Pro Text,
  muted gray (#8b949e), centered
- Bottom: subtle loading indicator — a thin horizontal progress bar or
  pulsing dot in accent blue
- Safe area: respect Dynamic Island top and Home Indicator bottom

Style: Minimal, dark, premium developer aesthetic. No gradients or patterns
on background — just the solid dark color. The logo should be the sole focus.
```

---

## 页面 1：登录/注册页（手机号验证码）

```
Generate a mobile login screen for "pocketctl" iOS app.
This is a Chinese-market app for developers to monitor AI coding agents remotely.

Layout (centered card on dark background #0d1117):
- Top: pocketctl logo mark (small) + wordmark in #58a6ff
- Below: tagline "远程掌控你的 AI 编程助手" in SF Pro Text, gray #8b949e

Login form:
- Title: "登录" in SF Pro Display semibold, white
- Phone number input:
  - Left: "+86" country code prefix in a non-editable chip, with dropdown
    chevron to change country
  - Right: phone number field, numeric keyboard, placeholder "请输入手机号"
  - Dark input background (#161b22), light border, blue focus ring (#58a6ff)
- Verification code input:
  - 6-digit code field with individual character boxes (like ride-hailing apps)
  - Right side: "获取验证码" button (blue text #58a6ff), changes to
    "60s 后重发" countdown when sent
- "登录" primary button: full width, green (#238636), rounded 12px, bold
- Below button: "登录即同意《用户协议》和《隐私政策》" in small gray text,
  links are blue #58a6ff

Social login section:
- Thin divider line with "其他登录方式" text in gray, centered
- Two icon buttons side by side:
  - Apple Sign In: white Apple logo on black rounded square
  - WeChat: green WeChat logo on white rounded square (grayed out / "即将开通" label)
  - Both buttons are 56x56px, rounded 16px

States to show:
- Normal state (empty form)
- Error state: "验证码错误" red banner at top
- Countdown state: "获取验证码" showing "47s 后重发"
- Loading state: "登录" button shows spinner, "登录中..."

No tab switching between login/register — phone verification code handles both:
  new phone = auto-register, existing phone = login.

Safe area padding for Dynamic Island and Home Indicator.
```

---

## 页面 2：Daemon 列表（仪表盘）

```
Generate a mobile daemon list screen for pocketctl iOS app — the main dashboard
where developers see their registered development machines (daemons).

This is the root screen after login. If the user has only 1 daemon,
the app auto-navigates to that daemon's session list. This screen only shows
when the user has 2+ daemons.

Header:
- Large title "我的主机" in SF Pro Display bold, white
- Right side: circular avatar button (user initial or phone number last 4 digits)

Daemon cards (vertical scrollable list):
- Each card is a rounded rectangle (16px radius) with dark surface (#161b22),
  subtle border (#21262d)
- Layout per card:
  - Top row:
    - Left: Status dot — green pulsing for online, gray static for offline
    - Next: Hostname in SF Pro Text semibold, white (e.g., "MacBook-Pro")
    - Right: Daemon status chip — "在线" (green) / "离线" (gray)
  - Middle row: Info line in tertiary gray (#484f58)
    - Agent types: "Claude Code, Codex" as text labels
    - Session count: "3 个活跃会话" in blue #58a6ff
  - Bottom row:
    - "最后活跃: 2 分钟前" relative timestamp in muted gray (#8b949e)
    - Right: chevron-right icon indicating tappable

- Online daemons sort first, then offline
- Tap card navigates to that daemon's session list

Empty state (no daemons registered):
- Terminal/monitor icon (large, muted gray)
- "还没有注册主机" title
- "在你的开发机上运行以下命令安装 Daemon" subtitle
- Install command in copyable code block (dark bg, SF Mono font):
  `curl -fsSL https://pocketctl.me/install.sh | bash`
  followed by: `pocketctl login` and `pocketctl daemon start`
- "复制命令" button next to the code block

Pull-to-refresh support.
```

---

## 页面 3：Session 列表（单个 Daemon 下）

```
Generate a mobile session list screen for pocketctl iOS app — showing all
AI coding agent sessions under a specific daemon/machine.

Header:
- Back chevron button (left) — "我的主机" label next to it
- Center: Daemon hostname in SF Pro Text semibold, white (e.g., "MacBook-Pro")
- Right: "+ 新建会话" button (plus icon in green #238636 circle, 32px)

Daemon status bar (below header):
- Thin bar: green dot + "在线 · 最后心跳 30秒前"
  OR gray dot + "离线 · 上次在线 2小时前"
- Tappable to expand daemon details (hostname, daemon_id, agent types)

Session cards (vertical scrollable list, sorted by last activity):
- Each card: rounded rectangle (12px radius), dark surface (#161b22), border (#21262d)
- Left: Status indicator dot with animations:
  - Green pulsing: running
  - Amber pulsing: busy
  - Yellow static: idle
  - Orange: waiting_approval
  - Blue checkmark: completed
  - Red X: error / killed
- Main content:
  - Session title in SF Pro Text semibold, white (or truncated session ID
    in SF Mono #79c0ff if no title)
  - Badges row:
    - Source: "终端" (blue chip) or "Web" (green chip)
    - Sub-agent count: "3 子智能体" (purple chip) if > 0
  - Bottom: "3 分钟前" relative timestamp in tertiary gray
- Tap navigates to session detail

Session exited banner (inline):
  - Amber-tinted card with exit reason text and "恢复会话" blue button

Empty state (daemon has no sessions):
- Robot/code icon (large, muted)
- "暂无活跃会话" title
- "点击右上角 + 创建新的 AI 编程会话" subtitle

Pull-to-refresh support.
```

---

## 页面 4：Session 详情（聊天/监控视图）

```
Generate a mobile chat/session detail screen for pocketctl iOS app —
real-time monitoring and interaction with an AI coding agent session.

Top toolbar:
- Back chevron (left) — hostname label (e.g., "MacBook-Pro")
- Center: Session title in SF Mono, #58a6ff, truncated
- Right: Status badge pill — "运行中" (green) / "忙碌" (amber) / "空闲" (gray) /
  "已完成" (blue) / "错误" (red)

Conditional status banners (below toolbar):
- Daemon offline: blue banner, "Daemon 离线"
- Session exited: amber banner with exit reason + "恢复会话" button

Message stream (chat-style, scrollable, messages from bottom):
- User messages: RIGHT-aligned, blue bubble (#1f6feb bg), white text,
  rounded corners with tail on right
- Agent text messages: LEFT-aligned, dark bubble (#21262d bg), light text (#e6edf3),
  blinking cursor "▎" animation when streaming
- Tool call cards (LEFT-aligned, wider than text bubbles):
  - Collapsible with chevron toggle
  - Header row: tool icon + tool name in blue bold + short arg summary in gray
    - Icons: 📖 Read, ✏️ Write/Edit, ⚡ Bash, 🔍 Grep/Glob, 🌐 Web, 🤖 Agent
  - Running state: spinner animation + "执行中..."
  - Done state: green ✓ checkmark
  - Expanded view:
    - Input section: formatted per tool (e.g., "$ ls -la" for Bash,
      "src/index.ts:10-25" for Read)
    - Output section: collapsible monospace block, auto-collapse when >20 lines,
      "展开全部 (N 行)" / "收起" toggle button
  - Sub-agent tool calls: show nested purple-bordered SubAgentCard
- Error messages: red bubble (#3d1214 bg, #f85149 text)

Timeline milestones:
- Horizontal row of state dots with labels: 创建 → 运行 → 完成
- Timestamps below each dot in tertiary gray

Bottom input area:
- Rounded input field (#161b22 bg) with placeholder "发送消息..."
  or "输入消息恢复会话..." for exited sessions
- Send button (blue arrow icon) inside input, right side
- Hidden for terminal states, replaced with centered "会话已结束" gray text
- Home Indicator safe area padding

Show a mid-conversation state with:
- Multiple message types visible
- One tool call expanded, showing Bash command + output
- One tool call collapsed with running spinner
- Streaming agent message with cursor animation
```

---

## 页面 5：新建 Session 底部弹窗

```
Generate a bottom sheet modal for creating a new AI agent session in pocketctl iOS app.

Context: This is triggered by the "+ 新建会话" button on the session list screen.

Bottom sheet:
- Rounded top corners (20px), dark surface (#161b22) background
- Drag handle: short gray bar at top center
- Title: "新建会话" in SF Pro Display semibold, white

Form:
- Agent type selector: horizontal segmented pills
  - "Claude Code" (selected, blue #58a6ff bg)
  - "Codex" (unselected, #21262d bg)
  - Smooth selection animation
- Working directory: text input with folder icon prefix,
  placeholder "/path/to/project"
  - Dark input bg (#0d1117), monospace font
- Initial prompt: multi-line textarea (min 3 visible lines, expandable)
  - Placeholder "描述你想要 AI 完成的任务..."
  - Auto-growing as user types
  - Dark input bg (#0d1117)

Primary action:
- "开始会话" button, full width, green (#238636), rounded 12px, bold
- Disabled (muted green) when agent type is the only filled field

Dimmed overlay behind the sheet (#0d1117 at 60% opacity).
```

---

## 页面 6：设置/个人中心

```
Generate a mobile settings/profile screen for pocketctl iOS app.
Chinese language UI.

Navigation: pushed from daemon list (avatar button top-right).

Profile section (top):
- Large centered avatar circle with user initial or phone icon
- Phone number display: "138****8888" (masked middle digits)
- "编辑资料" link in blue #58a6ff below

Grouped list (iOS Settings style, dark theme):
Section header: "账户"
- 手机号 row: "138****8888", chevron right, tappable to change
- 微信 row: "未绑定" in gray / "已绑定" in green, chevron right
- Apple ID row: "已绑定" in green, chevron right

Section header: "我的主机"
- List of registered daemons (same card style as daemon list, compact)
  - Each: hostname + status dot + "在线"/"离线"
  - Tap to see daemon detail / unregister
- "注册新主机" row with + icon

Section header: "订阅"
- Current plan: "免费版" gray badge or "专业版" blue badge
- "免费版: 1 台主机，基础监控" description in gray
- "升级专业版 ¥48/月" row with blue accent, chevron right
- Feature comparison: 无限主机 | 推送通知 | 实时消息

Section header: "其他"
- "帮助与反馈" row, chevron right
- "关于 pocketctl" row, chevron right
- "隐私政策" row, chevron right
- "用户协议" row, chevron right

Bottom:
- "退出登录" row, red text (#f85149), centered

Style: iOS grouped table view, dark theme.
Background: #0d1117. Cell backgrounds: #161b22. Separators: #21262d.
SF Pro Text throughout. Respects safe areas.
```

---

## Logo 设计提示词

```
Generate an SVG logo for "pocketctl", a developer tool that lets programmers
remotely monitor and control AI coding agents from their phone.

Brand positioning: "Your coding agents, in your pocket."
A power tool for developers — professional, modern, minimal.

Requirements:

Logo mark concepts (pick the strongest):
1. A terminal prompt ">" symbol housed inside a rounded pocket/phone silhouette
2. A satellite dish receiving signals from code brackets "< />"
3. A simplified robot eye inside a rounded square with signal waves

Design rules:
- Flat, geometric, no gradients, no 3D effects
- Single color: accent blue #58a6ff (for dark bg) or solid white (for light bg)
- Must be recognizable at 16×16 (favicon), 32×32 (toolbar), 1024×1024 (App Store)
- Favor simplicity over cleverness — think Linear, Vercel, Raycast, Warp logos

Wordmark:
- "pocketctl" in lowercase, clean sans-serif (SF Pro Display or similar), weight 700
- Color: #58a6ff on dark, #0d1117 on light

Deliverables:
1. Logo mark only (square format)
2. Wordmark only
3. Combined horizontal lockup (logo mark left + wordmark right)
4. iOS App Icon: logo mark centered in rounded square
   with dark gradient background (center #0d1117 → edge #010409)

Also generate a dark-mode variant where the logo mark uses a subtle
blue glow effect (#58a6ff at 30% opacity shadow) for use on pure black backgrounds.
```

---

## 页面导航流程

```
启动页
  ↓
登录页（手机号验证码 / Apple Sign In）
  ↓
判断 Daemon 数量
  ├── 0 个 Daemon → 空状态引导页（安装指令）
  ├── 1 个 Daemon → 自动跳转到 Session 列表
  └── 2+ 个 Daemon → Daemon 列表 → 点选 → Session 列表
        ↓
  Session 列表 → 点选 → Session 详情（聊天监控）
        ↓                    ↓
  + 新建会话(底部弹窗)    恢复会话 / 发送消息
```

---

## 设计规范速查

| 元素 | 值 |
|------|-----|
| 深色背景 | `#0d1117` |
| 卡片/表面 | `#161b22` |
| 悬停/输入框 | `#1c2129` |
| 边框/分隔线 | `#21262d` |
| 品牌蓝/强调色 | `#58a6ff` |
| 主按钮绿 | `#238636` |
| 主要文字 | `#e6edf3` |
| 次要文字 | `#8b949e` |
| 三级文字 | `#484f58` |
| 用户气泡蓝 | `#1f6feb` |
| 错误红 | `#da3633` / `#f85149` |
| 成功绿 | `#22C55E` / `#3fb950` |
| 忙碌琥珀 | `#d29922` / `#EAB308` |
| 子智能体紫 | `#c084fc` on `#2d1a3e` |
| 圆角（小） | 6-8px |
| 圆角（中） | 12px |
| 圆角（大） | 16-20px |
| 标题字体 | SF Pro Display |
| 正文字体 | SF Pro Text |
| 代码字体 | SF Mono |

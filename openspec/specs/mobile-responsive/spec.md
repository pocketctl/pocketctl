## Purpose
pocketctl web 在移动端（手机浏览器，320px-768px）的响应式布局与触摸交互规范。

## ADDED Requirements

### Requirement: All pages adapt to mobile viewport
所有页面 SHALL 在 320px-768px 宽度范围内正常显示和交互，包括：
- Session 列表页：session 行自适应宽度，点击区域足够大（≥44px 高度）
- Session 详情页：消息气泡自适应宽度，输入框不遮挡内容
- 新建 session 弹窗：在小屏幕上全屏显示

#### Scenario: User opens session list on iPhone (375px width)
- **WHEN** 用户在 iPhone 浏览器打开 pocketctl
- **THEN** session 列表自适应宽度，每行显示 session ID、状态、时间，文字不溢出

#### Scenario: User opens session detail on mobile
- **WHEN** 用户在手机上打开 session 详情
- **THEN** 消息气泡最大宽度 90%，工具调用可折叠，底部输入框固定不遮挡消息

#### Scenario: User creates new session on mobile
- **WHEN** 用户在手机上点击 "+ New Session"
- **THEN** 弹窗全屏显示，表单字段垂直排列，虚拟键盘不遮挡提交按钮

### Requirement: Touch-friendly interaction targets
所有可点击元素的最小点击区域 SHALL 为 44×44px（符合 Apple HIG 和 Material Design 指南）。

#### Scenario: Tapping a session row on mobile
- **WHEN** 用户在手机上点击 session 行
- **THEN** 点击区域覆盖整行（高度 ≥44px），不会误触相邻行

## 1. Relay — 腾讯云 SES 集成

- [x] 1.1 安装腾讯云 SES SDK (`tencentcloud-sdk-nodejs-ses`) 到 `relay/package.json`
- [x] 1.2 创建 `relay/src/config/email.ts`，实现 `sendEmailCode(email, code)` 函数，复用 `COS_SECRET_ID`/`COS_SECRET_KEY` 凭据
- [x] 1.3 在 `relay/src/server.ts` 中新增 `POST /api/auth/email/send` 端点（含 rate limiting）
- [x] 1.4 在 `relay/src/server.ts` 中新增 `POST /api/auth/email/verify` 端点（含自动注册新用户）
- [x] 1.5 抽取 SMS 和 Email 验证码的公共存储/验证逻辑到 `relay/src/config/verification.ts`
- [x] 1.6 标记 `POST /api/auth/login`（邮箱+密码）为 deprecated，响应头加 `Deprecation: true`

## 2. Relay — 验证码公共模块

- [x] 2.1 创建 `relay/src/config/verification.ts`，统一验证码存储（`codeStore` Map）、生成、过期、清理逻辑
- [x] 2.2 重构 `POST /api/auth/sms/send` 和 `POST /api/auth/sms/verify` 使用公共模块
- [x] 2.3 重构 `POST /api/auth/email/send` 和 `POST /api/auth/email/verify` 使用公共模块
- [ ] 2.4 添加单元测试 `relay/src/__tests__/verification.test.ts`

## 3. Web — 设计系统集成

- [x] 3.1 复制 `web-shared.css` 到 `web/src/assets/` 并在 `index.html` 中引入
- [x] 3.2 删除 `LoginView.vue`、`SessionList.vue`、`SessionDetail.vue`、`App.vue` 中的 scoped style，改为引用 CSS 变量
- [x] 3.3 在 `App.vue` 中添加主题管理逻辑（`data-theme` 切换、`localStorage` 持久化、系统主题跟随）
- [x] 3.4 配置 `vite.config.ts` 使 `web-shared.css` 和 assets（logo SVG）在构建时可正确引用

## 4. Web — 登录页重写

- [x] 4.1 重写 `LoginView.vue`：双 Tab（手机号/邮箱）、品牌区（Logo+名称+标语）、卡片式表单
- [x] 4.2 实现手机号登录 Tab：+86 前缀、11 位手机号输入、6 位验证码输入、获取验证码按钮
- [x] 4.3 实现邮箱登录 Tab：邮箱输入（含 `@gmail.com` 后缀）、6 位验证码输入、获取验证码按钮
- [x] 4.4 实现验证码倒计时 composable `useCountdown.ts`（60 秒倒计时、按钮禁用/启用、文本更新）
- [x] 4.5 实现错误横幅组件（红色背景、错误图标、消息文本）
- [x] 4.6 扩展 `useAuth.ts`：新增 `loginViaPhone(phone, code)` 和 `loginViaEmail(email, code)` 方法
- [x] 4.7 实现主题自适应 Logo（深色/浅色切换时自动替换 Logo 图片）
- [x] 4.8 实现社交登录按钮占位区（Apple/GitHub/微信图标 + "即将开通" 提示）

## 5. Web — 仪表盘页新增

- [x] 5.1 创建 `DashboardView.vue`：侧栏导航 + 主内容区布局
- [x] 5.2 实现 Daemon 卡片网格：主机图标、名称、别名、Session 数、在线状态指示器
- [x] 5.3 实现别名内联编辑：点击别名 → 输入框 → Enter/失焦保存 → 一键恢复默认
- [x] 5.4 实现快捷统计卡片：在线主机数、活跃 Session 数、Sub-agent 总数
- [x] 5.5 实现 Session 列表表格：标题、来源标签（终端/Web）、主机名、状态、最后活跃时间
- [x] 5.6 实现 Session 行点击导航到 `/session/:id`
- [x] 5.7 实现"新建 Session"按钮和对话框（复用 `NewSessionDialog.vue`）
- [x] 5.8 实现空状态提示：无在线主机时显示引导文案

## 6. Web — Session 详情页重写

- [x] 6.1 重写 `SessionDetailView.vue`：三栏布局（Session 列表 + 聊天区 + 工具调用面板）
- [x] 6.2 实现聊天消息流：用户消息气泡、Claude 回复气泡、流式文本追加、打字指示器
- [x] 6.3 实现工具调用卡片：可折叠、工具名图标、输入/输出参数、状态标签
- [x] 6.4 实现消息输入区：多行文本输入、Enter 发送、Session 退出/离线时禁用
- [x] 6.5 实现退出横幅（Exit Banner）：Session 退出时显示退出原因、"Resume Session"按钮
- [x] 6.6 实现离线横幅（Disconnected Banner）：Daemon 离线时显示、连接恢复后自动清除
- [x] 6.7 实现 Session 生命周期时间线组件（复用 `SessionTimeline.vue`）

## 7. Web — 设置页新增

- [x] 7.1 创建 `SettingsView.vue`：左侧垂直 Tab 导航 + 右侧内容面板
- [x] 7.2 实现账户设置 Tab：显示绑定的手机号/邮箱、注册时间、退出登录按钮
- [x] 7.3 实现主机管理 Tab：所有 Daemon 列表（在线/离线）、别名编辑、最后在线时间
- [x] 7.4 实现外观设置 Tab：主题选择器（深色/浅色/跟随系统）、实时预览
- [x] 7.5 实现通知设置 Tab：浏览器通知权限状态、通知类型开关

## 8. Web — 路由和导航

- [x] 8.1 更新 `main.ts` 路由表：`/` → DashboardView、`/login` → LoginView、`/session/:id` → SessionDetailView、`/settings` → SettingsView
- [x] 8.2 实现侧栏导航组件：Logo、导航项（仪表盘/设置）、当前路由高亮、折叠响应式
- [x] 8.3 更新路由守卫：未登录重定向到 `/login`，已登录访问 `/login` 重定向到 `/`

## 9. Daemon — Go API Client 扩展

- [x] 9.1 在 `internal/api/client.go` 中新增 `SendEmailCode(baseURL, email string) error`
- [x] 9.2 在 `internal/api/client.go` 中新增 `VerifyEmailCode(baseURL, email, code string) (accessToken, refreshToken string, err error)`
- [x] 9.3 添加单元测试 `internal/api/client_test.go` 对新增函数的测试

## 10. Daemon — CLI 多登录方式

- [x] 10.1 重构 `cmdLogin()`：打印登录方式选择菜单（[1] 手机号 [2] 邮箱）
- [x] 10.2 将现有手机号登录逻辑抽取为 `loginViaPhone(apiURL string) (accessToken, refreshToken string, err error)`
- [x] 10.3 实现 `loginViaEmail(apiURL string) (accessToken, refreshToken string, err error)` 函数
- [x] 10.4 统一 token 保存和成功/失败消息输出
- [x] 10.5 更新 `printUsage()` 帮助文本，反映新的多登录方式

## 11. 验证与测试

- [ ] 11.1 编写 Relay 邮件端点集成测试：发送验证码 → 用正确码验证 → 用错误码验证 → 过期码验证
- [x] 11.2 运行现有 Web 单元测试确保无回归（`web/src/**/__tests__/*.test.ts`）
- [x] 11.3 运行现有 Go 测试确保无回归（`go test ./...`）
- [ ] 11.4 手动验证完整登录流程：Web 手机号登录 → Web 邮箱登录 → Daemon CLI 邮箱登录
- [ ] 11.5 验证多端同时登录：iOS App + Web + Daemon 使用同一账号同时在线

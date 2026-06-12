## Why

Web 版 UI 功能不完整、设计过时，认证方式仅支持邮箱+密码，与 iOS App（手机号 SMS 验证码）不一致。同时，为海外推广做准备，需要增加邮箱验证码登录方式，让 Daemon 和 Web 端都能用邮箱登录。统一所有端的认证为"验证码模式"，废弃密码登录，简化安全模型。

## What Changes

- **BREAKING**: 移除邮箱+密码登录方式（`/api/auth/login`），改为邮箱验证码登录
- 新增邮箱验证码认证能力：Relay 新增 `/api/auth/email/send` + `/api/auth/email/verify` 端点
- Relay 集成腾讯云 SES 邮件发送服务（复用现有 SMS 的 `COS_SECRET_ID`/`COS_SECRET_KEY` 凭据）
- Web 端按最新设计稿重写全部 4 个页面（登录、仪表盘、Session 详情、设置），统一使用 `web-shared.css` 设计系统
- Web 端登录改为手机号+邮箱双 Tab 验证码模式
- Daemon CLI `pocketctl login` 增加邮箱验证码登录方式
- 抽取 Relay 中 SMS 和 Email 验证码的公共逻辑

## Capabilities

### New Capabilities
- `email-verification-auth`: 邮箱验证码认证 — Relay 端点、腾讯云 SES 集成、Daemon CLI 交互、Web 端邮箱登录 Tab
- `web-dashboard`: Web 仪表盘页面 — Daemon 卡片列表、Session 列表、别名内联编辑、快捷统计，按最新设计稿实现
- `web-settings`: Web 设置页面 — 账户管理、主机管理、外观偏好（深色/浅色主题切换）、通知设置
- `web-login-redesign`: Web 登录页重设计 — 手机号+邮箱双 Tab 验证码登录、验证码倒计时、主题适配 Logo

### Modified Capabilities
- `web-ui`: 登录方式从邮箱+密码改为手机号+邮箱双验证码；新增仪表盘和设置页路由；CSS 体系迁移到 `web-shared.css` 设计系统

## Impact

- **Relay** (`relay/src/`): 新增 `auth.ts` 中邮箱验证码逻辑、`server.ts` 中新端点、腾讯云 SES SDK 集成、验证码存储公共模块
- **Web** (`web/src/`): 重写全部 views 和 components，引入 `web-shared.css`，`useAuth.ts` 扩展双模式，路由新增 `/settings`
- **Daemon** (`cmd/pocketctl/main.go`): `cmdLogin()` 重构为多登录方式选择
- **Go API Client** (`internal/api/client.go`): 新增 `SendEmailCode`、`VerifyEmailCode`
- **iOS**: 无需改动

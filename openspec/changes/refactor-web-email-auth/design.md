## Context

pocketctl 目前有三端：iOS App（SwiftUI，手机号 SMS 登录）、Web App（Vue 3，邮箱+密码登录）、Daemon CLI（Go，手机号 SMS 登录）。认证方式不统一，Web 端 UI 功能不完整，设计过时。

最新设计稿（`ui-design/pocketctl-design-system/web/`）提供了完整的 4 页面设计（登录、仪表盘、Session 详情、设置），包含深色/浅色双主题、CSS 变量驱动的设计系统。邮箱验证码登录的引入同时服务于：统一各端认证方式、为海外推广做准备。

### 当前架构

```
iOS App  ──HTTP──┐
                 ├── Relay (Fastify) ─── PostgreSQL
Web App ──WS/HTTP┘        │
                 ┌────────┘
Daemon ──WS─────┘
```

- **Relay 现有认证端点**: `/api/auth/register` (邮箱+密码), `/api/auth/login` (邮箱+密码), `/api/auth/sms/send`, `/api/auth/sms/verify`, `/api/auth/refresh`
- **Web 现有路由**: `/login`, `/` (SessionList), `/session/:id` (SessionDetail)
- **Daemon 现有登录**: `pocketctl login` → 手机号 + SMS 验证码 → 保存 JWT 到 `~/.pocketctl/auth.json`

## Goals / Non-Goals

**Goals:**
- 统一所有端的认证方式为验证码模式（手机号 SMS + 邮箱 Email）
- Relay 新增邮箱验证码端点，集成腾讯云 SES 发送邮件
- Web 端按设计稿重写全部页面，使用 `web-shared.css` 设计系统
- Daemon CLI 支持邮箱验证码登录
- 废弃密码登录（`/api/auth/login`），简化安全模型
- 多端可同时独立登录（JWT 无状态）

**Non-Goals:**
- 不新增 Google/Apple/微信等社交登录（为 Daemon 部署在无图形 Linux 服务器考虑）
- 不改变 iOS App 的登录方式
- 不改变 WebSocket 协议（`protocol/types.go` 和 relay router 的消息路由不变）
- 不修改数据库核心表结构（`users` 表仅新增可选列）

## Decisions

### 1. Web 技术栈：Vue 3 + web-shared.css 混合方案

**选择 C（混合方案）而非 A（纯 Vue）或 B（纯 HTML）**

| 考量 | 决策 |
|------|------|
| CSS 体系 | 直接复用设计稿的 `web-shared.css`（60 个 CSS 变量），不翻译到 scoped style |
| 组件架构 | 保留 Vue 3 的 SFC + composable 模式（`useAuth`, `useWebSocket` 已通过测试） |
| 交互逻辑 | Tab 切换、验证码倒计时等纯 UI 交互可内联在 template 中，复杂状态管理用 Vue |

**替代方案被拒绝原因：**
- A（纯 Vue）: 将设计稿的 CSS 变量翻译为 Vue scoped style 是低价值的重复劳动
- B（纯 HTML）: Session 详情页的实时聊天、WebSocket 流式消息、工具调用卡片等强交互场景，vanilla JS 维护成本高

### 2. 邮箱服务：腾讯云 SES

**选择腾讯云 SES 而非 Resend/SendGrid/AWS SES**

核心理由：
- Relay 已集成腾讯云 SMS SDK（`relay/src/config/sms.ts`），共用同一套 `COS_SECRET_ID`/`COS_SECRET_KEY` 凭据，零额外认证配置
- 对 QQ/163 邮箱送达率 97%+（同生态天然优势），对 Gmail/Outlook 也有良好送达率
- 按量单价 ¥0.3/千封，新用户首月 10 万封免费
- 海外邮箱送达率约 97%，满足海外推广需求

**替代方案被拒绝原因：**
- Resend: API 最好用，但对 QQ/163 邮箱送达率堪忧（海外发件 IP 易被归类垃圾邮件）
- SendGrid: 2025 年取消永久免费层，最低 $19.95/月
- AWS SES: 需自建 bounce/complaint 处理管道、IAM 配置、沙盒审批

### 3. 验证码存储：内存 + 可选 Redis

沿用现有 SMS 验证码的内存存储模式（`smsCodeStore` Map），Email 验证码同理。未来可统一迁移到 Redis 以支持 Relay 多实例部署。

### 4. 废弃密码登录策略

`/api/auth/login`（邮箱+密码）保留但标记 deprecated，过渡期后移除。`users.password_hash` 列保留但不再写入。

### 5. Daemon CLI 多登录方式：函数抽取 + 选择菜单

`cmdLogin()` 重构为：打印选择菜单 → 根据选项调用 `loginViaPhone()` 或 `loginViaEmail()`。两者共享 token 保存逻辑。`internal/api/client.go` 新增 `SendEmailCode` 和 `VerifyEmailCode` 两个函数，与现有 `SendSMS`/`VerifySMS` 结构镜像。

### 6. Web 路由设计

```
/login              → LoginView (新增: 双 Tab 验证码)
/                   → DashboardView (新增: Daemon 卡片 + Session 列表)
/session/:id        → SessionDetailView (重写: 三栏布局)
/settings           → SettingsView (新增: 账户/主机/外观)
```

## Risks / Trade-offs

- **[风险] 腾讯云 SES 对海外邮箱（Gmail/Outlook）的送达率不如国内邮箱** → 灰度发布时监控 bounce rate，必要时叠加 Resend 做海外邮件路由
- **[风险] 验证码存储在内存在 Relay 重启时丢失** → 验证码有效期仅 5 分钟，影响可控；后续可迁移到 Redis
- **[风险] 废弃密码登录对老 Web 用户是 breaking change** → 过渡期保留端点，前端先切换，后端 1-2 个月后移除
- **[权衡] Vue 3 + 外部 CSS 混合方案的 CSS 作用域管理** → Vue 组件用全局 class 命名（BEM 风格），不使用 scoped style；web-shared.css 通过 `<link>` 在 index.html 中引入

## Migration Plan

### Phase 1: Relay 后端（无 breaking change）
1. 集成腾讯云 SES SDK
2. 新增 `/api/auth/email/send` + `/api/auth/email/verify`
3. 抽取 SMS/Email 验证码公共模块
4. 标记 `/api/auth/login` 为 deprecated

### Phase 2: Web 前端
1. 引入 `web-shared.css`，删除现有 scoped style
2. 重写 LoginView（双 Tab 验证码）
3. 新增 DashboardView
4. 重写 SessionDetailView（三栏布局）
5. 新增 SettingsView
6. 更新路由和 useAuth

### Phase 3: Daemon CLI
1. `internal/api/client.go` 新增 `SendEmailCode`、`VerifyEmailCode`
2. `cmdLogin()` 增加登录方式选择
3. 更新 `pocketctl login` 帮助文本

### Rollback
- Relay 新端点是纯新增，不影响现有功能，可直接回滚
- Web 前端通过 git revert 回滚到旧版 Vue 代码
- Daemon CLI 回滚 `cmdLogin()` 到单模式

## Open Questions

- 验证码邮件模板内容（中英双语？仅中文？）
- 腾讯云 SES 发件域名配置（使用哪个域名作为发件地址？）
- 是否需要验证码发送频率限制（同一邮箱/IP 的 rate limiting）？

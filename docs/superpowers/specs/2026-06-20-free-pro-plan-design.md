# 免费版 / 付费版 分界方案 — 设计文档

**日期**：2026-06-20
**版本**：v1
**状态**：方案已确认，待实施

---

## 1. 背景

pocketctl 采用混合模式运营：

- **SaaS**：用户连接托管 Relay，按 tier 分层
- **Self-hosted**：用户自己部署，全部功能可用

目标：为 SaaS 模式建立清晰的免费/付费分界线，同时保证开源自部署用户不受影响。

---

## 2. 权益分界线

| 维度 | 免费版（free） | 付费版（pro） |
|------|---------------|--------------|
| 并发会话 | 2 个 | 10 个 |
| 历史记录保留 | 7 天 | 永久（`retention_days: -1`） |
| 主机数 | 不限 | 不限 |
| 推送通知 | 仅 `error_only`（Agent 报错） | `all`（全量推送） |
| 数据导出 | 无 | ✅ |
| Agent 类型 | ✅ | ✅ |
| Token 看板 | ✅ | ✅ |

---

## 3. 技术方案

**选型：结构化权益配置（方案 B）。** 权益定义在配置文件中，运行时根据 `users.plan` 字段匹配。Plan 变更即时生效，无需用户重新登录。

### 3.1 配置文件

`relay/plans.yaml`：

```yaml
mode: saas  # 'saas' | 'self-hosted'

plans:
  free:
    max_concurrent_sessions: 2
    retention_days: 7
    push_notifications: error_only
    data_export: false
    max_daemons: 1

  pro:
    max_concurrent_sessions: 10
    retention_days: -1
    push_notifications: all
    data_export: true
    max_daemons: 5
```

### 3.2 权益检查流程

```
请求到达 → JWT 验证（user.id）
         → 查 DB：SELECT plan FROM users WHERE id = ?
         → getPermissions(plan, mode) 返回权益值
         → 按权益 key 判断是否放行
```

**设计要点：**
- 每次请求查 DB `users.plan`（主键查询，<1ms），不放在 JWT 中 — Plan 升级即时生效
- `mode: self-hosted` 时，忽略 `users.plan`，统一返回 pro 权益
- 权益值从配置文件读取，不做数据库查询

### 3.3 数据库

**无需新增字段或表。** 已有：

- `users.plan VARCHAR(16) DEFAULT 'free'` — 已存在于 `db.ts:99`
- `users.max_daemons INT DEFAULT 1` — 保留，实际值由 plans 配置覆盖
- `getUserPlanAndWhitelist()` 函数已存在

---

## 4. 权益检查点

| 权益 | 检查位置 | 说明 |
|------|---------|------|
| `max_concurrent_sessions` | Session 创建路由 | 查用户当前 `running`/`busy` 会话数 vs 上限 |
| `retention_days` | 定时清理任务 `cleanStaleEvents()` | 目前硬编码 90 天，改为按 plan 动态传入 |
| `push_notifications` | 推送逻辑 | `error_only` 时只推 Agent 报错 |
| `data_export` | 新增导出路由 | 检查权益后放行 |
| `max_daemons` | Daemon 注册路由 | 已有逻辑，值改为从配置读取 |

---

## 5. 实施步骤

| 步骤 | 内容 | 依赖 |
|------|------|------|
| 1 | 新增 `relay/plans.yaml` + `relay/src/plans.ts`，启动时加载配置 | — |
| 2 | 接入现有权益点（`max_daemons`、`retention_days`、并发检查） | 1 |
| 3 | 新增付费功能（推送分级、数据导出 API） | 2 |
| 4 | 自部署模式检测（`POCKETCTL_MODE=self-hosted` 环境变量） | 1 |

### 改动文件清单

| 文件 | 操作 |
|------|------|
| `relay/plans.yaml` | 新增 |
| `relay/src/plans.ts` | 新增 |
| `relay/src/index.ts` | 改（加载配置 + 并发检查 + 导出路由） |
| `relay/src/db.ts` | 改（`cleanStaleEvents` 动态天数） |
| 推送逻辑文件 | 改（按 plan 过滤通知类型） |

**不改：** 数据库 migration（`users.plan` 字段已存在）、前端（上线后根据反馈决定）

---

## 6. 扩展性

### 新增套餐（如 Max）

- `plans.yaml` 加一个 `max` block
- `users.plan` 允许 `'max'` 值
- 消费端代码无改动（`getPermissions()` 根据 plan 自动匹配）

### 新增权益项

- `plans.yaml` 每个 tier 加一行
- 消费端加对应 UI / 逻辑

**核心原则：权益定义和权益消费解耦。配置文件只管"什么套餐有什么"，代码不知道有几个套餐。**

---

## 7. 建议定价

国内 SaaS 模式，面向个人开发者：

| | 月付 | 年付 |
|------|------|------|
| Pro | ¥19 / 月 | ¥149 / 年（≈¥12.4/月） |

定价逻辑：¥19 与微信读书等国内开发者常用订阅平齐，一杯奶茶钱。年费 ¥149 对标一个买断 App 的价格，符合国内用户习惯。出海时映射为 $8/月。

## 8. V1 边界

- V1 不做管理后台（改 plan 直接在 DB 操作）
- V1 不做计费系统（Stripe 等，后续独立设计）
- 自部署用户始终享受 pro 权益

---

## 9. 同期讨论但不做的方向

以下方向在本次头脑风暴中讨论后决定不实施：

| 方向 | 结论 |
|------|------|
| 会话记录搜索 | ROI 低。用户通常只看结论，重复工作让 Agent 重新执行即可 |
| Skill 跨会话/跨机器管理 | 真实但低频。本质是文件同步问题，与 pocketctl 核心价值无关 |
| 团队版 | 伪命题。pocketctl 核心价值是"个人远程监控自己的 Agent"，团队场景无真实痛点 |
| 会话 AI 总结 | Claude Code 已自行完成总结 + 选项，额外加工无增量价值 |
| 代码 Diff | 有用但不改变核心体验，可后续评估 |

---

## 10. 产品定位结论

经过对商业模式、用户价值、市场空间的多角度讨论，pocketctl 的最终定位：

> **一个好工具 + 小额副业。**
>
> 开源 + 自部署模式下全功能可用，社区受益。
> SaaS ¥19/月 — 有人付费是惊喜，没人付费也不焦虑。
> 不指望它成为规模化商业产品。

pocketctl 精准地解决了一个窄而真实的个人痛点——"离开电脑后保持对 AI Agent 的控制和交互"——这是它的核心价值。但该价值不具备自然的商业扩展空间，目标用户群体本身较小。商业野心将放在其他项目中。

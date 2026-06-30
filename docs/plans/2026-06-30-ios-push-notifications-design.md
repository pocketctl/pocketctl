# iOS Push Notifications — 整体设计与分级规划

> 日期:2026-06-30
> 状态:设计已定稿(方向:A/B/C1 免费、D 类 Pro),待实现
> 范围:relays 端推送触发点 + iOS 端深链/能力补全 + 免费/Pro 分级门控

---

## 0. 背景与现状(关键前提)

推送**基础设施已就绪且生产可用**,真正缺口只有"触发点不全"。

### 已就绪的部分
- **iOS 端** `ios/Pocketctl/Services/PushService.swift`:权限请求 / APNs 注册 / token 上报。
- **iOS 端** `ios/Pocketctl/App/PocketctlApp.swift:14-55`:`AppDelegate` 已实现 `UNUserNotificationCenterDelegate`(前台弹 banner、点击深链)。
- **iOS 设置开关** `ios/Pocketctl/ViewModels/SettingsViewModel.swift:279-302`:`toggleNotifications` 完整闭环。
- **relay 端** `relay/src/push.ts`:生产级实现(http2 直连 APNs、`.p8` JWT 鉴权、失效 token 自动清理);`notifyUser(pool, userId, payload)` 可直接复用。
- **设备表** `relay/migrations/002_devices_push.sql` + DB 函数(`db.ts:624-654`)。
- **REST 注册端点** `server.ts:288 /api/devices/register`。

### 当前的缺口(本设计要解决的)
1. **核心缺口**:`approval_request` / `interactive_prompt` 在 relay 端**不触发推送**。iOS 端只有"前台 + 停留在该会话页"时才靠 WebSocket 收到;一旦 app 后台/被杀或切到别的页面,**审批就静默丢失 → agent 卡死**。
2. **iOS 配置待补**:`Info.plist` 缺 `UIBackgroundModes: remote-notification`;仓库无 `.entitlements` 文件(`aps-environment`)。
3. **深链待扩展**:`PocketctlApp.swift:44-54` 只处理 `session_id`,审批类推送需支持 `type=approval` + `request_id` 直达审批卡。
4. **分级门控缺失**:已有 `plan` 字段(free/pro)和 `getUserPlanAndWhitelist`,但推送尚未做 plan 判断。

### 现有等级体系(承接,不另起炉灶)
- DB `users` 表已有 `plan VARCHAR(16) DEFAULT 'free'`、`whitelist BOOLEAN`、`max_daemons`(`relay/src/db.ts:100-101,195`)。
- 当前唯一等级差异:**免费版只能 1 台在线 daemon**(`router.ts:78`)。
- ⚠️ **目前没有任何支付系统**(无 StoreKit/RevenueCat/Stripe),`plan` 只能手动改库。本设计**不引入支付**,仅做"功能门控"的占位,支付后接入。

---

## 1. 推送场景全景

按"产品价值 × 紧急程度"分 4 类。

### A. 审批与交互类 ⚡ — 实时刚需,产品命脉
| ID | 场景 | 触发 | 现状 | 优先级 |
|---|---|---|---|---|
| **A1** | 审批请求 | `approval_request` | ❌ 未推送 | **P0** |
| **A2** | 交互式输入 | `interactive_prompt` | ❌ 未推送 | P1 |

### B. 会话生命周期类 📦 — 任务完结
| ID | 场景 | 触发 | 现状 | 优先级 |
|---|---|---|---|---|
| B1 | 会话正常完成 | `status=completed` | ✅ 已推送 | — |
| B2 | 会话报错终止 | `status=error` | ✅ 已推送 | — |
| B3 | 会话被杀/退出 | `status=killed/exited` | ✅ 已推送 | — |
| B4 | 长时间空闲提醒 | `idle` 超 N 分钟 | ❌ 未实现 | P3 |

### C. 基础设施类 🔌 — 连接健康
| ID | 场景 | 触发 | 现状 | 优先级 |
|---|---|---|---|---|
| **C1** | Daemon 掉线 | 电脑离线/崩溃 | ✅ 已推送(`router.ts:310`) | — |
| C2 | Daemon 重新上线 | 电脑恢复 | ❌ 未实现 | P2 |

### D. 增值洞察类 📊 — 差异化变现
| ID | 场景 | 触发 | 现状 | 优先级 |
|---|---|---|---|---|
| **D1** | 每日 Token 日报 | 定时(如 22:00) | ❌ 未实现 | P2 |
| **D2** | 每周会话周报 | 定时(每周一) | ❌ 未实现 | P2 |
| **D3** | 高危操作即时提醒 | `rm`/`force push`/删文件 | ❌ 未实现 | P2 |
| **D4** | 自定义关键词规则 | 用户配置关键词 | ❌ 未实现 | P3 |

---

## 2. 免费 vs Pro 分级(已确认方向)

**原则:保住核心体验不卡 agent,用增量洞察变现。**

| 类别 | 🆓 免费用户 | ⭐ Pro 用户 |
|---|---|---|
| **A 审批/交互** | ✅ **全开放**(命脉) | ✅ 全开放 + 高优先级/不折叠 |
| **B 会话完结** | ✅ 全开放 | ✅ 全开放 |
| **C1 daemon 掉线** | ✅ 开放 | ✅ 开放 |
| C2 daemon 上线 | ❌ | ✅ |
| **D 洞察/日报/周报/规则** | ❌ | ✅ 全部 |

> ⚠️ **额度制陷阱**:不对 A 类(审批)做条数限额。审批是刚需,超额即卡死 agent,会激怒用户。额度制只适合 D 类(如"日报每月前 7 天免费")。

> ✅ **分级门控实现位置**:在 relay 端 `notifyUser()` 调用**之前**加 plan 判断(读 `getUserPlanAndWhitelist`),free 用户跳过 D 类。门控集中在 relay,客户端只做 UI 提示。

---

## 3. 技术架构

### 3.1 数据流

```
Agent 需要审批 ──→ Daemon(PreToolUse hook)
   │
   ▼ WebSocket
Relay(router.ts 接收事件)
   │
   ├─→ 持久化(已有)
   ├─→ 转发给已订阅该 session 的在线客户端(已有,WS)
   └─→ 【新增】触发推送:
         ├─ 读事件所属 userId
         ├─ 读该用户 plan/whitelist
         ├─ 按 plan 决定是否推、推什么 payload
         └─ notifyUser() → APNs → 用户设备
```

### 3.2 推送 payload 规范

所有 payload统一带 `sessionId`,审批类额外带 `type` 和 `requestId`,供 iOS 深链分发:

```jsonc
// A1 审批请求
{
  "aps": {
    "alert": { "title": "需要你的审批", "body": "<tool> 想执行 <动作>" },
    "sound": "default",
    "category": "APPROVAL",        // 供 iOS 注册 action button(可选 Pro)
    "thread-id": "session-<id>"    // 同会话折叠,Pro 可设不折叠
  },
  "sessionId": "<id>",
  "type": "approval",
  "requestId": "<id>"
}

// A2 交互输入(同样结构,type=interactive)
// D1 日报(type=summary, target=dailyReport) ...
```

### 3.3 分级门控的判定顺序(relay 端)

```
事件到达 → 是否该用户主动触发的会话?(是 → 该用户是 owner)
   → 取 owner 的 (plan, whitelist)
   → 按下表决定 push 行为:
```

| 场景 | free 推送? | Pro 推送? |
|---|---|---|
| A1/A2 | ✅ alert + sound | ✅ + category/action |
| B1/B2/B3 | ✅ | ✅ |
| C1 | ✅ | ✅ |
| C2 | ❌ | ✅ |
| D1-D4 | ❌ | ✅ |

---

## 4. 落地实现计划(分阶段)

### P0 — 审批推送 + iOS 能力补全(最高优先级,1-2 天)

**目标:补上最关键的审批场景,让 agent 不再因收不到通知而卡死。**

**relay 端:**
- [ ] `relay/src/push.ts`:新增 `approvalPush(sessionId, requestId, toolName, summary)` payload 构造器(仿 `:177` `sessionStatusPush`)。
- [ ] `relay/src/router.ts`:在通用事件通路(`:630-668`)对 `approval_request` 类型,额外调 `notifyUser()`。**关键**:推给**该 session owner 的所有设备**,不限于已订阅的在线客户端(查 session → userId → devices)。
- [ ] 同理处理 `interactive_prompt`(A2,或放 P1)。

**iOS 端:**
- [ ] `ios/Pocketctl/Info.plist`:加 `UIBackgroundModes` → `remote-notification`。
- [ ] 新建 `.entitlements`,加 `aps-environment`(dev: `development`,发布: `production`)。
- [ ] `ios/Pocketctl/App/PocketctlApp.swift:44-54`:深链扩展——识别 `type=approval` + `requestId`,直达该会话审批卡(滚动定位 + 高亮)。

**验证**:
- 真机或 Dev Push:发起一次会话让 agent 请求审批 → app 在后台 → 收到推送 → 点击直达审批卡 → Yes/No 回复成功。
- 测试 relay `APNS_KEY_PATH` 为空时走"只打日志"的开发态(`push.ts:134`)。

### P1 — 交互式输入推送 + 推送去重(1 天)

- [ ] A2 `interactive_prompt` 推送触发点(若 P0 未含)。
- [ ] **去重**:同一 `requestId` 在短时间内(如 30s)只推一次,避免 WS 重连/事件重放导致重复推送(在 relay 端用内存 LRU 或 Redis 记 `requestId` 已推过)。

### P2 — 增值类 + 上线通知(Pro 专属,2-3 天)

- [ ] C2 daemon 上线推送(`router.ts` 连接建立处)。
- [ ] D1 日报:relay 端定时任务(可用 `node-cron` 或现有定时机制),22:00 按 user 时区汇总当日 token 消耗。
- [ ] D2 周报。
- [ ] D3 高危操作:在审批事件里检查 `toolName`/参数,命中危险模式(`rm -rf`、`git push --force`、`DELETE` 文件)即额外标记优先级。
- [ ] **分级门控**:上述全部在调用前读 `getUserPlanAndWhitelist`,free 跳过。

### P3 — 自定义规则 + 体验打磨(按需)

- [ ] D4 自定义关键词:新表 `push_rules(user_id, keyword, created_at)`,relay 端在会话输出流里匹配。
- [ ] B4 长时间空闲提醒。
- [ ] Pro 审批推送的 **action button**(Accept/Deny 直接在通知里回复,用 `UNNotificationCategory`)。
- [ ] 推送偏好设置页(iOS):用户可开关每一类推送(本地存 UserDefaults,但**门控仍以 relay 为准**)。

---

## 5. 风险与注意事项

1. **审批推送幂等性**:WS 重连或事件重放会重复触发。P1 必须做 `requestId` 去重,否则用户被轰炸。
2. **离线 token 失效**:`notifyUser` 已有 410/400 自动清理(`push.ts` 的 `sendPushNotification:144`),无需额外处理。
3. **不打扰**:同一会话连续多次审批,用 `thread-id` 折叠;夜间(按用户时区)降级为静默或合并。Pro 可解锁"不折叠"。
4. **Pro 门控的可绕过性**:门控只在 relay,客户端没有"伪造 Pro"的风险(推送由服务端决定)。但 iOS 设置页若把 D 类开关显示给免费用户,点击应提示"升级 Pro"。
5. **支付未接入前**:所有用户 `plan` 默认 `free`,D 类对所有人不可用属正常。可临时用 `whitelist` 给内测用户开 D 类体验。
6. **APNs 双环境**:`APNS_ENVIRONMENT` 配置(`push.ts:24`),开发用 sandbox,上架切 production。`.entitlements` 的 `aps-environment` 要与之匹配。

---

## 6. 不在本期范围(YAGNI)

- 支付系统(StoreKit / RevenueCat / Stripe)—— 等分级验证有价值再接入。
- Web 端的 Web Push(Notification API)—— 本期只 iOS。
- 推送内容的富媒体(图片/LRU 缩略图)—— 审批场景文字够用。
- 推送 A/B 测试 / 发送时间优化。

---

## 附录:核心文件清单

**relay 端(改动重点):**
- `relay/src/push.ts` — 新增 payload 构造器 + 复用 `notifyUser`
- `relay/src/router.ts`(:630-668 通用通路,:310 掉线,:655 终态)— 新增审批/交互触发点
- `relay/src/db.ts`(:439-468 plan 读取)— 门控查询

**iOS 端:**
- `ios/Pocketctl/Info.plist` — 加 `UIBackgroundModes`
- `ios/Pocketctl/App/PocketctlApp.swift`(:44-54)— 深链扩展
- 新增 `*.entitlements` — `aps-environment`
- `ios/Pocketctl/Services/PushService.swift`(已就绪)— 无需改动

**配置:**
- 环境变量:`APNS_KEY_PATH` / `APNS_KEY_ID` / `APNS_TEAM_ID` / `APNS_BUNDLE_ID` / `APNS_ENVIRONMENT`(`push.ts:20-24`)

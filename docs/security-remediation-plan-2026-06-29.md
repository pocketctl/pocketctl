# pocketctl 安全分析复核结论与修复方案

| 项目 | 内容 |
|------|------|
| 文档性质 | 对《pocketctl 网络架构安全分析报告》的代码级复核 + 可落地修复顺序 |
| 复核方式 | 逐条对照 `develop` 分支当前代码核实 |
| 复核范围 | `relay/src/{router,server,db,auth}.ts`、`internal/ws/client.go`、`docker-compose.prod.yml`、`relay/.env.example` |
| 日期 | 2026-06-29 |
| 分支 | develop |
| 关联文档 | `docs/security-analysis-2026-06-29.md`（原始分析报告） |

---

## 一、复核结论

原报告**整体准确度高（约 95%）**，核心两条 🔴 严重越权属实。需订正一条 🟡 中危结论（方向写反），并说明行号已漂移（报告基于较旧版本）。

### 1.1 确认属实

| 报告结论 | 复核 | 当前真实位置 |
|---|---|---|
| replay 历史回放无属主校验 | ✅ 确认 | `handleReplay` `router.ts:756`，直接 `getEventsAfter`，无 `isSessionOwnedByUser` |
| 通用 client→daemon 路由无属主校验 | ✅ 确认 | `router.ts:722-753` `if (msg.session_id)` 只查 session 属哪个 daemon，不校验属于哪个 user。`user_message/session_kill/session_interrupt/set_permission_mode/set_effort` 全走这里 |
| `listSessions` 无 userId 返回全库 | ✅ 确认 | `db.ts:295` SQL 无 `user_id` 过滤；`router.ts:808` null 分支命中 |
| `removeDevice` 不校验属主 | ✅ 确认 | `db.ts:607` `DELETE ... WHERE device_token=$1`；`server.ts:316` 不带 userId |
| JWT 走 URL query | ✅ 确认 | `ws/client.go:239` `q.Set("token", c.token)` |
| REST 全部不查吊销 | ✅ 确认 | REST handler 一律 `verifyAccessToken`（无 revocation），仅 WS `server.ts:1060` 用 `verifyAccessTokenWithRevocation` |
| CORS `origin:true` 兜底 | ✅ 确认 | `server.ts:64` `ALLOWED_ORIGINS` 空时 `origin: true` |
| API key 非常量时间比较 | ✅ 确认 | `server.ts:1069` `apiKey === API_KEY` |
| `sameUser(null,null)=true` | ✅ 确认 | `router.ts:944-947` |
| relay 写库 fire-and-forget | ✅ 确认 | `insertEvent(...).catch(console.error)` 全程不 await（`router.ts:561` 等） |
| 事件 90 天硬删 | ✅ 确认 | `db.ts:872` `cleanStaleEvents` |
| daemon_id 自报无绑定 | ✅ 确认 | `registerDaemon` 信任 `msg.daemon_id` |

### 1.2 需订正

**原报告第五节 #4「`forceKick` 传空 jti 会吊销该用户全部 token → 可被 DoS」—— 方向写反了。**

实际代码：`isTokenRevoked` 是 `WHERE jti = $1` **精确匹配**（`db.ts`），真实 access token 的 jti 都是 `randomBytes(16)` 非空值。`revokeToken(pool, '', userId, 'force_kick')`（`router.ts:921`）和新登录踢出（`router.ts:101`）插入的是 `jti=''` 的行，**永远匹配不到任何真实 token**。

真相相反：**forceKick 和「新设备登录踢旧设备」在令牌层根本没生效** —— 被踢的 daemon 拿原 token 在 24h 内可以直接重连。`revokeAllUserTokens` 自己的注释也承认 *"We can't revoke tokens without their jti"*（`db.ts:655`）。这比报告描述的「误吊销全部」**更严重也方向相反**：踢人 / 封禁当前无法在令牌层强制。

### 1.3 其它说明

- **行号漂移**：报告基于旧版本，replay 564→现 603/756，通用路由 683-714→现 722-753 等，结论不受影响。
- 数据韧性部分（daemon 无磁盘 spool、PG 无备份）结论成立，属架构取舍。

---

## 二、结合当前生产配置的可达性研判

生产配置默认已堵上一部分「高危」：

- `POCKETCTL_API_KEY` 在 `docker-compose.prod.yml:32` 默认空（标注「Legacy 可选」）。WS 匿名分支 `server.ts:1069` 为 `apiKey && API_KEY && apiKey === API_KEY` —— **API_KEY 为空时整条匿名登录被拒**（走 else → `close(4001)`）。
- 即：只要未单独设置 `POCKETCTL_API_KEY`，**「`listSessions` 全库泄露 + 匿名 replay」整条链当前不可达**。原报告标 🟠 高，在当前 usage 下为「未启用」。

**但两条 🔴 严重越权与配置无关 —— 任何注册账号（免费注册即可）都能触发**，这是当前真正暴露的攻击面：
- 注册任意账号 → 知道目标 `session_id` → `replay` 拉取他人完整对话（越权读）。
- 注册任意账号 → 向他人 `session_id` 发 `user_message` / `set_permission_mode` 等（越权写 / 注入 / 控制他人会话）。

---

## 三、修复顺序（按「当前能落地」分档）

### A 档：立即修，零兼容风险（核心）—— ✅ 已实现

| 编号 | 问题 | 改动 | 状态 |
|---|---|---|---|
| P0-1 | 统一 WS 授权闸门：replay 越权 + 通用路由越权 + subscribe 越权 | `handleClientMessage` 入口对任何带 `session_id` 的消息强制 `isSessionOwnedByUser`，匿名（userId=null）一律拒绝，`subscribedSessions.add` 移到校验之后 | ✅ `router.ts` |
| P0-3 | `removeDevice` 属主校验 | SQL 加 `AND user_id=$2`，返回是否命中；handler 传 `payload.userId`，未命中返回 404。APNs 失效清理走独立 `removeInvalidDeviceToken`（非用户态） | ✅ `db.ts`/`server.ts`/`push.ts` |

> 实现采用「全量闸门」而非白名单 SET：**所有**带 `session_id` 的 client 消息都过属主校验，比白名单更稳（不怕未列入的命令从通用路由漏过去）。
> 测试：`router.test.ts` 新增 4 条授权用例（越权 replay 被拒/不泄露、越权控制命令不下发、被拒会话不订阅事件流、匿名禁操作），全套 94 passed。

### B 档：改配置即可立即缓解 —— ✅ 已实现

- `POCKETCTL_API_KEY` 保持留空（`docker-compose.prod.yml` 默认空），匿名泄露链关闭。
- `ALLOWED_ORIGINS` 在 `docker-compose.prod.yml` 内置默认 `https://www.pocketctl.me,https://pocketctl.me`，关闭 CORS `origin:true` 兜底；`.env.example` 同步推荐值。
- nginx `access_log` 对 `?token=` 脱敏：新增 `map $request_uri $sanitized_uri` + `log_format pocketctl`，token 值替换为 `REDACTED`，其余参数保留（`deploy/nginx/pocketctl.conf`）。

### C 档：能修但需排期（动协议 / 碰客户端，需灰度 + 回归）—— ✅ 已实现

| 编号 | 问题 | 实现 | 状态 |
|---|---|---|---|
| P0-2 | 吊销失效（forceKick / 踢人令牌未生效，比报告更严重） | **无需加表**：复用已存在的 `daemons.active_token_jti`。新增 `revokeDaemonToken(daemonId,userId,reason)` 查出该 daemon 当前 jti 并精确吊销；`router.ts` 的 `new_login` / `force_kick` 两处由 `revokeToken(pool,'',...)`（空 jti 空操作）改为调它。**targeted 吊销，不波及用户 web/iOS 会话** | ✅ `db.ts`/`router.ts` |
| P1-2 | JWT 移出 URL | daemon（`client.go`）改用 `Authorization: Bearer` 头握手，不再 `?token=`；relay WS 握手优先读 `Authorization` 头，`?token=` 保留为老 daemon / 浏览器的兜底（浏览器无法设 WS 头，其日志暴露已由 B 档 nginx 脱敏覆盖）。relay 先于 daemon 部署，无 new-daemon×old-relay 组合 | ✅ `client.go`/`server.ts` |
| P1-3 | REST 统一查吊销 | server.ts 全部 19 处 REST `verifyAccessToken(...)` 改为 `await verifyAccessTokenWithRevocation(..., pool)`，吊销的 access token 不能再调 REST | ✅ `server.ts` |

> 关键决策：P0-2 放弃了原计划的「`user_token_revocations` 表 + token 带 iat 的用户级时间切断」方案 —— 那会**过度吊销**（踢一个 daemon 连带踢掉用户 web/iOS）。改用 per-daemon jti 精确吊销，语义更准、改动更小、无新表无迁移。
> 测试：`router.test.ts` 新增 1 条用例验证 forceKick 写入的是 daemon 真实 jti（非空串）。relay 全套 96 passed、tsc 通过；Go `go build ./...` + `go vet` 通过。
> 残留（后续）：浏览器 Web 客户端仍走 `?token=`（受 WS API 限制），已由 nginx 脱敏兜底；如需彻底移除可改用 `Sec-WebSocket-Protocol` 子协议（需 relay 端协商回显，单独评估）。

### D 档：韧性投资（非漏洞，单独立项）

- ✅ **关键事件写库重试**：新增 `db.persistEvent`（insertEvent + 5 次退避重试 100→300→900→2700ms，~4s 预算，永不抛），替换 router 中 7 处 `insertEvent(...).catch` 的 fire-and-forget。瞬时 DB 抖动（如部署时 PG 重启）不再静默丢事件。`relay/src/db.ts`/`router.ts`
- ✅ **daemon 磁盘 spool**：新增 `internal/ws/spool.go`，把未确认的 `outBuf` 以 NDJSON 落盘（enqueue 追加、ack-trim 时原子重写、启动时回放并从最高 seq 续号）。daemon **进程崩溃**不再丢未确认事件，重连按 seq 回放、relay 按 (daemon_id,seq) + event_hash 去重。默认开启，`POCKETCTL_SPOOL=0` 关闭；路径 `~/.pocketctl/spool/<daemonID>.log`。`internal/ws/{spool,client}.go`/`cmd/pocketctl/main.go`
- ⬜ PG 定时 `pg_dump` + 异地备份（编排层，未做）。
- ⬜ session 软删（`deleted_at`）替代物理删除（未做）。

- ✅ **ack-after-persist**：event_ack 水位由「已接收 high」改为「最高**已持久化且连续**的 seq」（`daemonSeq.persistedHigh` + `pending` 乱序补洞）。`persistAndAck` 只在 `persistEvent` **持久化成功**后才推进水位；`persistEvent` 耗尽重试改为 **reject**，此时不 ack → daemon 保留事件、重连重放。无持久化的控制/标题/状态事件即时 ack 以免阻塞。彻底闭合「先 ack 后持久化失败」窗口。`relay/src/{db,router}.ts`
  - 配套修复重连补洞：daemon 在 register 上报 `acked_seq`（崩溃重启时由 spool 最低 seq 推导），relay 据此 seed 水位；并在「首个收到的 seq」同步设地板（兼容不报 `acked_seq` 的老 daemon、以及 grace 窗口后我方条目已删的重连），杜绝「只重放未确认尾部 → 1..N 幽灵缺口卡死水位」。`internal/protocol/types.go`、`internal/ws/client.go`、`relay/src/router.ts`

> 测试：`spool_test.go` + `persist.test.ts`（重试成功 / 耗尽 reject）+ `router.test.ts` 新增 ack-after-persist（持久化完成前不 ack、完成后 ack）、连续水位、`acked_seq` seed、老 daemon 首-seq 地板。relay 106 passed；`go test ./internal/ws + protocol` 通过。
>
> 残留：PG 备份、session 软删仍未做（编排层，单独立项）。

---

## 四、P0-1 参考实现（统一授权闸门）

```ts
// router.ts —— 需要 session 属主校验的命令（凡操作既有 session 的）
private static readonly SESSION_OWNED_CMDS = new Set([
  'replay', 'user_message', 'session_kill', 'session_interrupt',
  'set_permission_mode', 'set_effort', 'session_delete', 'session_pin',
]);

async handleClientMessage(clientWs: WebSocket, msg: any): Promise<void> {
  const client = this.clients.get(clientWs);
  if (!client) return;

  // 闸门：任何带 session_id 且属"操作既有会话"的命令，先校验属主
  if (msg.session_id && Router.SESSION_OWNED_CMDS.has(msg.type)) {
    if (client.userId == null) {           // 匿名/API-key 连接禁止操作具体会话
      this.send(clientWs, { type: 'error', session_id: msg.session_id, error: 'forbidden' });
      return;
    }
    const owned = await db.isSessionOwnedByUser(this.pool, client.userId, msg.session_id).catch(() => false);
    if (!owned) {
      this.send(clientWs, { type: 'error', session_id: msg.session_id, error: 'session not found or not owned' });
      return;
    }
  }
  if (msg.session_id) client.subscribedSessions.add(msg.session_id);  // ← 校验之后才订阅
  // ... 既有分支不变 ...
}
```

## 五、P0-3 参考实现（removeDevice 属主校验）

```ts
// db.ts
export async function removeDevice(pool: pg.Pool, userId: number, deviceToken: string): Promise<boolean> {
  const r = await pool.query(
    `DELETE FROM devices WHERE device_token = $1 AND user_id = $2`, [deviceToken, userId]);
  return (r.rowCount ?? 0) > 0;
}
```

```ts
// server.ts:306  DELETE /api/devices/:token
const ok = await removeDevice(pool, payload.userId, token);
if (!ok) { reply.code(404); return { error: 'device not found' }; }
```

---

*本文档基于纯静态代码复核，未做运行时验证。日期 2026-06-29。*

# pocketctl 网络架构安全分析报告

| 项目 | 内容 |
|------|------|
| 分析对象 | pocketctl（daemon ↔ relay ↔ web/iOS 通信架构） |
| 分析范围 | 网络穿透、连接劫持、数据泄露、数据删除/破坏、数据丢失 |
| 分析方式 | 纯静态代码审查（relay/src、internal/ws、internal/api、deploy/nginx、docker-compose） |
| 分析日期 | 2026-06-29 |
| 分支 | develop |
| 结论状态 | **未改动任何代码，仅输出分析结论** |

---

## 目录

1. [架构概览](#一架构概览)
2. [网络穿透风险](#二网络穿透风险评估--低风险)
3. [连接劫持风险](#三daemonrelay-连接劫持风险评估---中低风险)
4. [数据泄露风险](#四数据泄露风险)
5. [数据删除/破坏风险](#五数据删除破坏风险)
6. [数据丢失风险](#六数据丢失风险评估--中风险)
7. [风险矩阵总览](#七风险矩阵总览)
8. [修复优先级建议](#八修复优先级建议)

---

## 一、架构概览

```
[Daemon (Go)]  ←──wss://──→  [Nginx 443 TLS]  ──proxy──→  [Relay (Fastify) :8080]  ──→  [PostgreSQL :5432]
   ↕                              HTTP/301→HTTPS              ↕ JWT auth
[本地 agent (claude/codex)]                                  [Web/iOS client WS]
```

生产部署形态（`docker-compose.prod.yml`）：**仅 Nginx 对外暴露 80/443**，Relay(8080) 和 PostgreSQL(5432) 均 `expose`（容器内部），不发布端口。

---

## 二、网络穿透风险评估 → 🟢 低风险

### 已有的防护（强项）
1. **默认走公网中转，不是直连穿透。** Daemon 连接的是公共 relay `wss://www.pocketctl.me/ws`（`internal/i18n/messages.go:39`），架构上是"客户端→中继服务器→客户端"模型，relay 本身不主动反向打洞到内网 daemon。NAT 穿越由 daemon 主动出站 WebSocket 完成，**不存在服务端向内网建立反向通道**。
2. **数据库不对外暴露。** `docker-compose.prod.yml:19` postgres 仅 `expose: 5432`，只有同网络的 relay 容器可达。
3. **Relay 不对外暴露。** `docker-compose.prod.yml:37` relay 仅 `expose: 8080`，所有外部流量必须经 Nginx。
4. **Nginx 禁止访问隐藏文件**（`deploy/nginx/pocketctl.conf:90`）。

### 需关注（非高危）
- **`--relay` / `POCKETCTL_RELAY_URL` 可指向任意服务器**（`internal/i18n/messages.go:40-48`）。这是设计特性（自托管），但意味着若用户被诱导设置恶意 relay URL，daemon 会主动连过去。属于用户配置风险，非架构漏洞。
- **approval hook 是本地 Unix socket**（`config.ApprovalSocketPath()`，`main.go:784`），不跨网络，无穿透面。

---

## 三、Daemon↔Relay 连接劫持风险评估 → ⚠️ 中低风险

### 已有的防护（强项）
1. **生产强制 TLS。** Nginx 配置 `ssl_protocols TLSv1.2 TLSv1.3; HSTS max-age=31536000`，HTTP→HTTPS 301 重定向（`pocketctl.conf:11-16,27`）。Daemon 默认用 `wss://`（`messages.go:39`）。
2. **TLS 证书校验未禁用。** Go 端用 `websocket.DefaultDialer.DialContext`（`internal/ws/client.go:193`）和 `http.DefaultClient`（`internal/api/client.go:232`），**全局无 `InsecureSkipVerify`**。证书校验走系统根证书库，MITM 需持有受信证书。
3. **WS 连接强制鉴权。** relay 的 `/ws` 端点（`server.ts:1058-1075`）：无 token 或 API key 立即 `socket.close(4001)`，不留未鉴权连接。
4. **JWT 签名验证 + 吊销检查。** WS 用 `verifyAccessTokenWithRevocation`（`server.ts:1060`），既验签又查 `isTokenRevoked`；refresh token 有轮换 + 重用检测（`server.ts:127-143`，breach detection 会吊销该用户全部 token）。

### 劫持/冒充风险点（中低危）

| # | 风险点 | 代码位置 | 说明 |
|---|--------|----------|------|
| 1 | **JWT 在 URL query 传递** | `ws/client.go:188` `q.Set("token", ...)` | token 进 URL，会进入 Nginx access log（`$request_uri`）、可能进浏览器历史/referrer。虽有 TLS 保护传输，但服务端日志泄露=token 泄露。建议改用 `Sec-WebSocket-Protocol` 子协议或首帧鉴权。 |
| 2 | **REST 端点 `verifyAccessToken` 不查吊销** | `auth.ts:61` / `server.ts` 各 REST handler | 只有 WS 和 refresh 走 `verifyAccessTokenWithRevocation`；普通 REST（profile、device、token 查询等）用 `verifyAccessToken`，**不查 jti 黑名单**。已吊销的 access token 在 24h 过期前仍能用其调 REST API。 |
| 3 | **`sameUser(null,null)=true`** | `router.ts:905-907` | 两个 userId 都为 null（legacy/匿名）时被视为同用户。匿名 daemon 与匿名 client 互通。生产环境 daemon 都绑定了 userId，但若 `getDaemonOwner` 失败导致 userId 为 null，存在跨用户广播的理论窗口。 |
| 4 | **CORS `origin: true` 兜底** | `server.ts:64` | `ALLOWED_ORIGINS` 未配置时 `origin: true` 允许所有来源跨域。`.env.example` 默认为空。WS 不受 CORS 限制，但 REST 端点会被任意网站脚本调用（若有 token）。 |
| 5 | **API key 明文比较 + 时序** | `server.ts:1069` `apiKey === API_KEY` | 非常量时间比较；且 API key 匿名连接 `userId=null`，能力受限。低危。 |
| 6 | **无 daemon 身份绑定校验** | `router.ts:45` `registerDaemon` | daemon 的 `daemon_id` 由客户端自报，relay 仅用 JWT 的 userId 做"属主"绑定，**不校验 daemon_id 是否真属于该机器**。拿到他人 token 即可用任意 daemon_id 注册并接收其 session 流（结合 sameUser）。 |

> 综合：在外网链路上劫持需要打破 TLS（很难），所以**传输层劫持风险低**。真正的风险是**令牌泄露后的身份冒充**（#1 日志泄露 + #2 吊销失效 + #6 无设备绑定），这是中危。

---

## 四、数据泄露风险

### 🔴 严重 — `replay` 历史回放无授权校验（IDOR / 越权读取）

**位置**：`relay/src/router.ts:564` → `handleReplay`（717-762 行）

```ts
// handleClientMessage 入口（router.ts:564）
if (msg.type === 'replay') { this.handleReplay(clientWs, msg.session_id, ...); return; }
```

`handleReplay` 内部**没有任何 `isSessionOwnedByUser` / `sameUser` 校验**，直接 `getEventsAfter(sessionId)` 把该 session 的**全部事件 payload** 发给请求方。事件 payload 含完整对话：`user_text`（用户输入）、`agent_text`（AI 回复）、`tool_call.input`（工具调用入参，常含代码/命令）、`tool_result.output`（命令执行结果）。

- **利用前提**：攻击者是一个**已认证用户**（任意账号，包括免费注册），知道目标 session_id。
- **session_id 是 UUID v4**（`manager.go:726`），盲猜不可行；但存在多条泄露途径：日志泄露、URL 分享、其他越权接口枚举（见下）。
- **对比**：REST `/api/sessions/:id/export`（server.ts:490）做了 `isSessionOwnedByUser` 校验，而 WS `replay` 没有——**同一份数据，REST 把关、WS 放行**，明显疏漏。

### 🔴 严重 — 通用 client→daemon 路由无 session 属主校验

**位置**：`router.ts:683-714`

凡带 `msg.session_id` 且未被前面分支显式拦截的命令，都走这段通用路由：仅查 session 归属哪个 daemon，**不校验该 session/daemon 是否属于当前 client**。受影响的破坏性/注入性命令：

| 命令 | daemon 端行为（main.go） | 危害 |
|------|------------------------|------|
| `user_message` (1541) | `sm.SendMessage` 注入内容到他人 PTY | 向受害者的 AI 会话注入任意 prompt，诱导其执行恶意操作（"请把 .env 内容打印出来"）|
| `session_kill` (1551) | `sm.KillSession` | 远程杀掉他人正在运行的会话 |
| `session_interrupt` (1558) | `sm.InterruptSession` | 中断他人进行中的任务 |
| `set_permission_mode` (1564) | `sm.SetPermissionMode` | **把他人会话切到 `bypassPermissions`**，令其 agent 无确认执行危险工具 |
| `set_effort` (1584) | 注入 `/effort` | 干扰他人会话 |

- 唯一做了属主校验的只有 `session_delete`(597)、`session_pin`(615)、`daemon_restart`(634)、`list_models`(652)、`session_create`(663)。
- **根因**：WS 命令面太宽，授权分散在各 case 里手工补，通用分支成了兜底漏洞。

### 🟠 高 — `listSessions`（无 userId）返回全库会话

**位置**：`db.ts:295` + `router.ts:769`

当 client 的 `userId === null`（API key 登录，`server.ts:1069` 设 `userId=null`）时，`handleListSessions` 走 `listSessions` 分支，SQL **无 user_id 过滤**，返回**所有用户的所有会话标题、daemon_id、hostname、cwd**。结合上面的 replay 越权，等于一条完整的数据泄露链：用 API key 拿到全部 session_id → 逐个 replay 取全文。

### 🟠 高 — `removeDevice` 不校验属主（可被删推送设备）

**位置**：`db.ts:607` + REST `DELETE /api/devices/:token`（server.ts:306）

```ts
export async function removeDevice(pool, deviceToken) {
  await pool.query(`DELETE FROM devices WHERE device_token = $1`, [deviceToken]);
}
```

任意已认证用户，知道他人的 `deviceToken` 即可删除其推送设备。危害是**拒绝服务**：受害者收不到离线/会话完成推送。

### 🟡 中 — JWT 走 URL query 进服务端日志

**位置**：`ws/client.go:188` + nginx `access_log`（`pocketctl.conf:42`）

WS token 在 `?token=` 中，nginx 默认会记录完整 `$request_uri` 到 access log。access log 若被第三方访问/泄露/误投递到日志聚合服务，等于泄露 24h 有效 access token，进而触发上述全部越权。REST 路径用的是 `Authorization` header（不走日志），但 WS 没有。

### 🟡 中 — REST access token 不查吊销

**位置**：`auth.ts:61` `verifyAccessToken`（无 revocation）vs `verifyAccessTokenWithRevocation`（80）

REST handlers（profile/device/daemon/token 查询/导出/标题等）全部用 `verifyAccessToken`，**不查 jti 黑名单**。forceKick/force logout 吊销的 token 在 24h 内仍可调这些 REST 接口读取用户数据。

---

## 五、数据删除/破坏风险

### 🔴 严重 — `user_message` + `set_permission_mode` = 远程代码执行前置链

虽非直接"删除"，但这是**最危险的破坏面**：攻击者通过通用路由越权（见第四节）向他人生会话：
1. `set_permission_mode` → `bypassPermissions`
2. `user_message` → 注入 prompt 让 agent 执行 `rm -rf`、`git push --force`、读取并外传密钥等

agent 在受害者机器上以**用户完整权限**运行（daemon 启动 agent 时不做沙箱），`bypassPermissions` 下无确认。这等同于通过 relay 远程操控他人电脑。这是把"数据删除"风险推到最高的一条路径。

### 🟢 安全 — `session_delete` 有属主校验

**位置**：`router.ts:597`，有 `isSessionOwnedByUser` 校验 ✅

这一条**是安全的**——删会话前校验属主，失败返回 error。但要注意它物理删除 events（`deleteSession` 真删，非软删），且**删后无法恢复**（90 天保留指的是自动清理，用户主动删是立即永久删）。

### 🟢 安全 — `deleteDaemon` 有属主校验

**位置**：`db.ts:218`，有 `user_id = $2` 属主校验 ✅

安全。但会把该 daemon 的 sessions 的 `daemon_id` 置 NULL（不删会话数据），属于设计行为。

### 🟡 中 — `cleanStaleSessions` 自动把离线 daemon 的会话标 completed

**位置**：`db.ts:341`

daemon 离线 >5 分钟，relay 自动把其 running/busy 会话改为 completed。这不是删数据，但会造成**状态错乱**（会话实际还在 agent 端运行，relay 侧已显示结束），客户端误以为任务完成。

### 🟡 中 — `forceKick` 可吊销他人全部 token（已有 rate limit）

**位置**：`router.ts:882` `db.revokeToken(pool, '', userId, 'force_kick')`

注意第二个参数传空字符串 jti，若空 jti 会吊销该 userId 的**全部** token，则一个被盗 token 的攻击者可对受害者发起"吊销全部会话"的拒绝服务。已有"每小时 3 次"限流（server.ts:358）缓解。

---

## 六、数据丢失风险评估 → ⚠️ 中风险

### 已有的防护（强项）
1. **事件幂等去重。** `insertEvent`（`db.ts:252`）用 `event_hash` + `ON CONFLICT DO NOTHING`，重连重发不会产生重复行——这是为断线重传设计的。
2. **会话路由重建。** relay 重启后 `rebuildSessionRoutes`（`router.ts:301`）从 DB 重建 session→daemon 映射，历史会话不会因 relay 重启变孤儿。
3. **僵尸会话对账。** `reconcileDaemonSessions`（`db.ts:365`）按 daemon 上报的活跃集，把僵死的 running/busy 行标 completed。
4. **优雅关停。** relay 收到 SIGTERM 先 `broadcastRelayRestarting` 提示 daemon 重连（`server.ts:1100-1110`），抑制误报离线推送。
5. **token 统计永久保留。** `token_daily_stats` 永久存，`deleteSession` 先把当日用量补偿进统计再删事件（`db.ts:472-498`），避免删会话导致 token 总量缩水。

### 丢失风险点（中危，正是你担心的）

| # | 场景 | 代码证据 | 影响 |
|---|------|----------|------|
| 1 | **relay 写库 fire-and-forget** | `router.ts:434,448,462,469,522` 等全是 `db.insertEvent(...).catch(console.error)` | **不 await**。消息一收到就转发给 client，DB 写入异步且**失败只打日志**。若 DB 瞬时不可用，事件静默丢失，client 已显示但刷新后（走 replay）就没了。 |
| 2 | **daemon 端无磁盘持久化** | `main.go:773` `outputCh := make(chan protocol.DaemonEvent, 256)`；`OnReconnected` 只重发 `session_discovered` 元数据（`main.go:875-884`），**不重发断网期间的事件流** | relay 断开期间，daemon 产生的消息事件**不补传**。256 缓冲满后 session manager 的 tailer 协程阻塞（`manager.go:317` 阻塞写），但 daemon 进程崩溃=缓冲全丢。 |
| 3 | **WS 写失败不缓存** | `ws/client.go:363` `WriteMessage` 失败只 `conn.Close()` 触发重连 | 写失败的这批事件不会回灌队列重试。 |
| 4 | **事件 90 天硬删除** | `server.ts:1128` `cleanStaleEvents(pool)` 每小时跑 `DELETE FROM events WHERE created_at < NOW()-90 days`（`db.ts:872`） | 历史 session 的**对话正文 90 天后永久消失**（token 统计保留，但 messages/replay 取不到）。这是设计取舍，但对"数据永久留存"是损失。 |
| 5 | **无 WAL/备份配置可见** | `docker-compose.prod.yml` 仅 `pgdata` 卷，无 `archive_mode`/PITR/定时备份 | 单卷 + `restart:always`，宿主机磁盘故障或卷误删=全量丢失。代码层面看不到备份策略。 |

> **关键结论**：在 **relay↔DB 瞬时故障**（#1）和 **daemon↔relay 长断网**（#2）两个场景下，存在**静默丢消息**的真实窗口。其中 #1（fire-and-forget 写库）是最隐蔽的——日志里看不到失败、客户端却丢数据。

---

## 七、风险矩阵总览

| 风险 | 等级 | 类型 | 根因 | 位置 |
|------|------|------|------|------|
| replay 越权读全对话 | 🔴 严重 | 数据泄露 | WS handleReplay 无 owner 校验 | `router.ts:564,717` |
| 通用路由越权注入/控制他人会话 | 🔴 严重 | 泄露+破坏+RCE前置 | 通用分支无校验 | `router.ts:683-714` |
| set_permission_mode 越权切 bypass | 🔴 严重 | RCE前置 | 同通用路由越权 | `router.ts:683` → `main.go:1564` |
| user_message+permission RCE 链 | 🔴 严重 | 数据删除/破坏 | 同通用路由越权 | `main.go:1541,1564` |
| listSessions 返回全库 | 🟠 高 | 数据泄露 | userId=null 时无过滤 | `db.ts:295` / `router.ts:769` |
| removeDevice 无属主校验 | 🟠 高 | 破坏/DoS | db 不过滤 user_id | `db.ts:607` |
| session 物理删除不可恢复 | 🟠 高 | 数据丢失 | deleteSession 真删+无备份 | `db.ts:472` |
| JWT 进 URL 日志 | 🟡 中 | 数据泄露 | ws token 在 query string | `ws/client.go:188` |
| REST token 不查吊销 | 🟡 中 | 数据泄露 | verifyAccessToken 无黑名单 | `auth.ts:61` |
| relay 写库 fire-and-forget | 🟡 中 | 数据丢失 | insertEvent 不 await | `router.ts:434` 等 |
| daemon 无磁盘缓冲 | 🟡 中 | 数据丢失 | outputCh 仅内存 256 | `main.go:773` |
| 事件 90 天硬删 | 🟡 中 | 数据丢失 | cleanStaleEvents | `db.ts:872` |
| PG 无备份/单卷 | 🟡 中 | 数据丢失 | compose 无备份编排 | `docker-compose.prod.yml` |
| daemon_id 无设备绑定 | 🟡 中 | 身份冒充 | registerDaemon 信任自报 | `router.ts:45` |
| CORS origin:true 兜底 | 🟢 低 | 跨域滥用 | ALLOWED_ORIGINS 默认空 | `server.ts:64` |

---

## 八、修复优先级建议

> 仅建议，未改动任何代码。

### 第一优先（堵越权 — 收益最高）
在 `handleClientMessage` 入口对**所有**带 `session_id` 的命令统一做 `isSessionOwnedByUser` 校验；`handleReplay` 开头加同样的 owner 检查；`removeDevice` 加 `user_id` 条件。这一类是"在 router 里加几行 sameUser/owned 判断"，收益最高。

### 第二优先（缩小泄露面）
`listSessions` 的 null 分支要么删除（禁止匿名 list），要么仅返回摘要不返回 session_id/hostname/cwd。

### 第三优先（令牌安全）
WS token 改用 `Sec-WebSocket-Protocol` 子协议或鉴权首帧，移出 URL；REST 统一用 `verifyAccessTokenWithRevocation`。

### 第四优先（数据韧性）
编排层加定时 `pg_dump` + 异地存储；考虑 session 软删除（`deleted_at`）而非物理删，配合备份做可恢复。daemon 端可考虑为 outputCh 增加本地磁盘 spool，重连后回放。

---

## 九、总体结论

| 维度 | 风险等级 | 一句话 |
|------|----------|--------|
| **网络穿透** | 🟢 低 | 纯出站中继模型，DB/Relay 不对外暴露，无反向打洞。 |
| **连接劫持（传输层）** | 🟢 低 | 生产强制 TLS1.2/1.3 + HSTS，证书校验未绕过，MITM 难度高。 |
| **身份冒充（令牌层）** | 🟡 中 | JWT 走 URL（日志泄露面）、REST 不查吊销、daemon_id 无设备绑定。 |
| **数据泄露（越权层）** | 🔴 严重 | WS replay 与通用命令路由缺属主校验，注册账号即可越权读全对话、控制他人会话。 |
| **数据删除/破坏** | 🔴 严重 | 越权 user_message + set_permission_mode 构成 RCE 前置链，可远程操控受害者机器。 |
| **数据丢失** | 🟡 中 | relay 写库 fire-and-forget + daemon 无磁盘缓冲 + 90 天硬删 + 无备份，断网/崩溃下静默丢消息。 |

**最关键结论**：当前代码在 **WS 命令面的授权是不完整的**——REST 接口普遍有属主校验，但 WS 的 replay 和通用 client→daemon 路由存在系统性缺口。一个注册账号（甚至 API key 匿名连接）即可越权读取他人完整对话、向他人会话注入内容、切换权限模式，这是比"传输劫持"更现实的攻击路径，建议优先处理。

---

*报告基于纯静态代码分析，未做运行时验证。分析日期 2026-06-29。*

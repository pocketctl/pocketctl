## Context

pocketctl daemon 目前只支持 `start/stop/status/logs` 四个子命令。当连接失败时，用户只能看 daemon 日志排查，没有结构化的诊断工具。

## Goals / Non-Goals

**Goals:**
- 一条命令检查所有连接相关配置和状态
- 每项检查独立，失败不影响后续检查
- 输出清晰的 ✅/❌ 状态和修复建议

**Non-Goals:**
- 不自动修复问题（只诊断，不治疗）
- 不修改任何配置或状态
- 不检查 daemon 进程本身（那是 `daemon status` 的职责）

## Decisions

### D1: 命令名 `pocketctl doctor`

**选择**: `doctor`（不是 `check`、`diagnose`、`health`）
**理由**: 业界惯例（brew doctor, kubectl cluster-info, docker info）

### D2: 检查顺序从轻到重

**选择**: 配置文件 → Token → DNS → HTTP → Relay健康 → WebSocket → 认证 → 限制
**理由**: 前置检查失败时后续检查无意义，可以提前终止

### D3: 复用现有 HTTP 客户端

**选择**: 在 `internal/api/client.go` 新增 `HealthCheck(baseURL)` 函数
**理由**: 复用已有的 `http.DefaultClient` 模式，保持一致性

### D4: WebSocket 探测用独立连接

**选择**: doctor 命令建立一个临时 WebSocket 连接，收到 register_ack 后立即关闭
**理由**: 不干扰正在运行的 daemon

## Risks / Trade-offs

- **[网络超时]** → 每项检查设置 5 秒超时，避免 doctor 命令卡住
- **[JWT 解析]** → 只检查本地过期时间，不调用服务端验证（避免额外网络开销）

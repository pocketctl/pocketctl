## Why

用户连接 daemon 到 relay 时，如果出现网络问题、token 过期、daemon 数量限制等错误，终端只显示一个泛泛的错误信息，无法快速定位问题。需要一个诊断命令，逐步检查配置、网络、认证、服务状态，给出清晰的排查指引。

## What Changes

- **新增 `pocketctl doctor` 命令**: 逐步检查 8 项健康指标，输出每项的通过/失败状态和修复建议
- **复用现有基础设施**: 使用 `config.LoadAuth()` 读取配置、`net/http` 测试健康端点、`gorilla/websocket` 探测连接
- **不改变现有行为**: doctor 命令是只读诊断，不修改任何状态

## Capabilities

### New Capabilities
- `daemon-doctor`: 网络连通性和配置诊断命令

## Impact

- **Go Daemon**: `cmd/pocketctl/main.go`（新增 cmdDoctor）、`internal/api/client.go`（新增 HealthCheck）
- **Relay**: 无改动（复用现有 /health 端点）
- **iOS**: 无改动

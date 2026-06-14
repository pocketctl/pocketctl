## MODIFIED Requirements

### Requirement: register 消息扩展字段
daemon 注册消息 SHALL 新增 arch/version/started_at 字段，relay SHALL 持久化到 daemons 表。

#### Scenario: register 含扩展字段
- **WHEN** daemon 连接并发送 register
- **THEN** 消息含 arch（runtime.GOARCH）、version（构建版本）、started_at（启动时间戳）
- **AND** relay 存储到 daemons 表（新增 arch/version/started_at 列）

### Requirement: ping 消息携带系统资源
daemon 心跳 SHALL 携带 CPU/内存/磁盘使用率，relay SHALL 缓存到内存 Map。

#### Scenario: ping 含 metrics
- **WHEN** daemon 每 10s 发送 ping
- **THEN** 消息含 cpu_pct（float，0-100）、mem_pct（float）、disk_pct（float）
- **AND** relay 缓存到 daemonMetrics Map（key=daemon_id）

#### Scenario: list_daemons 返回 metrics
- **WHEN** Web 客户端请求 list_daemons
- **THEN** 每个 daemon 对象含 cpu_pct/mem_pct/disk_pct（在线时）或 null（离线时）
- **AND** 含 arch/version/started_at/last_heartbeat 扩展字段

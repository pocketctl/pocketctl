## Why

设计稿 `hosts.html` 定义了完整的主机管理页面，当前 Web 客户端缺少独立的 `/hosts` 路由。同时 daemon 不上报系统资源（CPU/内存/磁盘）、版本、架构等信息，无法支撑设计稿中的资源监控条和详情面板。本变更一次性实现全部 25 个功能点：前端 hosts 页面 + daemon 协议扩展（字段+资源采集+控制命令）+ relay 存储转发。

## What Changes

**Daemon (Go):**
- RegisterMessage 扩展：加 `arch`/`version`/`started_at` 字段
- PingMessage 扩展：加 `cpu_pct`/`mem_pct`/`disk_pct` metrics payload
- 引入 `shirou/gopsutil` 采集 CPU/内存/磁盘使用率
- 新增 `daemon_restart` 控制命令（复用 `RestartDaemon`）
- 心跳间隔从 15s 改为 10s（资源数据更实时）

**Relay (TypeScript):**
- register 存储扩展字段（daemons 表加 arch/version/started_at 列）
- ping 解析 metrics 并缓存到内存 Map
- list_daemons 返回扩展字段 + 实时 metrics
- daemon_restart 命令转发给目标 daemon
- reconnecting 状态处理（重启过渡态）

**Web (Vue 3):**
- 新增 `/hosts` 路由 + `HostsView.vue`（完整还原 hosts.html 设计稿）
- 双栏布局：左侧列表面板（筛选/搜索/列表项）+ 右侧详情面板
- 主机列表项（状态圆点/类型图标/名称/IP·OS/活跃会话数）
- 详情面板（头部信息/操作按钮/资源监控条/连接信息网格/会话摘要）
- 操作：重启 daemon / 强制踢下线 / 等待重连 / 编辑别名 / 注销主机
- 注册新主机弹窗（安装命令展示 + 复制）
- 复制连接信息 / 导出主机报告（Markdown）
- 确认弹窗 + Toast 撤销通用组件
- 响应式布局 + 键盘无障碍

## Capabilities

### New Capabilities

- `hosts-page`: 主机管理页面，含列表/详情/资源监控/操作控制，完整还原设计稿

### Modified Capabilities

- `relay-url-config`: register 消息新增 arch/version/started_at 字段；ping 新增 metrics payload
- `session-lifecycle`: 新增 daemon_restart 控制命令和 reconnecting 状态

## Impact

- **Daemon**: `protocol/types.go`(RegisterMessage+PingMessage+ClientMessage 扩展)、`ws/client.go`(register+ping 发送扩展)、`main.go`(handleCommands 加 daemon_restart)、`go.mod`(引入 gopsutil)、新增 `internal/sysinfo/` 包
- **Relay**: `db.ts`(daemons 表 migration + metrics 缓存函数)、`router.ts`(register 存储 + ping metrics + daemon_restart 转发 + list_daemons 扩展返回)、`server.ts`(REST daemon_restart 端点)
- **Web**: 新增 `views/HostsView.vue`、`main.ts`(路由)、`App.vue`(sidebar 主机链接)、复用 `SessionActions.vue` 组件模式

## 1. Daemon — 系统信息采集 (gopsutil)

- [x] 1.1 `go get github.com/shirou/gopsutil/v3`，新增 `internal/sysinfo/collector.go`
- [x] 1.2 实现 `Collect() → {cpu_pct, mem_pct, disk_pct}`（gopsutil cpu.Percent + mem.VirtualMemory + disk.Usage，后台 goroutine 1s 采样不阻塞）
- [x] 1.3 扩展 `RegisterMessage`：加 `Arch`/`Version`/`StartedAt` 字段
- [x] 1.4 扩展 `PingMessage`（或 ping payload）：加 `CpuPct`/`MemPct`/`DiskPct`
- [x] 1.5 `ws/client.go` register 发送扩展字段 + ping 携带 metrics（每 10s）
- [x] 1.6 `handleCommands` 加 `daemon_restart` case → 调 `update.RestartDaemon()`
- [x] 1.7 构建验证

## 2. Relay — 扩展存储与转发

- [x] 2.1 daemons 表 migration：加 `arch`/`version`/`started_at` 列（IF NOT EXISTS）
- [x] 2.2 新增 `daemonMetrics` 内存 Map + `setDaemonMetrics`/`getDaemonMetrics` 函数
- [x] 2.3 `registerDaemon` 存储 arch/version/started_at
- [x] 2.4 ping handler 解析 cpu/mem/disk → `setDaemonMetrics`
- [x] 2.5 `list_daemons` 返回合并 metrics + 扩展字段
- [x] 2.6 `daemon_restart` 命令转发 + reconnecting 状态处理
- [x] 2.7 新增 `POST /api/daemons/:daemonId/restart` REST 端点
- [x] 2.8 构建验证

## 3. Web — HostsView 页面

- [x] 3.1 新增 `/hosts` 路由 + `HostsView.vue` 组件
- [x] 3.2 sidebar 加「主机」链接（App.vue）
- [x] 3.3 双栏布局骨架（左 380px 列表面板 + 右详情面板）
- [x] 3.4 状态筛选 Tab（全部/在线/离线 + 计数）
- [x] 3.5 搜索框（hostname/ip/os 模糊匹配）
- [x] 3.6 主机列表项（状态圆点/类型图标/名称/IP·OS/活跃会话数/hover ⋯）
- [x] 3.7 详情面板头部（图标/名称/状态 pill/IP·OS·架构）
- [x] 3.8 操作按钮组（重启/踢下线/查看会话/等待重连 — 按 status 动态显示）
- [x] 3.9 资源监控条（CPU/内存/磁盘进度条 + 颜色阈值 + 动画）
- [x] 3.10 连接信息网格（IP/端口/版本/系统/运行时长/心跳）
- [x] 3.11 会话摘要卡（活跃 + 历史 + 查看全部链接）
- [x] 3.12 ⋯ 菜单（复制连接信息/导出报告/编辑别名/重启/踢下线/注销）
- [x] 3.13 注册新主机弹窗（安装命令 + 复制）
- [x] 3.14 确认弹窗 + Toast 撤销通用组件
- [x] 3.15 响应式布局（≤900px 单栏 + ≤520px 纵向工具栏）
- [x] 3.16 WS 事件监听（daemon_status 更新 + daemon_restart 状态轮询）
- [x] 3.17 构建验证

## 4. 部署 + 测试

- [x] 4.1 本地 Docker 部署验证（relay + web）
- [x] 4.2 daemon 重启验证（metrics 上报 + reconnecting 状态）
- [x] 4.3 hosts 页面功能验证（列表/详情/操作）

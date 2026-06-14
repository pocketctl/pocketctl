## Context

hosts.html 设计稿定义了双栏布局的主机管理页面（左列表面板 + 右详情面板），含 25 个功能点。daemon 当前 register 仅发 5 字段（hostname/agents/os/ip/daemon_id），ping 仅发 {type:ping} 无 payload，ClientMessage 白名单仅 4 种命令。需要一次性扩展三层。

## Goals / Non-Goals

**Goals:**
- 完整还原 hosts.html 设计稿的所有功能点
- daemon 上报系统资源（CPU/内存/磁盘）+ 版本/架构/运行时长
- 支持重启 daemon 远程控制
- 一次交付，不分阶段

**Non-Goals:**
- 不做远程 shell / 文件传输（安全设计，不在 hosts 设计稿范围）
- 不做 GPU/温度/电池监控（设计稿只要求 CPU/内存/磁盘）
- 不做 Windows 桌面通知适配

## Decisions

### Decision 1: gopsutil 采集系统资源

引入 `github.com/shirou/gopsutil/v3`，跨平台（macOS+Linux）采集 CPU%/内存%/磁盘%。gopsutil 是 Go 社区标准库，一行 `go get` 装好。

```go
// internal/sysinfo/collector.go
cpuPct, _ := cpu.Percent(time.Second, false)  // []float64, [0]=总体
mem, _ := mem.VirtualMemory()                  // mem.UsedPercent
disk, _ := disk.Usage("/")                     // disk.UsedPercent
```

采集频率：每 10s 一次（和心跳同步），随 ping 消息上报。

### Decision 2: metrics 不持久化到 DB

CPU/内存/磁盘是时序数据，写 DB 无意义（每次 ping 覆盖）。relay 用内存 Map 缓存最新值（`daemonMetrics: Map<daemonId, {cpu, mem, disk, updated_at}>`），list_daemons 返回时合并。

### Decision 3: daemon_restart 复用 RestartDaemon

`internal/update/updater.go:213` 已有 `RestartDaemon()`（daemon update 后调用）。新增 `daemon_restart` ClientMessage → handleCommands 调 RestartDaemon → daemon 重启 → ws 断开 → 自动重连。relay 侧在转发命令后将 daemon 状态设为 reconnecting，直到重新 register 恢复 online。

### Decision 4: hosts 页面路由 /hosts

独立路由 `/hosts`（不是 /manage/hosts），sidebar 链接直接指向。hosts 页面通过 WS 获取 daemon 列表（复用 list_daemons 消息），不需要新 WS 协议。

## Risks / Trade-offs

- **[gopsutil 依赖]** 新增第三方依赖（~2MB），但跨平台系统信息采集无更好替代。shirou/gopsutil 是 Go 社区最成熟的系统信息库。
- **[metrics 内存 Map]** relay 重启后 metrics 丢失。但 daemon 下次 ping（10s）即恢复，可接受。
- **[daemon_restart 风险]** 远程重启可能导致正在运行的 agent 会话中断。设计稿已有二次确认弹窗 + 提示说明。
- **[gopsutil CPU 采样]** `cpu.Percent(time.Second, false)` 会阻塞 1 秒（采样窗口）。在独立 goroutine 中调用，不阻塞主循环。

## Migration Plan

DB migration 幂等（daemons 表加列 IF NOT EXISTS）。新 WS 消息/字段向后兼容（旧 daemon 不发 metrics，relay 返回 null，前端显示空条）。无破坏性变更。

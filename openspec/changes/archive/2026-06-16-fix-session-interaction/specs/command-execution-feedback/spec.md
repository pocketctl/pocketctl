## ADDED Requirements

### Requirement: terminal session 命令反馈统一为 stdout 捕获
terminal session（用户终端开的 claude，source=terminal）的命令反馈 SHALL 通过 stdout stream-json + adapter 捕获（与 daemon session 的 `CreateSession`/`SendMessage` 路径统一），SHALL NOT 依赖 JSONL tailer 转发命令反馈。`sendToIdleTerminal` SHALL 用 `StdoutPipe` + adapter 解析 stdout，由 adapter 产出 `command_receipt`（命令名来自 adapter 的 `pendingCmd` 跟踪）。`sendToIdleTerminal` 执行期间 SHALL 暂停该 session 的 JSONL tailer（避免 stdout 与 JSONL 双源重复转发），`cmd.Wait()` 完成后恢复。

#### Scenario: terminal session 命令收到 command_receipt
- **WHEN** terminal session（idle 且进程存活）收到 web 发的 `/model`
- **THEN** daemon 通过 `sendToIdleTerminal` spawn `claude -p "/model" --resume` 并用 StdoutPipe 捕获 stdout
- **AND** adapter 识别 `assistant <synthetic>` 或 `system local_command` 产出 `command_receipt`
- **AND** SHALL NOT 依赖 JSONL tailer 转发该命令反馈

#### Scenario: sendToIdleTerminal 期间暂停 tailer 防双发
- **WHEN** `sendToIdleTerminal` 执行（web 触发 `claude -p --resume`）
- **THEN** 该 session 的 JSONL tailer 进入 paused 状态，不转发新事件
- **AND** `claude -p --resume` 进程退出（`cmd.Wait` 完成）后恢复 tailer
- **AND** 避免同一事件被 stdout adapter 与 tailer 重复转发

#### Scenario: terminal session command_receipt 携带命令名
- **WHEN** `sendToIdleTerminal` 发送 `/compact`
- **THEN** adapter 的 `pendingCmd` 记录命令名 "compact"
- **AND** 产出的 `command_receipt.command` SHALL 为 "/compact"（非空，区别于旧 JSONL 路径传空）

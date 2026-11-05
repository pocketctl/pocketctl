# Agent 接入与常用命令

[返回 README](../README.zh-CN.md)

## 启用共享终端控制

Daemon 启动时可自动启用符合条件的 Codex/OpenCode Launcher；使用
`--no-agent-auto-enable` 可跳过。Launcher 可随时撤销，不会安装、替换或升级底层 Agent CLI。

### Codex

```bash
pocketctl agent codex enable
pocketctl agent codex status
codex
```

单次绕过 PocketCtl 可使用 `codex --native ...`；执行
`pocketctl agent codex disable` 可移除 PocketCtl Launcher。

**单机多 Codex 账号。** 隔离的 Codex home（`~/.codex-a`、`~/.codex-proxy`
等）可以同时监听——通过可重复的 `--codex-home <目录>` 参数或
`POCKETCTL_CODEX_HOMES` 环境变量添加额外 home，之后在 Web 或 iOS 新建
会话时即可选择对应账号。

### OpenCode

```bash
pocketctl agent opencode enable
pocketctl agent opencode status
opencode
```

单次绕过 PocketCtl 可使用 `opencode --native ...`；执行
`pocketctl agent opencode disable` 可移除 PocketCtl Launcher。

### DeepSeek Harness（预览）

先启动原生 Host，再用它打印的启动 URL 接入 PocketCtl：

```bash
dsh web --no-open
# 在另一个终端中填入上一步实际输出的 URL：
pocketctl agent dsh enable --url 'http://127.0.0.1:PORT/?token=TOKEN'
pocketctl agent dsh status
```

打开该 URL 使用本地 DSH 客户端。Daemon 自动发现 `--allowed-cwd-root`
授权目录内的会话，在 PocketCtl Web 选择同一会话即可远程操作。两端共享
同一个 Host 和会话 ID。请保持 Host 运行；`pocketctl agent dsh disable`
只解除 PocketCtl 接入，不停止 DSH。Host 重启后需用新的启动 URL 再次启用。

启动凭据仅保存在权限为 `0600` 的 `~/.pocketctl/dsh.json`，不会发送至 Relay，
只接受回环地址。本接入复用 DSH 已有 Host，不会另起 ACP 运行时。
Electron Desktop 0.2.0-rc.2 已通过本机 daemon + Docker Relay 的共享输入、
提问、审批、双向取消及模型／思考强度／权限双向同步验收。Web（含手机网页）
和 iOS 均提供原生设置入口。模型与强度用于后续请求，同时保存为 Host 默认模型；
完全权限及自定义权限预设仍需 daemon 本地开启 `--allow-dangerous-remote-permissions`。
Desktop 目前需要显式安装本地桥接插件，导出
Host 启动 URL，尚未实现自动接入。远程创建 worktree/fork 和附件上传尚不在支持范围内。

## 托管会话控制与完全访问权限

远程会话控制与 Agent 执行权限是两项独立设置。发送消息、审批或中断任务无需开启跳过审批；
需要完全访问或跳过审批时，还需在 daemon 本地开放高权限请求，并为会话选择对应权限。

### 先确认会话由 PocketCtl 托管

以 daemon 所属用户在开发主机上启用接入，并保持 daemon 在线、已连接 Relay：

- **Codex CLI**：执行上文的 `pocketctl agent codex enable`，若 PATH 尚未生效则重新打开登录终端，
  再用 `codex` 或 `codex resume <thread-id>` 新建或恢复会话。官方 TUI 与 Web/iOS
  共享输入、审批、问题和中断；已经运行的原生进程不会自动转换为托管会话。
- **Claude Code**：在 Web/iOS 的“新建会话”中选择 Claude Code，创建由 PocketCtl 持有的 PTY。
  独立终端的 Channel 接入只提供审批中继；会话空闲或退出后可通过 resume 接力。
- **Codex Desktop**：当前为只读观察会话，不能通过开启高权限切换为远程可控会话。

详细能力与限制见 [Codex 共享控制](codex-managed-terminal.md)和
[Claude Code 跨设备控制](claude-cross-device-control.md)。

### 允许完全访问或跳过审批

直接启动 daemon 时，增加本地开关：

```bash
pocketctl daemon start --allow-dangerous-remote-permissions
```

由系统服务托管时，通过安装命令将开关保存到服务启动参数：

```bash
pocketctl daemon service install --allow-dangerous-remote-permissions
```

以上是最小命令示例；请保留原有的 `--prod` / `--relay`、`--allowed-cwd-root`、
`--codex-home` 等参数。已有 daemon 需等活动任务结束后，执行 `pocketctl daemon stop`，
再按原来的直接启动或服务托管方式应用新配置。

随后在 Web/iOS **新建会话**的权限选项中选择：

| Agent | 权限选项 |
|---|---|
| Codex CLI | 完全访问：`danger-full-access`；无需审批时选择 `never`。 |
| Claude Code | 跳过权限：`bypassPermissions`。 |

该开关默认关闭，只允许客户端请求高权限，不会自动选择权限或修改已有会话。
它也不会扩大 `--allowed-cwd-root` 的远程工作目录授权范围。
高权限模式允许越过通常的审批或沙箱限制，仅用于你信任的主机与任务。

### 检查是否生效

```bash
pocketctl daemon status
pocketctl agent codex status
pocketctl daemon diagnose <会话ID>
```

Claude Code 可改用 `pocketctl agent claude-code status`。`agent status` 检查接入状态，
`daemon diagnose` 检查实际会话是否受控；两者不代表会话已获得完全访问权限。
daemon 启动输出中的 `dangerous remote permissions=true` 表示本地高权限开关已开启，
仍需确认新建会话时选择的权限。其他参数可运行 `pocketctl help` 查看。

## 常用命令

| 命令 | 用途 |
|---|---|
| `pocketctl login [--prod] [--email]` | 通过浏览器设备流或邮箱验证码登录。 |
| `pocketctl daemon start [--prod]` | 启动 Daemon 并发现本地 Agent。 |
| `pocketctl daemon status [--no-update-check]` | 查看状态；交互终端中仅在发现高于当前运行 Daemon 的版本时提供更新选择。 |
| `pocketctl daemon doctor` | 诊断配置和连接问题。 |
| `pocketctl daemon diagnose <会话ID>` | 检查单个会话是否已代理，并输出原因和恢复建议。 |
| `pocketctl daemon logs` | 定位或跟踪 Daemon 日志。 |
| `pocketctl daemon update [--version TAG]` | 下载并校验已发布的更新。 |
| `pocketctl agent <agent> status` | 查看 Launcher、能力和 Runtime 状态。 |
| `pocketctl agent zcode sync enable` | 启用只读 ZCode 历史同步；重启 Daemon 后生效。 |
| `pocketctl uninstall [--yes] [--keep-binary]` | 移除 Daemon 和本地 PocketCtl 数据。 |

运行 `pocketctl help`，或对相应子命令使用 `--help` 查看全部参数。

`daemon status` 先输出状态，再检查更新，检查超时为 2 秒。检查失败、相同或更低版本、非交互调用均不弹出更新选择。回车保留当前版本，输入 `y` 更新后重新显示状态；可通过 `--no-update-check` 跳过检查。

对于 root 所有的系统二进制，`daemon update` 在下载前请求 sudo 授权，仅安装步骤以 root 执行，daemon 仍由原用户重启。自动提权要求可执行文件及其父目录均由 root 控制。取消授权不会替换二进制或停止 daemon；`--no-restart` 仅安装、不重启。

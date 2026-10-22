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

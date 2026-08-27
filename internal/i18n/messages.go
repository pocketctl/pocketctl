package i18n

// msg holds the English and Chinese templates for one message key. Templates
// use fmt.Sprintf verbs (%s, %d, %v, %w …); args are passed positionally to
// T(). Templates omit trailing newlines (the caller's Println/Fprintln adds
// them) but may carry a leading newline for visual spacing.
type msg struct {
	en, zh string
}

// template returns the template for the given language.
func (m msg) template(l Lang) string {
	if l == Chinese {
		return m.zh
	}
	return m.en
}

// helpEn / helpZh are the full `pocketctl help` body in each language.
const helpEn = `pocketctl - Remote AI coding agent control

Usage:
  pocketctl <command> [options]

Commands:
  login          Login via browser (OAuth 2.0 Device Flow) or email code
  agent opencode enable|disable|status   Manage transparent OpenCode terminal control
  agent codex enable|disable|status      Manage official Codex TUI terminal control
  agent zcode sync enable|disable|status Sync ZCode sessions read-only (view in Web/iOS)
  daemon start   Start the daemon (connects to relay)
  daemon stop    Stop the running daemon
  daemon status  Show daemon status
  daemon logs    Show daemon logs
  daemon doctor  Diagnose connection and configuration issues
  daemon update  Update daemon to the latest version
  daemon service Install/remove a native auto-restart service (launchd/systemd)
  daemon keep-awake on|off|status   Prevent system sleep while agents run (auto-disables on battery)
  uninstall      Remove pocketctl binary and all local data
  version        Print version
  help           Show this help

Relay Connection (default: production wss://www.pocketctl.me/ws):
  By default, login/daemon connect to the public relay at wss://www.pocketctl.me/ws.
  Override with --relay <url> or POCKETCTL_RELAY_URL to target a different relay:

  # Local relay (running on this machine, default port 8080):
  pocketctl daemon start --relay ws://localhost:8080/ws
  POCKETCTL_RELAY_URL=ws://localhost:8080/ws pocketctl daemon start

  # Self-hosted relay (your own domain with TLS):
  pocketctl daemon start --relay wss://relay.example.com/ws
  POCKETCTL_RELAY_URL=wss://relay.example.com/ws pocketctl login --email

  # Production (explicit; reads prod_relay_url written by install --prod):
  pocketctl daemon start --prod

Options:
  --relay <url>  Relay WebSocket URL (overrides default production relay)
  --prod         Use production relay from config (prod_relay_url)
  --email        Login via email verification code (headless servers)
  --foreground   Run daemon in foreground (don't daemonize)
  --debug        Verbose debug logs streamed to console (implies --foreground)
  --token <t>    JWT token (or POCKETCTL_TOKEN env)
  --id <id>      Daemon ID (auto-generated if empty)
  --trusted-action-policy <off|observe|on>  Trusted approval policy; daemon service install persists it
  --no-agent-auto-enable  Skip optional managed-agent detection and auto-enable
  --no-agent-prompt       Deprecated alias for --no-agent-auto-enable

OpenCode terminal control:
  pocketctl agent opencode enable     Enable once; then continue using the normal opencode command
  pocketctl agent opencode disable    Remove the Pocketctl launcher without uninstalling OpenCode
  pocketctl agent opencode status     Show detection and launcher state
  opencode --native                   Bypass Pocketctl for one invocation

Codex terminal control (requires Codex 0.144.1+):
  pocketctl agent codex enable        Enable once; daemon restart is not required
  pocketctl agent codex disable       Remove the Pocketctl launcher without uninstalling Codex
  pocketctl agent codex status        Show desired/effective state and capability diagnostics
  codex --native                      Bypass Pocketctl for one invocation

ZCode session content sync (read-only):
  pocketctl agent zcode sync enable   Sync recent ZCode sessions to Web/iOS (read-only; restart daemon to take effect)
  pocketctl agent zcode sync enable --history all            Backfill all history
  pocketctl agent zcode sync enable --lookback-days 30       Custom lookback window (default 7, range 1..3650)
  pocketctl agent zcode sync disable  Stop syncing (uploaded sessions are NOT deleted; delete them in Web/iOS)
  pocketctl agent zcode sync status   Show sync state (never prints session content)
  Note: ZCode sessions are view-only. No remote send/approve/resume/control.

Environment:
  POCKETCTL_RELAY_URL   Relay WebSocket URL (e.g. ws://localhost:8080/ws, wss://relay.example.com/ws)
  POCKETCTL_TOKEN       JWT token for authentication`

const helpZh = `pocketctl - 远程 AI 编程代理控制

用法:
  pocketctl <命令> [选项]

命令:
  login          通过浏览器（OAuth 2.0 Device Flow）或邮箱验证码登录
  agent opencode enable|disable|status   管理透明 OpenCode 终端控制
  agent codex enable|disable|status      管理 Codex 官方 TUI 终端控制
  agent zcode sync enable|disable|status 只读同步 ZCode 会话（在 Web/iOS 查看）
  daemon start   启动 daemon（连接 relay）
  daemon stop    停止运行中的 daemon
  daemon status  查看 daemon 状态
  daemon logs    查看 daemon 日志
  daemon doctor  诊断连接和配置问题
  daemon update  更新到最新版本
  daemon service 安装/卸载原生自动重启服务（launchd/systemd）
  daemon keep-awake on|off|status   阻止系统休眠（电池供电时自动关闭）
  uninstall      卸载 pocketctl，删除二进制和所有本地数据
  version        打印版本号
  help           显示此帮助

Relay 连接（默认: 生产环境 wss://www.pocketctl.me/ws）:
  默认情况下，login/daemon 连接到公共 relay wss://www.pocketctl.me/ws。
  使用 --relay <url> 或 POCKETCTL_RELAY_URL 覆盖，连接到其它 relay:

  # 本地 relay（运行在本机，默认端口 8080）:
  pocketctl daemon start --relay ws://localhost:8080/ws
  POCKETCTL_RELAY_URL=ws://localhost:8080/ws pocketctl daemon start

  # 自建 relay（你的域名，启用 TLS）:
  pocketctl daemon start --relay wss://relay.example.com/ws
  POCKETCTL_RELAY_URL=wss://relay.example.com/ws pocketctl login --email

  # 生产环境（显式指定；读取 install --prod 写入的 prod_relay_url）:
  pocketctl daemon start --prod

选项:
  --relay <url>  Relay WebSocket URL（覆盖默认生产 relay）
  --prod         使用配置中的生产 relay（prod_relay_url）
  --email        通过邮箱验证码登录（无浏览器环境）
  --foreground   前台运行 daemon（不后台化）
  --debug        调试日志实时输出到控制台（隐含 --foreground）
  --token <t>    JWT 令牌（或 POCKETCTL_TOKEN 环境变量）
  --id <id>      Daemon ID（为空则自动生成）
  --trusted-action-policy <off|observe|on>  可信审批策略；daemon service install 会持久化
  --no-agent-auto-enable  daemon 启动时跳过可选的 Agent 检测与自动启用
  --no-agent-prompt       --no-agent-auto-enable 的兼容别名（已弃用）

OpenCode 终端控制:
  pocketctl agent opencode enable     启用一次，之后仍直接使用普通 opencode 命令
  pocketctl agent opencode disable    移除 Pocketctl launcher，不卸载 OpenCode
  pocketctl agent opencode status     查看检测与 launcher 状态
  opencode --native                   单次绕过 Pocketctl

Codex 终端控制（要求 Codex 0.144.1+）:
  pocketctl agent codex enable        启用一次，无需重启 daemon
  pocketctl agent codex disable       移除 Pocketctl launcher，不卸载 Codex
  pocketctl agent codex status        查看期望/实际状态与能力诊断
  codex --native                      单次绕过 Pocketctl

ZCode 会话内容同步（只读）:
  pocketctl agent zcode sync enable   只读同步最近 ZCode 会话到 Web/iOS（重启 daemon 后生效）
  pocketctl agent zcode sync enable --history all            回填全部历史
  pocketctl agent zcode sync enable --lookback-days 30       自定义回溯窗口（默认 7 天，范围 1..3650）
  pocketctl agent zcode sync disable  停止同步（已上传会话不会被删除，请在 Web/iOS 单独删除）
  pocketctl agent zcode sync status   查看同步状态（不显示会话内容）
  说明: ZCode 会话为只读查看，不支持远程发送/审批/恢复/控制。

环境变量:
  POCKETCTL_RELAY_URL   Relay WebSocket URL（如 ws://localhost:8080/ws, wss://relay.example.com/ws）
  POCKETCTL_TOKEN       JWT 认证令牌`

// configDirDisplay is the user-facing name of the profile directory shown in
// the uninstall warning. Kept as a literal (not computed from runtime) so the
// warning text is stable for the literal "DELETE" confirmation prompt.
const configDirDisplay = "~/.pocketctl"

// messages is the bilingual message table, keyed by "<namespace>.<name>".
// Populated incrementally as call sites are migrated; see i18n.T for the
// fallback behaviour when a key is absent.
var messages = map[string]msg{
	// ---- help.* ----------------------------------------------------------
	"help.body": {helpEn, helpZh},

	// ---- agent.* ---------------------------------------------------------
	"agent.help": {
		"Agent control:\n  pocketctl agent opencode enable\n  pocketctl agent opencode disable\n  pocketctl agent opencode status\n  pocketctl agent opencode help\n  pocketctl agent codex enable\n  pocketctl agent codex disable\n  pocketctl agent codex status\n  pocketctl agent codex help\n  pocketctl agent claude-code enable\n  pocketctl agent claude-code disable\n  pocketctl agent claude-code status\n  pocketctl agent claude-code help\n  pocketctl agent zcode sync enable [--history recent|all] [--lookback-days N]\n  pocketctl agent zcode sync disable\n  pocketctl agent zcode sync status\n  pocketctl agent zcode sync help\n\nManaged agents (opencode/codex): enable does not require a daemon restart. Reload your login shell if PATH is not active. Use `opencode --native` or `codex --native` to bypass Pocketctl once.\nClaude Code (claude-code): installs a Terminal shim that injects the Pocketctl Channel permission relay for interactive Claude sessions. The native Claude terminal approval is always preserved; use `claude --native` to bypass once. Requires Claude Code >= 2.1.211 and the POCKETCTL_CLAUDE_CHANNEL_APPROVAL rollout flag.\nZCode sync is read-only: it surfaces local ZCode session content in Web/iOS. Enable requires a daemon restart to take effect. No remote send/approve/resume/control.",
		"Agent 控制:\n  pocketctl agent opencode enable\n  pocketctl agent opencode disable\n  pocketctl agent opencode status\n  pocketctl agent opencode help\n  pocketctl agent codex enable\n  pocketctl agent codex disable\n  pocketctl agent codex status\n  pocketctl agent codex help\n  pocketctl agent claude-code enable\n  pocketctl agent claude-code disable\n  pocketctl agent claude-code status\n  pocketctl agent claude-code help\n  pocketctl agent zcode sync enable [--history recent|all] [--lookback-days N]\n  pocketctl agent zcode sync disable\n  pocketctl agent zcode sync status\n  pocketctl agent zcode sync help\n\n托管型 Agent（opencode/codex）：启用后无需重启 daemon；若 PATH 尚未生效，请重新载入登录 shell。可用 `opencode --native` 或 `codex --native` 单次绕过 Pocketctl。\nClaude Code（claude-code）：安装终端 shim，为交互式 Claude 会话注入 Pocketctl Channel 权限中继。Claude 原生终端审批始终保留；可用 `claude --native` 单次绕过。需要 Claude Code >= 2.1.211 与 POCKETCTL_CLAUDE_CHANNEL_APPROVAL 灰度开关。\nZCode 同步为只读：将本地 ZCode 会话内容展示到 Web/iOS。启用后需重启 daemon 生效。不支持远程发送/审批/恢复/控制。",
	},
	"agent.opencode_help": {
		"usage: pocketctl agent opencode <enable|disable|status|help>",
		"用法: pocketctl agent opencode <enable|disable|status|help>",
	},
	"agent.codex_help": {
		"usage: pocketctl agent codex <enable|disable|status|help>",
		"用法: pocketctl agent codex <enable|disable|status|help>",
	},
	"agent.claude-code_help": {
		"usage: pocketctl agent claude-code <enable|disable|status|help>",
		"用法: pocketctl agent claude-code <enable|disable|status|help>",
	},
	"agent.claude-code_research_preview": {
		"Claude Code Channels is a research preview. The native terminal approval remains authoritative; Pocketctl only relays Web/iOS approval cards. Terminal, daemon, relay or channel failures fall back to native Claude within 200ms.",
		"Claude Code Channels 处于研究预览阶段。原生终端审批始终为权威；Pocketctl 仅转发 Web/iOS 审批卡。终端、daemon、Relay 或 Channel 故障都会在 200ms 内回退原生 Claude。",
	},
	"agent.unknown":          {"unknown agent command: %s", "未知的 Agent 命令: %s"},
	"agent.unknown_action":   {"unknown %s action: %s", "未知的 %s 操作: %s"},
	"agent.no_shell_profile": {"Do not modify the shell profile or PATH", "不修改 shell 配置或 PATH"},
	"agent.enabled":          {"%s terminal control enabled (real binary: %s); daemon restart is not required", "%s 终端控制已启用（真实 binary: %s）；无需重启 daemon"},
	"agent.disabled":         {"%s terminal control disabled; daemon restart is not required", "%s 终端控制已关闭；无需重启 daemon"},
	"agent.opencode_prompt": {
		"OpenCode was detected. Enable Pocketctl remote continuation for terminal OpenCode sessions? [y/N] ",
		"检测到 OpenCode，是否为终端 OpenCode 会话启用 Pocketctl 远程接续？[y/N] ",
	},
	"agent.prompt_warning":    {"OpenCode setup warning: %v", "OpenCode 设置警告: %v"},
	"agent.status_agent":      {"Agent: %s", "Agent: %s"},
	"agent.status_detected":   {"Detected: %s", "已检测: %s"},
	"agent.status_version":    {"Version: %s", "版本: %s"},
	"agent.status_state":      {"State: %s", "状态: %s"},
	"agent.status_effective":  {"Effective mode: %s", "实际模式: %s"},
	"agent.status_binary":     {"Real binary: %s", "真实 binary: %s"},
	"agent.status_launcher":   {"Launcher: %s", "Launcher: %s"},
	"agent.status_path":       {"PATH active: %s", "PATH 已生效: %s"},
	"agent.status_runtime":    {"Runtime reachable: %s", "Runtime 可连接: %s"},
	"agent.status_error":      {"Diagnostic: %s", "诊断: %s"},
	"agent.status_capability": {"Capability: %s", "能力: %s"},
	"agent.yes":               {"yes", "是"},
	"agent.no":                {"no", "否"},

	// ---- agent.zcode.* (read-only session content sync) -----------------
	"agent.zcode_help": {
		"usage: pocketctl agent zcode sync <enable|disable|status|help>",
		"用法: pocketctl agent zcode sync <enable|disable|status|help>",
	},
	"agent.zcode_sync_help": {
		"ZCode session content sync (read-only):\n  pocketctl agent zcode sync enable [--history recent|all] [--lookback-days N] [--storage-dir PATH]\n  pocketctl agent zcode sync disable\n  pocketctl agent zcode sync status\n\nZCode sessions are read from the local ZCode SQLite store and uploaded for viewing only. There is no remote input, approval, resume, or control.",
		"ZCode 会话内容同步（只读）:\n  pocketctl agent zcode sync enable [--history recent|all] [--lookback-days N] [--storage-dir PATH]\n  pocketctl agent zcode sync disable\n  pocketctl agent zcode sync status\n\nZCode 会话从本地 ZCode SQLite 存储读取并上传以供查看。不支持远程输入、审批、恢复或控制。",
	},
	"agent.zcode_unknown_action": {"unknown zcode sync action: %s", "未知的 zcode sync 操作: %s"},
	"agent.zcode_enabled_restart": {
		"ZCode session content sync enabled (history=%s, lookback=%dd). Restart the daemon for it to take effect: pocketctl daemon restart",
		"ZCode 会话内容同步已启用（history=%s，lookback=%dd）。需要重启 daemon 后生效：pocketctl daemon restart",
	},
	"agent.zcode_enable_failed": {"ZCode sync enable failed: %s", "ZCode 同步启用失败: %s"},
	"agent.zcode_disabled": {
		"ZCode session content sync disabled. New sync stops within 5 seconds; already-uploaded sessions are NOT deleted (delete them separately in PocketCtl). A daemon restart is needed only to refresh the agent advertisement.",
		"ZCode 会话内容同步已关闭。新同步最迟 5 秒内停止；已上传的会话不会被删除（请在 PocketCtl 中单独删除）。仅在刷新 daemon agent 上报时才需要重启。",
	},
	"agent.zcode_disable_failed":         {"ZCode sync disable failed: %s", "ZCode 同步关闭失败: %s"},
	"agent.zcode_status_header":          {"ZCode session content sync (read-only)", "ZCode 会话内容同步（只读）"},
	"agent.zcode_status_enabled":         {"Enabled: %s", "已启用: %s"},
	"agent.zcode_status_history":         {"History scope: %s", "历史范围: %s"},
	"agent.zcode_status_lookback":        {"Lookback (days): %d", "回溯天数: %d"},
	"agent.zcode_status_storage":         {"Storage dir: %s", "存储目录: %s"},
	"agent.zcode_status_schema":          {"Schema state: %s", "Schema 状态: %s"},
	"agent.zcode_status_source":          {"Source id: %s", "Source id: %s"},
	"agent.zcode_status_no_session_info": {"(session contents are not shown here; they are viewable in Web/iOS after sync)", "（此处不显示会话内容；同步后可在 Web/iOS 查看）"},
	"agent.zcode_schema_ok":              {"compatible", "兼容"},
	"agent.zcode_schema_unknown":         {"not probed", "未探测"},
	"agent.zcode_schema_incompatible":    {"incompatible", "不兼容"},

	// ---- daemon.* (start banner / stop / shutdown) -----------------------
	"daemon.started": {
		"pocketctl daemon started (ID: %s, PID: %d)",
		"pocketctl 守护进程已启动 (ID: %s, PID: %d)",
	},
	"daemon.relay":           {"Relay: %s", "Relay: %s"},
	"daemon.version":         {"Version: %s", "版本: %s"},
	"daemon.starting":        {"Starting pocketctl daemon...", "正在启动 pocketctl 守护进程..."},
	"daemon.relay_connected": {"Relay: %s (connected)", "Relay: %s (已连接)"},
	"daemon.relay_connecting": {
		"Relay: %s (connecting in background)",
		"Relay: %s (后台连接中)",
	},
	"daemon.start_failed": {
		"daemon failed to start — check logs: %s",
		"守护进程启动失败 — 请查看日志: %s",
	},
	"daemon.start_uncertain": {
		"Startup uncertainty: daemon status could not be verified.",
		"启动状态不确定：无法验证 Daemon 状态。",
	},
	"daemon.start_uncertain_permission": {
		"Startup uncertainty: permission denied while reading daemon runtime metadata.",
		"启动状态不确定：读取 Daemon 运行元数据时权限不足。",
	},
	"daemon.start_uncertain_runtime": {
		"Startup uncertainty: daemon runtime ownership metadata could not be verified.",
		"启动状态不确定：无法验证 Daemon 运行身份元数据。",
	},
	"daemon.start_uncertain_state": {
		"Startup uncertainty: initial daemon state could not be read or persisted.",
		"启动状态不确定：无法读取或持久化 Daemon 初始状态。",
	},
	"daemon.start_uncertain_identity": {
		"Startup uncertainty: daemon process identity could not be verified.",
		"启动状态不确定：无法验证 Daemon 进程身份。",
	},
	"daemon.agents":              {"Agents: %s", "Agents: %s"},
	"daemon.agent_status_header": {"Managed agent checks:", "Managed Agent 检测:"},
	"daemon.agent_status_line": {
		"  %s: detected=%s, version=%s, enable=%s",
		"  %s: 已检测=%s, 版本=%s, enable=%s",
	},
	"daemon.agent_enable_success":     {"successful", "成功"},
	"daemon.agent_enable_failed":      {"failed (%s)", "失败 (%s)"},
	"daemon.agent_enable_fallback":    {"enabled, native fallback (%s)", "已启用，降级为原生模式 (%s)"},
	"daemon.agent_enable_disabled":    {"disabled", "已禁用"},
	"daemon.agent_enable_skipped":     {"skipped", "已跳过"},
	"daemon.agent_enable_not_enabled": {"not enabled", "未启用"},
	"daemon.logs":                     {"Logs: %s", "日志: %s"},
	"daemon.debug_banner": {
		"🐛 debug mode: streaming all logs to console (level=DEBUG); full log also at %s. Press Ctrl-C to stop.",
		"🐛 调试模式：所有日志实时输出到控制台 (level=DEBUG)；完整日志同时写入 %s。按 Ctrl-C 停止。",
	},
	"daemon.shutting_down": {"\nShutting down...", "\n正在关闭..."},
	"daemon.stopped":       {"Daemon stopped", "Daemon 已停止"},
	"daemon.not_running":   {"Daemon is not running", "Daemon 未运行"},
	"daemon.status_uncertain": {
		"Daemon status cannot be confirmed: %v",
		"无法确认 Daemon 状态：%v",
	},
	"daemon.initial_state_fail": {
		"Failed to persist initial daemon state; startup aborted: %v",
		"持久化 Daemon 初始状态失败；已中止启动：%v",
	},
	"daemon.running_no_state": {
		"Daemon running (PID %d), state unavailable",
		"Daemon 运行中 (PID %d)，状态不可用",
	},
	"daemon.usage_sub": {
		"usage: pocketctl daemon <start|stop|status|logs|doctor|update|service|keep-awake>",
		"用法: pocketctl daemon <start|stop|status|logs|doctor|update|service|keep-awake>",
	},
	"daemon.unknown_sub":     {"unknown daemon subcommand: %s", "未知的 daemon 子命令: %s"},
	"daemon.already_running": {"daemon already running (PID %d)", "守护进程已在运行 (PID %d)"},
	"daemon.lock_held":       {"another pocketctl daemon instance holds the single-instance lock; if this is wrong, stop it first with `pocketctl daemon stop`", "另一个 pocketctl 守护进程持有单实例锁;如属异常,请先用 `pocketctl daemon stop` 停止它"},

	// ---- keepawake.* (sleep prevention) ----------------------------------
	// 用法: pocketctl daemon keep-awake on|off|status
	// 开启后若检测到电池供电,daemon 会在下次轮询(≤60s)自动关闭以保护电量,
	// 不推送通知,需手动 status 查看。
	"keepawake.usage": {
		"usage: pocketctl daemon keep-awake <on|off|status>   (prevent system sleep; auto-disables on battery)",
		"用法: pocketctl daemon keep-awake <on|off|status>   (阻止系统休眠;电池供电时自动关闭)",
	},
	"keepawake.bad_action": {
		"unknown keep-awake action: %s (expected on|off|status)",
		"未知的 keep-awake 操作: %s (应为 on|off|status)",
	},
	"keepawake.connect_failed": {
		"could not reach daemon",
		"无法连接 daemon",
	},
	"keepawake.failed": {
		"keep-awake failed: %s",
		"keep-awake 失败: %s",
	},
	"keepawake.state_on":  {"state: ON (system sleep prevented)", "状态: 已开启 (阻止系统休眠)"},
	"keepawake.state_off": {"state: OFF", "状态: 已关闭"},
	"keepawake.reason":    {"reason: %s", "原因: %s"},

	// ---- service.* (native supervisor install/uninstall/status) ----------
	"service.usage_sub": {
		"usage: pocketctl daemon service <install|uninstall|status>",
		"用法: pocketctl daemon service <install|uninstall|status>",
	},
	"service.unknown_sub": {"unknown service subcommand: %s", "未知的 service 子命令: %s"},
	"service.no_token": {
		"No stored auth token. Run 'pocketctl login' before installing the service.",
		"未找到已保存的登录令牌。请先运行 'pocketctl login' 再安装服务。",
	},
	"service.stopping_standalone": {
		"Stopping standalone daemon (PID %d) before handing off to the supervisor...",
		"先停止独立运行的 daemon (PID %d)，再交由系统服务接管...",
	},
	"service.stop_standalone_fail": {
		"failed to stop standalone daemon; service install aborted: %v",
		"停止独立 daemon 失败；已中止服务安装：%v",
	},
	"service.installed": {
		"Service installed and started: %s",
		"服务已安装并启动: %s",
	},
	"service.install_fail":   {"install service failed: %v", "安装服务失败: %v"},
	"service.uninstalled":    {"Service uninstalled", "服务已卸载"},
	"service.uninstall_fail": {"uninstall service failed: %v", "卸载服务失败: %v"},
	"service.status_fail":    {"query service status failed: %v", "查询服务状态失败: %v"},
	"service.unit_path":      {"Unit:      %s", "服务文件:  %s"},
	"service.linger_note": {
		"Tip: lingering was enabled so the daemon survives logout. If it was denied, run: loginctl enable-linger $USER",
		"提示: 已尝试开启 linger 使 daemon 在登出后继续运行。若被拒绝，请手动运行: loginctl enable-linger $USER",
	},
	"service.status_installed": {"Installed:  %s", "已安装:    %s"},
	"service.status_loaded":    {"Loaded:     %s", "已加载:    %s"},
	"service.status_running":   {"Running:    %s", "运行中:    %s"},
	"service.status_pid":       {"PID:        %d", "PID:       %d"},
	"service.status_last_exit": {"Last exit:  %d", "上次退出码: %d"},
	"service.status_detail":    {"Detail:    %s", "详情:      %s"},
	"service.supervisor_unloaded": {
		"Supervisor is not loaded",
		"系统服务未加载",
	},
	"service.reinstall_hint": {
		"Recover with: pocketctl daemon service install",
		"恢复命令: pocketctl daemon service install",
	},
	"service.yes": {"yes", "是"},
	"service.no":  {"no", "否"},

	// ---- status.* (cmdDaemonStatus table; labels stay English to keep
	// column alignment, only values localize) ------------------------------
	"status.daemon":       {"Daemon: %s", "Daemon: %s"},
	"status.version":      {"Version: %s", "版本: %s"},
	"status.unknown":      {"unknown", "未知"},
	"status.pid":          {"PID:    %d", "PID:    %d"},
	"status.relay":        {"Relay:  %s", "Relay:  %s"},
	"status.account":      {"Account: %s", "登录邮箱: %s"},
	"status.status_line":  {"Status: %s", "Status: %s"},
	"status.started":      {"Started: %s", "Started: %s"},
	"status.connected":    {"connected", "已连接"},
	"status.disconnected": {"disconnected", "未连接"},
	"status.reconnecting": {"reconnecting", "正在重新连接"},
	"status.backpressured": {
		"relay backpressured",
		"中继服务繁忙",
	},
	"status.auth_uncertain": {
		"authentication uncertain",
		"身份验证状态不确定",
	},
	"status.login_required": {"login required", "需要重新登录"},
	"status.revoked":        {"access revoked", "访问权限已撤销"},
	"status.stopped":        {"stopped", "已停止"},
	"status.connection_unknown": {
		"unknown (%s)",
		"未知 (%s)",
	},
	"status.reason":      {"Reason: %s", "原因: %s"},
	"status.updated":     {"Updated: %s", "更新时间: %s"},
	"status.sessions":    {"\nSessions (%d):", "\n会话 (%d):"},
	"status.session_row": {"  %s  %-10s  %s", "  %s  %-10s  %s"},

	// ---- error.* (stderr) ------------------------------------------------
	"error.generic":         {"error: %v", "错误: %v"},
	"error.executable_path": {"failed to get executable path: %v", "获取可执行文件路径失败: %v"},
	"error.daemonize":       {"failed to daemonize: %v", "后台化失败: %v"},
	"error.token_required": {
		"error: token required. Run 'pocketctl login' first, or set --token / POCKETCTL_TOKEN",
		"错误: 需要令牌。请先运行 'pocketctl login'，或设置 --token / POCKETCTL_TOKEN",
	},
	"error.prod_requires_url": {
		"error: --prod requires prod_relay_url in config. Run the install script with --prod first, or set POCKETCTL_RELAY_URL.",
		"错误: --prod 需要配置中的 prod_relay_url。请先用 --prod 运行安装脚本，或设置 POCKETCTL_RELAY_URL。",
	},
	"error.unknown_command": {"unknown command: %s", "未知命令: %s"},
	"error.read_log":        {"error reading log: %v", "读取日志失败: %v"},
	"error.create_log_dir":  {"create log dir %s: %v (check if the path is occupied by a file)", "创建日志目录 %s 失败: %v（请检查该路径是否被文件占用）"},

	// ---- login.* ---------------------------------------------------------
	"login.title":           {"pocketctl login", "pocketctl 登录"},
	"login.separator":       {"---------------", "---------------"},
	"login.use_email":       {"Login via email verification code (--email)", "使用邮箱验证码登录 (--email)"},
	"login.no_browser":      {"No browser detected, falling back to email login", "检测到无浏览器环境，使用邮箱验证码登录"},
	"login.use_oauth":       {"Login via browser (OAuth 2.0 Device Flow)", "使用浏览器授权登录 (OAuth 2.0 Device Flow)"},
	"login.requesting_auth": {"Requesting device authorization...", "正在请求设备授权..."},
	"login.check_ok":        {" ✅", " ✅"},
	"login.opening_browser": {"\nOpening browser for authorization...", "\n正在打开浏览器进行授权..."},
	"login.manual_open":     {"If the browser does not open, visit:", "如果浏览器未自动打开，请手动访问:"},
	"login.waiting":         {"Waiting for authorization", "等待授权"},
	"login.waiting_auth":    {"\rWaiting for authorization... (%ds elapsed)", "\r等待授权... (已等待 %ds)"},
	"login.auth_ok":         {"\n✅ Authorization successful!", "\n✅ 授权成功!"},
	"login.email_prompt":    {"Email address: ", "邮箱地址: "},
	"login.sending_code":    {"Sending verification code...", "正在发送验证码..."},
	"login.code_sent":       {" ✅ Sent", " ✅ 已发送"},
	"login.code_prompt":     {"Verification code: ", "验证码: "},
	"login.verifying":       {"Verifying...", "正在验证..."},
	"login.success":         {"\n✅ Login successful!", "\n✅ 登录成功!"},
	"login.token_saved":     {"Token saved to ~/.pocketctl/auth.json", "Token 已保存到 ~/.pocketctl/auth.json"},
	"login.next_step": {
		"You can now run 'pocketctl daemon start'",
		"现在可以运行 'pocketctl daemon start' 启动守护进程",
	},
	"login.failed":      {"\nLogin failed: %v", "\n登录失败: %v"},
	"login.save_failed": {"\nSave failed: %v", "\n保存失败: %v"},
	// login errors (bubble up to the user); templates keep %w so Errorf wraps
	"login.pkce_failed":     {"generate PKCE verifier failed: %v", "生成 PKCE 验证码失败: %v"},
	"login.auth_req_failed": {"authorization request failed: %v", "请求授权失败: %v"},
	"login.auth_timeout":    {"authorization timed out, please run pocketctl login again", "授权超时，请重新运行 pocketctl login"},
	"login.auth_failed":     {"authorization failed: %s", "授权失败: %s"},
	"login.invalid_email":   {"please enter a valid email address", "请输入有效的邮箱地址"},
	"login.send_failed":     {"send failed: %v", "发送失败: %v"},
	"login.invalid_code":    {"please enter the 6-digit code", "请输入6位验证码"},

	// ---- doctor.* (cmdDoctor) --------------------------------------------
	"doctor.title":          {"pocketctl doctor", "pocketctl 诊断"},
	"doctor.rule":           {"════════════════════════════════════", "════════════════════════════════════"},
	"doctor.check_pass":     {"  ✅ %s: %s", "  ✅ %s: %s"},
	"doctor.check_fail":     {"  ❌ %s: %s", "  ❌ %s: %s"},
	"doctor.check_config":   {"Config file", "配置文件"},
	"doctor.check_token":    {"Auth token", "认证令牌"},
	"doctor.check_dns":      {"DNS resolution", "DNS 解析"},
	"doctor.check_http":     {"HTTP reachability", "HTTP 连通"},
	"doctor.check_relay":    {"Relay health", "Relay 健康"},
	"doctor.check_ws":       {"WebSocket connection", "WebSocket 连接"},
	"doctor.check_auth":     {"Authentication", "认证通过"},
	"doctor.check_limit":    {"Daemon limit", "Daemon 限制"},
	"doctor.not_logged_in":  {"not logged in, run pocketctl login", "未登录，请运行 pocketctl login"},
	"doctor.config_exists":  {"~/.pocketctl/auth.json exists", "~/.pocketctl/auth.json 存在"},
	"doctor.token_invalid":  {"invalid token format", "Token 格式无效"},
	"doctor.token_expired":  {"token expired, please log in again", "Token 已过期，请重新登录"},
	"doctor.token_valid":    {"valid, expires %s", "有效，过期时间 %s"},
	"doctor.no_token":       {"no token, run pocketctl login", "无 Token，请运行 pocketctl login"},
	"doctor.dns_fail":       {"cannot resolve host: %s", "无法解析域名: %s"},
	"doctor.dns_ok":         {"%s → %s", "%s → %s"},
	"doctor.dns_no_host":    {"cannot extract host from URL", "无法从 URL 提取域名"},
	"doctor.http_fail":      {"cannot connect to %s: %v", "无法连接 %s: %v"},
	"doctor.http_ok":        {"HTTP 200 (%dms)", "HTTP 200 (%dms)"},
	"doctor.relay_ok":       {"status: ok", "status: ok"},
	"doctor.relay_status":   {"status: %s", "status: %s"},
	"doctor.relay_no_http":  {"cannot check (HTTP connection failed)", "无法检查（HTTP 连接失败）"},
	"doctor.ws_fail":        {"WebSocket connection failed", "WebSocket 连接失败"},
	"doctor.ws_ok":          {"connected", "连接成功"},
	"doctor.ws_timeout":     {"read response timeout: %v", "读取响应超时: %v"},
	"doctor.cannot_check":   {"cannot check", "无法检查"},
	"doctor.auth_ack":       {"register_ack received", "register_ack 收到"},
	"doctor.limit_ok":       {"within limit", "未达限制"},
	"doctor.auth_ok":        {"authenticated", "认证成功"},
	"doctor.auth_fail":      {"authentication failed", "认证失败"},
	"doctor.auth_unknown":   {"unknown response: %s", "未知响应: %s"},
	"doctor.ws_missing":     {"missing relay URL or token", "缺少 relay URL 或 token"},
	"doctor.config_missing": {"missing configuration", "缺少配置"},
	"doctor.result_all_pass": {
		"  Result: all passed (%d/%d)",
		"  结果: 全部通过 (%d/%d)",
	},
	"doctor.result_partial": {
		"  Result: %d/%d passed, %d need fixing",
		"  结果: %d/%d 通过，%d 项需要修复",
	},
	"doctor.result_partial_no_relay": {
		"  Result: %d/%d passed (no relay URL configured, network not checked)",
		"  结果: %d/%d 通过（未配置 relay URL，无法检查网络）",
	},

	// ---- update.* (cmdDaemonUpdate) --------------------------------------
	"update.title":          {"  🔍 pocketctl self-update", "  🔍 pocketctl 自更新"},
	"update.current":        {"  Current version: %s", "  当前版本: %s"},
	"update.platform":       {"  Platform: %s/%s", "  运行平台: %s/%s"},
	"update.pinned":         {"  Pinned version: %s", "  指定版本: %s"},
	"update.query":          {"  Checking latest version...", "  查询最新版本..."},
	"update.query_fail":     {"\n  ❌ Version query failed: %v", "\n  ❌ 版本查询失败: %v"},
	"update.target":         {"  Target version: %s", "  目标版本: %s"},
	"update.already_latest": {"  ✅ Already up to date!", "  ✅ 已经是最新版本!"},
	"update.resolving":      {"  📦 Resolving download URL...", "  📦 解析下载地址..."},
	"update.resolve_fail":   {"\n  ❌ Resolve failed: %v", "\n  ❌ 解析失败: %v"},
	"update.download_name":  {"  Download: %s", "  下载: %s"},
	"update.checksum":       {"  Checksum: SHA256 = %s...%s", "  校验: SHA256 = %s...%s"},
	"update.downloading":    {"  ⬇️  Downloading...", "  ⬇️  下载中..."},
	"update.download_fail":  {"\n  ❌ Download failed: %v", "\n  ❌ 下载失败: %v"},
	"update.download_ok":    {"  ✅ Download complete, SHA256 verified", "  ✅ 下载完成，SHA256 校验通过"},
	"update.replacing":      {"  🔧 Replacing binary...", "  🔧 替换二进制..."},
	"update.replace_fail":   {"\n  ❌ Replace failed: %v", "\n  ❌ 替换失败: %v"},
	"update.replaced":       {"  ✅ Binary updated", "  ✅ 二进制已更新"},
	"update.permission_hint": {
		"  💡 Tip: if permission denied, run with sudo:",
		"  💡 提示: 如果权限不足，请使用 sudo 运行:",
	},
	"update.check_daemon":   {"  🔄 Checking daemon status...", "  🔄 检查 Daemon 运行状态..."},
	"update.restart_fail":   {"  ⚠️  Restart failed: %v (please restart manually)", "  ⚠️  重启失败: %v (请手动重启)"},
	"update.done":           {"  🎉 Update complete!", "  🎉 更新完成!"},
	"update.version_change": {"  Version: %s → %s", "  版本: %s → %s"},
	"update.daemon_restarting": {
		"  🔄 Detected running Daemon (PID %d), restarting...",
		"  🔄 检测到运行中的 Daemon (PID %d)，正在重启...",
	},
	"update.daemon_restarted": {"  ✅ Daemon restarted (new PID %d)", "  ✅ Daemon 已重启 (新 PID %d)"},
	"update.daemon_idle": {
		"  ℹ️   Daemon not running, new version ready. Run 'pocketctl daemon start'.",
		"  ℹ️   Daemon 未在运行，新版本已就绪。运行 'pocketctl daemon start' 启动。",
	},

	// ---- uninstall.* (cmdUninstall) --------------------------------------
	"uninstall.title":        {"pocketctl uninstall", "pocketctl 卸载"},
	"uninstall.will_remove":  {"The following will be removed:", "以下内容将被删除:"},
	"uninstall.desc_config":  {"config & auth", "配置与登录凭证"},
	"uninstall.desc_runtime": {"runtime (pid/log)", "运行时文件 (pid/log)"},
	"uninstall.desc_binary":  {"binary", "二进制程序"},
	"uninstall.stop_daemon_note": {
		"The running daemon (if any) will be stopped first.",
		"运行中的 daemon（如有）将先被停止。",
	},
	"uninstall.confirm":         {"\nProceed? [y/N] ", "\n确认卸载? [y/N] "},
	"uninstall.aborted":         {"Aborted, nothing was removed.", "已取消，未删除任何内容。"},
	"uninstall.stopping_daemon": {"Stopping daemon (PID %d)...", "正在停止 daemon (PID %d)..."},
	"uninstall.stop_fail":       {"warning: stop daemon failed: %v", "警告: 停止 daemon 失败: %v"},
	"uninstall.removing":        {"Removing %s", "删除 %s"},
	"uninstall.remove_fail":     {"warning: remove %s failed: %v", "警告: 删除 %s 失败: %v"},
	"uninstall.binary_fail": {
		"warning: remove binary %s failed: %v",
		"警告: 删除二进制 %s 失败: %v",
	},
	"uninstall.binary_hint": {
		"  💡 Tip: if permission denied, run with sudo: sudo rm -f %s",
		"  💡 提示: 如果权限不足，请使用 sudo: sudo rm -f %s",
	},
	"uninstall.done": {"✅ pocketctl has been uninstalled.", "✅ pocketctl 已卸载完成。"},
	"uninstall.config_warning_title": {
		"⚠️  About to delete your pocketctl profile",
		"⚠️  即将删除 pocketctl 用户数据",
	},
	"uninstall.config_warning_body": {
		"This will permanently erase " + configDirDisplay + ", including:\n" +
			"  • auth.json — login tokens (you MUST re-run 'pocketctl login' afterwards)\n" +
			"  • machine.id — host identity (relay will show this as a NEW device next time)\n" +
			"  • logs/ & spool/ — all daemon history\n" +
			"This CANNOT be undone.",
		"将永久删除 " + configDirDisplay + "，包括:\n" +
			"  • auth.json — 登录凭证（删除后必须重新执行 'pocketctl login'）\n" +
			"  • machine.id — 机器标识（relay 下次会将其视为新设备）\n" +
			"  • logs/ 与 spool/ — 全部 daemon 历史记录\n" +
			"此操作不可恢复。",
	},
	"uninstall.config_confirm": {
		"\nDelete ~/.pocketctl? [y/N] ",
		"\n确认删除 ~/.pocketctl? [y/N] ",
	},
	"uninstall.config_skipped": {
		"~/.pocketctl kept (login tokens preserved).",
		"已保留 ~/.pocketctl（登录凭证未删除）。",
	},
}

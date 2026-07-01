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
  daemon start   Start the daemon (connects to relay)
  daemon stop    Stop the running daemon
  daemon status  Show daemon status
  daemon logs    Show daemon logs
  daemon doctor  Diagnose connection and configuration issues
  daemon update  Update daemon to the latest version
  daemon service Install/remove a native auto-restart service (launchd/systemd)
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

Environment:
  POCKETCTL_RELAY_URL   Relay WebSocket URL (e.g. ws://localhost:8080/ws, wss://relay.example.com/ws)
  POCKETCTL_TOKEN       JWT token for authentication`

const helpZh = `pocketctl - 远程 AI 编程代理控制

用法:
  pocketctl <命令> [选项]

命令:
  login          通过浏览器（OAuth 2.0 Device Flow）或邮箱验证码登录
  daemon start   启动 daemon（连接 relay）
  daemon stop    停止运行中的 daemon
  daemon status  查看 daemon 状态
  daemon logs    查看 daemon 日志
  daemon doctor  诊断连接和配置问题
  daemon update  更新到最新版本
  daemon service 安装/卸载原生自动重启服务（launchd/systemd）
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

环境变量:
  POCKETCTL_RELAY_URL   Relay WebSocket URL（如 ws://localhost:8080/ws, wss://relay.example.com/ws）
  POCKETCTL_TOKEN       JWT 认证令牌`

// messages is the bilingual message table, keyed by "<namespace>.<name>".
// Populated incrementally as call sites are migrated; see i18n.T for the
// fallback behaviour when a key is absent.
var messages = map[string]msg{
	// ---- help.* ----------------------------------------------------------
	"help.body": {helpEn, helpZh},

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
	"daemon.agents": {"Agents: %s", "Agents: %s"},
	"daemon.logs":   {"Logs: %s", "日志: %s"},
	"daemon.debug_banner": {
		"🐛 debug mode: streaming all logs to console (level=DEBUG); full log also at %s. Press Ctrl-C to stop.",
		"🐛 调试模式：所有日志实时输出到控制台 (level=DEBUG)；完整日志同时写入 %s。按 Ctrl-C 停止。",
	},
	"daemon.shutting_down": {"\nShutting down...", "\n正在关闭..."},
	"daemon.stopped":       {"Daemon stopped", "Daemon 已停止"},
	"daemon.not_running":   {"Daemon is not running", "Daemon 未运行"},
	"daemon.running_no_state": {
		"Daemon running (PID %d), state unavailable",
		"Daemon 运行中 (PID %d)，状态不可用",
	},
	"daemon.usage_sub": {
		"usage: pocketctl daemon <start|stop|status|logs|doctor|update|service>",
		"用法: pocketctl daemon <start|stop|status|logs|doctor|update|service>",
	},
	"daemon.unknown_sub":     {"unknown daemon subcommand: %s", "未知的 daemon 子命令: %s"},
	"daemon.already_running": {"daemon already running (PID %d)", "守护进程已在运行 (PID %d)"},
	"daemon.lock_held":      {"another pocketctl daemon instance holds the single-instance lock; if this is wrong, stop it first with `pocketctl daemon stop`", "另一个 pocketctl 守护进程持有单实例锁;如属异常,请先用 `pocketctl daemon stop` 停止它"},

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
	"service.status_running":   {"Running:    %s", "运行中:    %s"},
	"service.status_detail":    {"Detail:    %s", "详情:      %s"},
	"service.yes":              {"yes", "是"},
	"service.no":               {"no", "否"},

	// ---- status.* (cmdDaemonStatus table; labels stay English to keep
	// column alignment, only values localize) ------------------------------
	"status.daemon":       {"Daemon: %s", "Daemon: %s"},
	"status.pid":          {"PID:    %d", "PID:    %d"},
	"status.relay":        {"Relay:  %s", "Relay:  %s"},
	"status.status_line":  {"Status: %s", "Status: %s"},
	"status.started":      {"Started: %s", "Started: %s"},
	"status.connected":    {"connected", "已连接"},
	"status.disconnected": {"disconnected", "未连接"},
	"status.sessions":     {"\nSessions (%d):", "\n会话 (%d):"},
	"status.session_row":  {"  %s  %-10s  %s", "  %s  %-10s  %s"},

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
}

# pocketctl

**Your AI coding agents, in your pocket.**

Monitor and manage Claude Code, Codex, and OpenCode sessions from your phone or browser.

Official website: [pocketctl.me](https://www.pocketctl.me) · Web dashboard: [pocketctl.me/app](https://www.pocketctl.me/app)

The Gitee repository is the canonical source history. GitHub is a filtered public
mirror used for public review and release artifacts; commit IDs can differ between
the two repositories.

## Features

- 🤖 **Multi-agent** — Claude Code, Codex, and OpenCode share zero-config discovery and live history sync, while control follows each CLI's real runtime capabilities. Claude terminal sessions use idle/exited `--resume` handoff; managed Codex/OpenCode sessions use their shared runtimes. To add a new agent, register a `Provider` — see [docs/adding-an-agent.md](docs/adding-an-agent.md).
- 🖥️ **Real-time Monitoring** — Watch your AI coding sessions live from anywhere
- 🧠 **Claude Code handoff and daemon approvals** — Terminal Claude sessions sync through JSONL and can continue from another device while idle or after exit. Pocketctl-created Claude PTYs support Web/iOS tool approvals with request-ID convergence; independently started terminal sessions keep Claude's native terminal approval prompt and are not advertised as shared runtime. See [Claude cross-device control](docs/claude-cross-device-control.md).
- 📨 **Attention Inbox** — When enabled, Web and iOS collect pending approvals, questions, high-risk actions, and recovery signals in one actionable queue. Each item keeps its session context and explicit risk reason so decisions stay scoped to the requesting action.
- 🧩 **Native OpenCode experience** — Opt in to the Pocketctl launcher and a normal terminal `opencode` joins the daemon's shared runtime. The official TUI, Web, and iOS can continue the same managed session and resolve permissions/questions from any device; pre-existing independent processes remain safely read-only until resumed through the launcher. See [OpenCode managed terminal control](docs/opencode-managed-terminal.md).
- ⌨️ **Official Codex TUI, shared control** — With Codex CLI 0.144.1+, an optional Pocketctl launcher connects the official TUI and daemon to one managed app-server. Terminal, Web, and iOS share thread progress and first-writer-wins approvals/questions/MCP elicitation. See [Codex managed terminal control](docs/codex-managed-terminal.md).
- 🔭 **Read-only ZCode session sync** — Opt in to safely discover local ZCode sessions from its SQLite store and view their history in Web and iOS. Observer sessions never accept remote input, approvals, resume, or control.
- 📱 **iOS App (beta)** — Join the beta waitlist on the official website. In Settings, select **Test Environment** and enter your self-hosted Relay address to connect it.
- 🖧 **Hosts Dashboard** — System resource monitoring (CPU / Memory / Disk) with remote daemon restart
- 📌 **Session Management** — Pin, rename, export, and delete sessions with inline editing
- 📊 **Token Analytics** — Usage dashboard (daily / model / host breakdown); deleting a session never shrinks historical totals
- 🔔 **Push Notifications** — Get alerted when your agent needs attention
- 🔄 **Self-updating** — One command to update to the latest version
- 🌐 **Web Dashboard** — Full-featured Vue 3 SPA with dark/light theme, daemon & session management
- 🔐 **Secure** — OAuth 2.0 Device Authorization Grant (RFC 8628) + email verification fallback
- ⚡ **Lightweight** — Single binary, zero dependencies, runs on macOS and Linux

## Architecture

```
┌─────────────┐   HTTP/WS   ┌─────────────┐     WebSocket      ┌─────────────┐
│  iOS App +  │◄───────────►│    Relay     │◄──────────────────►│   Daemon    │
│  Web App    │             │   (Server)   │                    │  (Desktop)  │
└─────────────┘             └─────────────┘                    └─────────────┘
                                                                         │
                                                                   ┌─────┴─────┐
                                                                   │ AI Agents  │
                                                                   │ (Claude,   │
                                                                   │  Codex...) │
                                                                   └───────────┘
```

- **Daemon** — Runs on your development machine, discovers and monitors AI coding agent sessions
- **Relay** — WebSocket server that authenticates clients, persists session events for replay, and bridges mobile/web clients with daemons
- **Web** — Vue 3 SPA dashboard for browser-based monitoring, served at `/app`
- **iOS App** — Currently distributed as a beta; use Settings → Test Environment to connect a self-hosted Relay.

### Security and data boundary

Production traffic uses HTTPS/WSS, but session and tool content is not end-to-end
encrypted. The Relay can read and persist content needed for routing, history
replay, notifications, and account features. If `DEEPSEEK_API_KEY` is configured,
the Relay may send the text needed to generate a session title to DeepSeek; without
that key, title generation is skipped. See the privacy policy on the official
website for the current collection, retention, processor, and deletion details.

The public service is available at [pocketctl.me](https://www.pocketctl.me). The browser client is served from
[`/app`](https://www.pocketctl.me/app); the root URL contains product information and client entry points.

## Quick Start

### Install

```bash
# Install the latest published binary and verify its SHA256 checksum
curl -fsSL https://www.pocketctl.me/install.sh | bash
```

### Login

```bash
# Desktop: OAuth 2.0 Device Flow (opens browser)
pocketctl login --prod

# Headless server: email verification code
pocketctl login --prod --email
```

### Start the Daemon

```bash
pocketctl daemon start --prod
```

### Check Status

```bash
pocketctl daemon status
```

### Optional: Share New OpenCode Terminal Sessions

```bash
pocketctl agent opencode enable
# Open a new shell, then keep using OpenCode normally.
opencode
```

This installs a reversible Pocketctl launcher, not another OpenCode distribution. If the daemon is unavailable, it quickly falls back to the real OpenCode binary. See the [behavior, security boundaries, compatibility policy, and rollback guide](docs/opencode-managed-terminal.md).

### Optional: Share Codex TUI Sessions

```bash
pocketctl agent codex enable
# Open a new shell if PATH changed, then use the official TUI normally.
codex
codex resume <thread-id>
```

No daemon restart or separate app-server connection command is required. Missing/old Codex only produces a daemon-start warning and keeps native fallback. See the [Codex behavior, recovery, and security guide](docs/codex-managed-terminal.md).

## Commands

| Command | Description |
|---------|-------------|
| `pocketctl login [--prod]` | Login via browser (OAuth 2.0 Device Flow) or email code (`--email`) |
| `pocketctl daemon start [--prod]` | Start the daemon |
| `pocketctl daemon stop` | Stop the running daemon |
| `pocketctl daemon status` | Show daemon status and active sessions |
| `pocketctl daemon logs` | View daemon logs |
| `pocketctl daemon doctor` | Diagnose connection issues |
| `pocketctl daemon update` | Update to the latest version |
| `pocketctl agent opencode enable [--no-shell-profile]` | Opt in to shared OpenCode terminal control |
| `pocketctl agent opencode disable` | Remove the Pocketctl launcher without uninstalling OpenCode |
| `pocketctl agent opencode status` | Show OpenCode detection, launcher, PATH, and runtime state |
| `opencode --native ...` | Bypass Pocketctl for one OpenCode invocation |
| `pocketctl agent codex enable [--no-shell-profile]` | Opt in to official Codex TUI managed control (Codex 0.144.1+) |
| `pocketctl agent codex disable` | Remove the Pocketctl launcher without uninstalling Codex |
| `pocketctl agent codex status` | Show Codex detection, capabilities, launcher, PATH, and runtime state |
| `codex --native ...` | Bypass Pocketctl for one Codex invocation |
| `pocketctl agent zcode sync enable [--history recent\|all] [--lookback-days N]` | Enable read-only ZCode session sync; restart the daemon to apply it |
| `pocketctl agent zcode sync disable` | Stop new ZCode session sync without deleting sessions already uploaded |
| `pocketctl agent zcode sync status` | Show ZCode sync configuration and local schema compatibility without printing session content |
| `pocketctl uninstall [--yes] [--keep-binary]` | Remove daemon, config, and data directories |
| `pocketctl version` | Print version |

## Environment Variables

| Variable | Description |
|----------|-------------|
| `POCKETCTL_RELAY_URL` | Relay WebSocket URL (e.g. `wss://your-domain.com/ws`) |
| `POCKETCTL_TOKEN` | JWT token for authentication |
| `POCKETCTL_CODEX_REPLAY_LOOKBACK` | Codex startup replay window for historical subagent events (default: `24h`; set to `0` to disable historical replay) |
| `SES_FROM_EMAIL` | Sender email address for verification emails |
| `SES_REGION` | Tencent Cloud SES region (default: `ap-hongkong`) |
| `DEV_EMAIL` | Dev mode test email address |
| `DEV_EMAIL_CODE` | Dev mode test verification code |
| `DEEPSEEK_API_KEY` | DeepSeek API key for session title generation |
| `WEB_APP_URL` | Public base URL for OAuth device authorization redirect |

## Build from Source

```bash
git clone https://github.com/pocketctl/pocketctl.git
cd pocketctl
make build
```

## Self-Update

```bash
# Update to the latest version
pocketctl daemon update

# Update to a specific version
pocketctl daemon update --version v0.1.0
```

## Project Structure

```
pocketctl/
├── cmd/pocketctl/main.go          # CLI entry point
├── internal/
│   ├── adapter/                   # Agent output parsers (Claude Code JSONL)
│   ├── api/                       # HTTP API client (auth)
│   ├── approval/                  # Tool approval broker and hook integration
│   ├── commands/                  # Daemon command handlers
│   ├── config/                    # Config management (~/.pocketctl/auth.json)
│   ├── daemon/                    # PID file, daemon state, machine ID
│   ├── discovery/                 # Agent CLI auto-discovery
│   ├── i18n/                      # CLI locale and translated messages
│   ├── keepawake/                 # Keep the host awake during active sessions
│   ├── platform/                  # OS-specific process and service helpers
│   ├── ptyscan/                   # Terminal/process discovery helpers
│   ├── service/                   # Background service integration
│   ├── notify/                    # Terminal notifications
│   ├── protocol/                  # WebSocket message type definitions
│   ├── session/                   # Session lifecycle management
│   ├── sysinfo/                   # System resource collection (CPU/Memory/Disk via gopsutil)
│   ├── update/                    # Self-update (version check, download, verify)
│   ├── watcher/                   # Session file monitoring (fsnotify, JSONL tailing)
│   └── ws/                        # WebSocket client with auto-reconnect
├── relay/
│   └── src/
│       ├── server.ts              # Fastify HTTP + WebSocket server
│       ├── router.ts              # WebSocket message routing
│       ├── auth.ts                # JWT sign/verify with jti revocation
│       ├── db.ts                  # PostgreSQL queries
│       ├── push.ts                # Push notification service
│       ├── title.ts               # DeepSeek-V4-Flash title generation
│       └── config/
│           ├── clients.ts         # OAuth 2.0 client registry
│           ├── auth-sessions.ts   # Device authorization session store
│           ├── email.ts           # Tencent Cloud SES email client
│           └── verification.ts    # Shared verification code store
├── web/                           # Vue 3 web dashboard
│   └── src/
│       ├── views/                 # DashboardView, SessionDetail, TokenUsage, HostsView, SettingsView, LoginView, DeviceAuthView
│       ├── composables/           # useAuth, useWebSocket, useCountdown, useRelativeTime, useSessionRename
│       ├── components/            # SessionActions, SessionTimeline, NewSessionDialog, SubAgentCard, MarkdownRenderer, etc.
│       └── assets/                # Design system CSS, logo SVGs
├── scripts/
│   ├── install-daemon.sh          # One-line installer
│   └── sync-github.sh             # Sync to GitHub
├── go.mod
└── go.sum
```

## Tech Stack

| Component | Technology |
|-----------|------------|
| Daemon | Go 1.25, gorilla/websocket, fsnotify, gopsutil |
| Relay | TypeScript, Fastify v5, @fastify/websocket, PostgreSQL |
| Web UI | Vue 3, Vue Router 4, Vite 6, TypeScript |

## Deployment

The only supported self-hosting entry points are the hardened paths:

- `docker-compose.prod.yml` — compose deployment; `TLS_CERT_PATH`/`TLS_KEY_PATH`/`AUTH_CODE_PEPPER`/`POSTGRES_PASSWORD` are required, port 80 redirects to HTTPS.
- `deploy/deploy.sh` — bare-metal deployment: non-root `pocketctl` systemd units, PostgreSQL SCRAM (`scram-sha-256`) limited to a localhost app rule, TLS-only nginx.
- `docs/operations/tls-rollout.md` — TLS rollout/rollback runbook.

`scripts/deploy.sh` (the legacy cloud-server script) is **retired** and exits with guidance; it ran the relay as root, globally downgraded `pg_hba.conf` auth, and served HTTP only. Do not resurrect it.

## License

[MIT](LICENSE)

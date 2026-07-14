# pocketctl

**Your AI coding agents, in your pocket.**

Monitor and manage Claude Code, Codex, and OpenCode sessions from your phone or browser.

Official website: [pocketctl.me](https://www.pocketctl.me) · Web dashboard: [pocketctl.me/app](https://www.pocketctl.me/app)

## Features

- 🤖 **Multi-agent** — Claude Code, Codex, and OpenCode, behind one unified "zero-config discovery + live sync + cross-device continue" model. Run an agent in your terminal; the daemon discovers it and syncs it to your client where you can keep chatting. (OpenCode is a client/server agent — the daemon hosts a shared `opencode serve` and drives it over its HTTP API. To add a new agent, register a `Provider` — see [docs/adding-an-agent.md](docs/adding-an-agent.md).)
- 🖥️ **Real-time Monitoring** — Watch your AI coding sessions live from anywhere
- 🧩 **Reliable OpenCode output** — Text and reasoning Parts reconcile to exact final snapshots; retries, compaction, and assistant errors appear consistently in Web and iOS. Reasoning is collapsed by default. Terminal-side OpenCode permission prompts still remain in the terminal.
- 📱 **iOS App** — Download the iOS app from the official website. In Settings, select **Test Environment** and enter your self-hosted Relay address to connect it.
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
- **Relay** — WebSocket server that bridges mobile/web clients with daemons
- **Web** — Vue 3 SPA dashboard for browser-based monitoring, served at `/app`
- **iOS App** — Download it from the official website; use Settings → Test Environment to connect a self-hosted Relay.

The public service is available at [pocketctl.me](https://www.pocketctl.me). The browser client is served from
[`/app`](https://www.pocketctl.me/app); the root URL contains product information and client entry points.

## Quick Start

### Install

```bash
# Install the latest version (production)
curl -fsSL https://raw.githubusercontent.com/pocketctl/pocketctl/master/scripts/install-daemon.sh | bash -s -- --prod

# Or install for local development
curl -fsSL https://raw.githubusercontent.com/pocketctl/pocketctl/master/scripts/install-daemon.sh | bash
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
| `pocketctl uninstall [--yes] [--keep-binary]` | Remove daemon, config, and data directories |
| `pocketctl version` | Print version |

## Environment Variables

| Variable | Description |
|----------|-------------|
| `POCKETCTL_RELAY_URL` | Relay WebSocket URL (e.g. `wss://your-domain.com/ws`) |
| `POCKETCTL_TOKEN` | JWT token for authentication |
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

## License

[MIT](LICENSE)

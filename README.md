# pocketctl

**Your AI coding agents, in your pocket.**

Monitor and manage Claude Code, Codex, and OpenCode sessions from your phone or browser.

## Features

- 🖥️ **Real-time Monitoring** — Watch your AI coding sessions live from anywhere
- 📱 **Mobile Control** — Send messages, create sessions, and manage agents from your phone
- 🔔 **Push Notifications** — Get alerted when your agent needs attention
- 🔄 **Self-updating** — One command to update to the latest version
- 🌐 **Web Dashboard** — Full-featured web UI with dark/light theme, daemon & session management
- 🔐 **Secure** — JWT authentication with phone SMS + email verification code
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
- **Relay** — WebSocket server that bridges mobile clients with daemons
- **Web** — Web dashboard for browser-based monitoring

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
pocketctl login --prod
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
| `pocketctl login [--prod]` | Login via phone (SMS) or email (verification code) |
| `pocketctl daemon start [--prod]` | Start the daemon |
| `pocketctl daemon stop` | Stop the running daemon |
| `pocketctl daemon status` | Show daemon status and active sessions |
| `pocketctl daemon logs` | View daemon logs |
| `pocketctl daemon doctor` | Diagnose connection issues |
| `pocketctl daemon update` | Update to the latest version |
| `pocketctl version` | Print version |

## Environment Variables

| Variable | Description |
|----------|-------------|
| `POCKETCTL_RELAY_URL` | Relay WebSocket URL (e.g. `wss://your-domain.com/ws`) |
| `POCKETCTL_TOKEN` | JWT token for authentication |
| `SES_FROM_EMAIL` | Sender email address for verification emails |
| `SES_REGION` | Tencent Cloud SES region (default: `ap-hongkong`) |
| `DEV_SMS_PHONE` | Dev mode test phone number |
| `DEV_SMS_CODE` | Dev mode test verification code |

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
│   ├── api/                       # HTTP API client (auth, SMS)
│   ├── config/                    # Config management (~/.pocketctl/auth.json)
│   ├── daemon/                    # PID file, daemon state management
│   ├── discovery/                 # Agent CLI auto-discovery
│   ├── notify/                    # Terminal notifications
│   ├── protocol/                  # WebSocket message type definitions
│   ├── session/                   # Session lifecycle management
│   ├── update/                    # Self-update (version check, download, verify)
│   ├── watcher/                   # Session file monitoring (fsnotify)
│   └── ws/                        # WebSocket client with auto-reconnect
├── relay/
│   └── src/
│       ├── server.ts              # Fastify HTTP + WebSocket server
│       ├── router.ts              # WebSocket message routing
│       ├── auth.ts                # JWT sign/verify
│       ├── db.ts                  # PostgreSQL queries
│       ├── push.ts                # Push notification service
│       ├── title.ts               # LLM title generation
│       └── config/
│           ├── sms.ts             # Tencent Cloud SMS client
│           ├── email.ts           # Tencent Cloud SES email client
│           └── verification.ts    # Shared verification code store
├── web/                           # Vue 3 web dashboard (dark/light theme)
│   └── src/
│       ├── views/                 # DashboardView, SessionDetail, SettingsView, LoginView
│       ├── composables/           # useAuth, useWebSocket, useCountdown, useRelativeTime
│       ├── components/            # SubAgentCard, NewSessionDialog, etc.
│       └── assets/               # web-shared.css (design system), logo SVGs
├── scripts/
│   ├── install-daemon.sh          # One-line installer
│   └── sync-github.sh             # Sync to GitHub
├── go.mod
└── go.sum
```

## Tech Stack

| Component | Technology |
|-----------|------------|
| Daemon | Go 1.25, gorilla/websocket, fsnotify |
| Relay | TypeScript, Fastify v5, @fastify/websocket, PostgreSQL |
| Web UI | Vue 3, Vue Router 4, Vite 6, TypeScript |

## License

[MIT](LICENSE)

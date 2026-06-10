# pocketctl

**Your AI coding agents, in your pocket.**

Monitor and manage Claude Code, Codex, and OpenCode sessions from your phone or browser.

## Features

- 🖥️ **Real-time Monitoring** — Watch your AI coding sessions live from anywhere
- 📱 **Mobile Control** — Send messages, create sessions, and manage agents from your phone
- 🔔 **Push Notifications** — Get alerted when your agent needs attention
- 🔄 **Self-updating** — One command to update to the latest version
- 🔐 **Secure** — JWT authentication with phone number verification
- ⚡ **Lightweight** — Single binary, zero dependencies, runs on macOS and Linux

## Architecture

```
┌─────────────┐     WebSocket      ┌─────────────┐     WebSocket      ┌─────────────┐
│   iOS App   │◄──────────────────►│    Relay     │◄──────────────────►│   Daemon    │
│  (Mobile)   │                    │   (Server)   │                    │  (Desktop)  │
└─────────────┘                    └─────────────┘                    └─────────────┘
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
| `pocketctl login [--prod]` | Login via phone number (SMS verification) |
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
│   └── src/                       # Fastify + WebSocket relay server
├── web/                           # Vue 3 web dashboard
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

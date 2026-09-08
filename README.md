# PocketCtl

[English](README.md) | [简体中文](README.zh-CN.md)

**Keep your AI coding agents within reach.**

PocketCtl is a cross-device control plane for Claude Code, Codex, OpenCode, and
ZCode. Follow work from a browser or iPhone, respond when an agent needs you,
and continue supported sessions without moving the repository or agent process
off your development machine.

[Website](https://www.pocketctl.me) · [Web app](https://www.pocketctl.me/app) · [iOS app](https://apps.apple.com/cn/app/pocketctl/id6778710005) · [Releases](https://github.com/pocketctl/pocketctl/releases)

## Why PocketCtl

- **Stay in the loop from anywhere** — stream session output, status, tool calls,
  edited files, plans, and sub-agent activity in real time.
- **Act when the runtime supports it** — send follow-up messages, answer
  questions, handle approvals, steer work, or interrupt a turn from Web or iOS.
- **Keep the native terminal experience** — managed Codex and OpenCode sessions
  continue to use their official TUI while sharing one runtime with PocketCtl.
- **Recover context after a disconnect** — the Relay persists normalized events
  for replay, and the daemon reconciles supported managed sessions after restart.
- **Focus attention** — the optional Attention Inbox groups pending questions,
  approvals, high-risk actions, and recovery signals with their session context.
- **Grow governed project knowledge** — the optional Memory workbench turns
  repository sources into a review-gated wiki and a dependency code graph with
  impact analysis, and keeps skill documents under explicit governance.

## Agent support

Control is deliberately capability-based. A discovered session is not
automatically advertised as remotely controllable.

| Agent | Observe | Remote interaction | Integration model |
|---|---|---|---|
| **Claude Code** | Live history and output | Independently started terminal sessions can continue through an idle/exited `--resume` handoff. PocketCtl-created PTYs support Web/iOS approvals; the native terminal remains authoritative for independently started sessions. | Automatic discovery; no shared runtime claim. See [Claude cross-device control](docs/claude-cross-device-control.md). |
| **Codex CLI 0.144.1+** | Threads, turns, items, plans, and interactions | Managed sessions support shared input, steer/interrupt, approvals, questions, and standard MCP elicitation. | Optional launcher connects the official TUI and daemon to one app-server. See [Codex managed terminal control](docs/codex-managed-terminal.md). |
| **Codex Desktop** | Incremental rollout history, status, model, token usage, tools, plans, and file changes | Read-only: no remote input, approval, interrupt, kill, resume, or session creation. | Automatically discovered observer; displayed separately from Codex CLI as `codex-desktop`. |
| **OpenCode 1.17.11+** | Sessions, content, status, commands, and interactions | Managed sessions support shared input, permissions, and questions. Existing independent processes stay read-only until safely resumed through the launcher. | Optional launcher connects the official TUI and daemon to one shared server. See [OpenCode managed terminal control](docs/opencode-managed-terminal.md). |
| **ZCode** | Incremental history sync from the local SQLite store | Read-only: no remote input, approval, resume, or control. | Explicit opt-in observer. |

PocketCtl is extensible through agent providers. See [Adding an agent](docs/adding-an-agent.md)
for the public adapter contract.

## How it works

```text
┌────────────────────┐       HTTPS / WSS       ┌────────────────────┐
│ Web app / iOS app  │ ◄─────────────────────► │       Relay        │
└────────────────────┘                         │ auth + event replay│
                                               └─────────┬──────────┘
                                                         │ WSS
                                               ┌─────────▼──────────┐
                                               │ PocketCtl daemon   │
                                               │ development host   │
                                               └─────────┬──────────┘
                                                         │ local runtime
                                               ┌─────────▼──────────┐
                                               │ Coding agent CLIs  │
                                               └────────────────────┘
```

- The **daemon** runs beside your repositories, discovers agent sessions, and
  translates each runtime's real capabilities into a common protocol.
- The **Relay** authenticates devices, routes commands, and persists session
  events for history and reconnects.
- The **Web and iOS clients** present the same sessions and only enable actions
  that the daemon has explicitly confirmed as supported.

## Quick start

The fastest path uses the hosted Relay at `pocketctl.me`.

### 1. Install the daemon

The installer supports macOS and Linux on x86-64 and ARM64. It downloads the
published binary and verifies it against the GitHub release SHA-256 sidecar.

```bash
curl -fsSL https://www.pocketctl.me/install.sh | bash
```

### 2. Sign in and start

```bash
pocketctl login --prod
pocketctl daemon start --prod
pocketctl daemon status
```

On a headless machine, use email verification instead of the browser device flow:

```bash
pocketctl login --prod --email
```

### 3. Open a client

Use the [Web app](https://www.pocketctl.me/app) or install PocketCtl from the
[App Store](https://apps.apple.com/cn/app/pocketctl/id6778710005). The daemon
automatically discovers compatible CLIs available on its `PATH`.

## Enable shared terminal control

Managed launchers are opt-in and reversible. They do not install, replace, or
upgrade the underlying agent CLI.

### Codex

```bash
pocketctl agent codex enable
pocketctl agent codex status
codex
```

Use `codex --native ...` for a one-off bypass, or
`pocketctl agent codex disable` to remove the PocketCtl launcher.

### OpenCode

```bash
pocketctl agent opencode enable
pocketctl agent opencode status
opencode
```

Use `opencode --native ...` for a one-off bypass, or
`pocketctl agent opencode disable` to remove the PocketCtl launcher.

## Essential commands

| Command | Purpose |
|---|---|
| `pocketctl login [--prod] [--email]` | Authenticate through browser device flow or email verification. |
| `pocketctl daemon start [--prod]` | Start the daemon and discover local agents. |
| `pocketctl daemon status` | Show daemon, Relay, and discovered-agent status. |
| `pocketctl daemon doctor` | Diagnose configuration and connection problems. |
| `pocketctl daemon logs` | Locate or follow daemon logs. |
| `pocketctl daemon update [--version TAG]` | Download and verify a published update. |
| `pocketctl agent <agent> status` | Inspect launcher, capability, and runtime state. |
| `pocketctl agent zcode sync enable` | Enable read-only ZCode history sync; restart the daemon to apply it. |
| `pocketctl uninstall [--yes] [--keep-binary]` | Remove the daemon and local PocketCtl data. |

Run `pocketctl help` or the relevant subcommand with `--help` for all options.

## Security and data boundary

PocketCtl keeps repositories and agent processes on the development host, but
that does **not** mean session content stays local.

- Production transport uses HTTPS/WSS.
- Session and tool content is **not end-to-end encrypted**. The configured Relay
  can read and persist normalized content required for routing, replay,
  notifications, and account features.
- If `DEEPSEEK_API_KEY` is configured on the Relay, the text needed to generate a
  session title may be sent to DeepSeek. Without the key, title generation is
  skipped.
- Managed Codex/OpenCode endpoints and local runtime credentials remain on the
  development host; clients communicate through the authenticated Relay.

Review the current [Privacy Policy](https://www.pocketctl.me/privacy.html) before
using the hosted service or connecting sensitive repositories.

## Self-hosting

The supported production entry points are hardened deployments:

- [`docker-compose.prod.yml`](docker-compose.prod.yml) for Compose-based hosting.
- `deploy/deploy.sh` for a bare-metal systemd, PostgreSQL, and Nginx deployment.

Both paths require explicit TLS, authentication secrets, and separate PostgreSQL
administrator/application credentials. The production Compose topology exposes
only Nginx publicly; Relay and PostgreSQL stay on the internal network.

`scripts/deploy.sh` is a retired legacy path and intentionally exits with
migration guidance. Do not use it for a new deployment.

## Build and test

The release toolchain uses Go 1.25 and Node.js 22.

```bash
git clone https://github.com/pocketctl/pocketctl.git
cd pocketctl
make build
make test
```

The public repository contains the Go daemon, TypeScript Relay, Vue Web app,
deployment definitions, and integration documentation. The iOS source is not
part of the public mirror.

## Contributing and repository policy

Issues and pull requests are welcome on [GitHub](https://github.com/pocketctl/pocketctl/issues).
When adding a runtime, preserve the distinction between session discovery,
read-only observation, handoff, and shared control.

The Gitee repository is the canonical source history. GitHub is a filtered
public mirror for review and release artifacts, so commit IDs may differ between
the two repositories.

## License

[MIT](LICENSE)

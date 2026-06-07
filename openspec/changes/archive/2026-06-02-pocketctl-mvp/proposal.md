## Why

Personal developers using coding agents (Claude Code, OpenCode, etc.) are tethered to their desks. There is no way to start a coding session from your phone, watch the agent work in real-time, send follow-up instructions, or approve dangerous operations — the way Codex App does for Codex CLI. Existing tools like multica focus on team-level task dispatch, not interactive session control. pocketctl fills this gap: a mobile-first remote control center for your personal coding agents.

## What Changes

- New Go daemon (`pocketctl`) that runs on each Mac, spawns coding agent CLIs as child processes, parses their structured output (stream-json), and exposes a unified WebSocket API
- New TypeScript relay server that runs on a cloud VPS, routes WebSocket messages between mobile/web clients and daemons, handles authentication, and buffers offline messages
- New Vue 3 web UI for MVP validation — real-time streaming output, multi-turn chat via `--resume`, tool call visibility, and session management
- Unified protocol (NDJSON over WebSocket) shared by all components: daemon, relay, and clients
- Claude Code adapter as the first agent integration, using `--output-format stream-json --verbose` and `--resume` for multi-turn

## Capabilities

### New Capabilities

- `agent-session`: Spawning, managing, and communicating with coding agent CLI processes (start, stop, send messages, resume sessions). Covers the Go daemon's process lifecycle and stream-json parsing.
- `relay-routing`: WebSocket message routing between clients and daemons, including daemon registration, session routing, authentication (JWT), and offline message buffering.
- `stream-protocol`: The unified NDJSON message protocol used across all components — message types, event schemas, and wire format.
- `web-ui`: Vue 3 single-page application for real-time agent interaction — session list, streaming output, message input, tool call display.
- `claude-adapter`: Claude Code specific adapter — stream-json output parsing, `--resume` multi-turn, `--allowedTools` permission strategy.

### Modified Capabilities

_(none — this is a greenfield project)_

## Impact

- **New repository**: `pocketctl` monorepo with Go daemon, TypeScript relay, and Vue web UI
- **Infrastructure**: Deploy relay server on existing Tencent Cloud VPS (already running PostgreSQL)
- **Dependencies**: Go 1.22+, Node.js 20+, PostgreSQL 15+ (existing), Vue 3, Fastify, ws, gorilla/websocket
- **No breaking changes**: Greenfield project, no existing users or APIs

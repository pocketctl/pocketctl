## 1. Project Scaffolding

- [x] 1.1 Create monorepo structure: `cmd/pocketctl/`, `internal/adapter/`, `internal/session/`, `internal/ws/`, `relay/`, `web/`, `shared/`
- [x] 1.2 Initialize Go module (`go mod init github.com/pocketctl/pocketctl`) with dependencies: gorilla/websocket, google/uuid
- [x] 1.3 Initialize relay package (`relay/`) with `package.json`, Fastify, ws, pg dependencies
- [x] 1.4 Initialize Vue 3 web UI (`web/`) with Vite scaffold
- [x] 1.5 Define shared protocol types in Go (`internal/protocol/types.go`) — all message structs matching stream-protocol spec

## 2. Claude Adapter

- [x] 2.1 Implement `ClaudeAdapter.ParseStreamLine(line string) (Event, error)` — parse NDJSON line and extract type/subtype/content
- [x] 2.2 Implement text output mapping: `assistant.content[type=text]` → `agent_text` event
- [x] 2.3 Implement tool call mapping: `assistant.content[type=tool_use]` → `tool_call` event, `user.content[type=tool_result]` → `tool_result` event
- [x] 2.4 Implement result mapping: `type=result` → `session_status` with completed/error state, cost, turns
- [x] 2.5 Implement init event handling: extract `session_id` from `system.subtype=init`
- [x] 2.6 Write unit tests for all adapter parsing with real stream-json fixture data

## 3. Agent Session Manager

- [x] 3.1 Implement `SessionManager.CreateSession(agent, cwd, prompt)` — spawn `claude -p "prompt" --output-format stream-json --verbose` with configurable `--allowedTools` and `--permission-mode`
- [x] 3.2 Implement `SessionManager.SendMessage(sessionID, content)` — spawn `claude -p "content" --resume sessionID --output-format stream-json --verbose`
- [x] 3.3 Implement `SessionManager.KillSession(sessionID)` — SIGTERM then SIGKILL after 5s timeout
- [x] 3.4 Implement concurrent session tracking: map of sessionID → ProcessState, each in its own goroutine
- [x] 3.5 Wire adapter to session: read stdout line-by-line, parse via adapter, emit events to output channel
- [x] 3.6 Implement agent discovery: scan PATH for `claude`, `opencode` binaries on startup

## 4. Daemon WebSocket Connection

- [x] 4.1 Implement WebSocket client that connects to relay URL with API key in query param
- [x] 4.2 Implement `register` message on connect: send daemon_id, hostname, available agents
- [x] 4.3 Implement message routing: receive command from relay → dispatch to SessionManager → forward events back to relay
- [x] 4.4 Implement ping/pong keepalive (every 15s)
- [x] 4.5 Implement reconnection with exponential backoff (1s → 30s cap) on disconnect
- [x] 4.6 Wire everything: SessionManager output channel → WebSocket send goroutine

## 5. Daemon CLI Interface

- [x] 5.1 Implement `pocketctl daemon start --relay <url> --api-key <key>` — start daemon in foreground or background
- [x] 5.2 Implement `pocketctl daemon stop` — send signal to running daemon process (via PID file)
- [x] 5.3 Implement `pocketctl daemon status` — show relay connection, active sessions, available agents
- [x] 5.4 Implement `pocketctl daemon logs` — tail the daemon log file
- [x] 5.5 Implement `pocketctl version` — print version from build-time ldflags

## 6. Relay Server

- [x] 6.1 Set up Fastify server with WebSocket plugin and PostgreSQL connection
- [x] 6.2 Implement `GET /health` endpoint returning `{"status":"ok"}` with DB connectivity check
- [x] 6.3 Implement WebSocket authentication: validate API key from query param, reject with code 4001 on failure
- [x] 6.4 Implement daemon registration handler: store daemon metadata in `daemons` table, track online status
- [x] 6.5 Implement session routing: maintain `session_id → daemon_ws` mapping, forward client messages to correct daemon
- [x] 6.6 Implement client subscription: maintain `client_ws → [session_ids]` mapping, forward daemon events to subscribed clients
- [x] 6.7 Implement event persistence: store all daemon events in `events` table with auto-incrementing sequence number
- [x] 6.8 Implement replay handler: client sends last seen seq, relay replays missed events from DB
- [x] 6.9 Implement daemon offline detection: heartbeat timeout (30s), mark offline in DB, notify clients

## 7. PostgreSQL Schema

- [x] 7.1 Create `daemons` table: id, daemon_id, hostname, agents (jsonb), status, last_heartbeat, created_at
- [x] 7.2 Create `sessions` table: id, session_id, daemon_id, agent_type, cwd, status, created_at, updated_at
- [x] 7.3 Create `events` table: id (serial), session_id, event_type, payload (jsonb), created_at
- [x] 7.4 Create indexes: sessions by daemon_id, events by session_id + id (for replay queries)

## 8. Vue Web UI

- [x] 8.1 Create WebSocket composable (`useWebSocket`) with auto-reconnect, message send/receive, connection state
- [x] 8.2 Create session list page: fetch sessions, display with status badges, auto-update on WebSocket events
- [x] 8.3 Create session detail page: chat-like layout with user messages and agent responses
- [x] 8.4 Implement streaming text rendering: append `agent_text` chunks to message bubble with cursor indicator
- [x] 8.5 Implement tool call cards: collapsible card showing tool name, input params, output
- [x] 8.6 Implement message input: text field + Enter to send `user_message`, show loading state
- [x] 8.7 Implement new session dialog: form with agent type, cwd, initial prompt fields
- [x] 8.8 Implement connection status banner: show "Reconnecting..." when WebSocket drops
- [x] 8.9 Implement session status indicators: running (pulse), completed (check), error (red), killed (gray)

## 9. Integration & Smoke Test

- [x] 9.1 Write end-to-end smoke test: daemon connects to relay → web UI creates session → Claude Code runs → output streams to browser
- [x] 9.2 Test multi-turn: send follow-up message, verify `--resume` works, output continues in same session view
- [x] 9.3 Test concurrent sessions: create two sessions, verify output doesn't interleave
- [x] 9.4 Test reconnection: kill relay, verify daemon reconnects and web UI resumes
- [x] 9.5 Build Go daemon binary and verify `pocketctl daemon start` works on macOS

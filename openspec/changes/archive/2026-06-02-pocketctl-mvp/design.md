## Context

pocketctl is a greenfield project — a mobile-first remote control center for personal coding agents. The MVP consists of three components: a Go daemon running on each Mac, a TypeScript relay server on a cloud VPS, and a Vue 3 web UI for validation.

The user has an existing Tencent Cloud server running Node.js projects and PostgreSQL. The coding agents to control are CLI tools (Claude Code, OpenCode, etc.) that run in terminals. Claude Code has a `--output-format stream-json --verbose` mode that emits NDJSON events, and `--resume` for multi-turn conversations.

## Goals / Non-Goals

**Goals:**
- End-to-end working prototype: type a message in browser → Claude Code runs on Mac → streaming output appears in browser
- Multi-turn conversation via `--resume` (spawn new process per follow-up)
- Multiple concurrent agent sessions on a single Mac
- Structured display of tool calls, text output, and session status
- Daemon auto-reconnects to relay on network disruption
- Single-user MVP (no multi-tenancy yet)

**Non-Goals:**
- Permission/approval flow in MVP (use `--allowedTools` + `--permission-mode acceptEdits`)
- `--remote-control` bidirectional mode (undocumented, deferred to Phase 2)
- iOS/Android native app (Phase 4)
- Multi-tenant SaaS billing
- Agent adapters beyond Claude Code (OpenCode, Codex etc. — Phase 2)
- File diff rendering, syntax highlighting in Web UI

## Decisions

### D1: Go for daemon, TypeScript for relay and web UI

**Choice**: Hybrid stack — Go daemon, TypeScript (Fastify) relay, Vue 3 web UI.

**Why**: The daemon runs as a long-lived background process on macOS, manages child processes, and must be distributable as a single binary (`brew install pocketctl`). Go excels here. The relay is a typical web server (HTTP + WebSocket + PostgreSQL) where TypeScript's ecosystem is richer. Vue 3 for the web UI because the user chose it.

**Alternatives considered**:
- All TypeScript: Faster to start but daemon distribution requires node runtime or pkg bundling (~40MB). Multi-process management is less natural in Node.
- All Go: Relay would lack the web framework ecosystem. Vue UI not possible.

### D2: Dispatch + Resume pattern for MVP multi-turn

**Choice**: Each user message spawns a new `claude -p "message" --resume <session-id>` process. The process runs to completion, emits stream-json events, then exits.

**Why**: This is the simplest working model. Claude Code's `--remote-control` bidirectional mode is undocumented and risky. The dispatch pattern is proven and well-understood from the spike. Session continuity comes from `--resume` which loads conversation history from disk.

**Trade-off**: There's a cold-start per message (~3-5s for session load). Not truly real-time "interrupt the agent mid-thought" — but sufficient for most coding workflows where you send instructions and watch output.

**Alternatives considered**:
- `--remote-control`: True bidirectional, but undocumented. Deferred to Phase 2.
- Keep process alive with stdin pipe: Claude Code's `--input-format stream-json` didn't produce output in spike tests. Too unreliable.

### D3: WebSocket-only communication (no REST polling)

**Choice**: All communication between daemon ↔ relay ↔ client uses WebSocket with NDJSON frames. No REST API for real-time data.

**Why**: Real-time streaming is the core value. REST polling would add latency and complexity. WebSocket gives us push-based streaming naturally.

**Trade-off**: WebSocket reconnection logic needed on all sides. No HTTP caching. But for a control plane (not a content delivery system), this is fine.

### D4: Flat NDJSON protocol over WebSocket

**Choice**: Each WebSocket message is a single NDJSON line with a `type` field. Three message categories: client→daemon commands, daemon→client events, and control messages.

**Why**: Simple to implement in Go, TypeScript, and Vue. No protobuf overhead, no schema compilation step. JSON is natively parsed in all three languages.

### D5: Relay as stateless router with PostgreSQL persistence

**Choice**: The relay doesn't hold session state in memory. It routes messages based on daemon_id and session_id. Message history is persisted to PostgreSQL for offline replay.

**Why**: If the relay restarts, daemons reconnect and clients replay missed messages from DB. No sticky sessions needed. Scales to multiple relay instances later.

### D6: Single-user auth with API key for MVP

**Choice**: Daemon authenticates to relay with a pre-shared API key. Web UI authenticates with the same key (entered on first use). No OAuth, no user accounts.

**Why**: This is a single-user MVP. Adding OAuth/user management is SaaS Phase 3 work. API key is sufficient and trivially implementable.

## Risks / Trade-offs

- **[Resume cold-start latency]** → Each follow-up message spawns a new process (~3-5s). Mitigation: show "connecting..." state in UI. Acceptable for MVP since most coding tasks involve bursts of interaction with pauses.

- **[Stream-json format instability]** → Claude Code's stream-json output is community-documented, not officially stabilized. Format may change between versions. Mitigation: version-pin the adapter, add fallback parsing.

- **[No permission approval flow]** → Using `--allowedTools` + `acceptEdits` means agents auto-approve most operations. Users must trust their agent configuration. Mitigation: document safe `--allowedTools` patterns. Add approval flow in Phase 2.

- **[WebSocket connection stability over mobile networks]** → Mobile networks are flaky. Mitigation: aggressive reconnection with exponential backoff on all components. Message buffering in relay DB for replay on reconnect.

- **[Go learning curve]** → The developer is new to Go. Mitigation: daemon is structurally simple (spawn processes, parse JSON, maintain WebSocket). No complex Go patterns needed for MVP scope.

## Open Questions

- What specific `--allowedTools` whitelist is the right default for the "semi-auto" mode? Needs real-world testing.
- Should the daemon support a local-only mode (direct WebSocket from browser, no relay) for development convenience?
- PostgreSQL schema for message persistence — how much history to keep? Per-session retention policy?

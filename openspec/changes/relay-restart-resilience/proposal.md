## Why

When the relay restarts (deploy, crash, or a transient network blip), two user-visible failures occur today:

1. **Spurious "daemon offline" push.** The relay treats a WebSocket `close` as authoritative proof the daemon is gone, so it immediately marks the daemon offline, fires an APNs push, and broadcasts offline to web — even though the daemon reconnects seconds later. Worse, the relay has **no graceful-shutdown handler**, so whether the false push fires on restart is non-deterministic (SIGTERM may push, SIGKILL won't).
2. **Lost daemon events.** The daemon→relay hop is fire-and-forget. During the disconnect/reconnect window `SendMsg` drops events on a half-open write (`client.go:363`), and the relay's DB event log is the *only* replay source for clients — so any event that never reaches the relay is invisible to every device, forever. There is no daemon-side sequence number and no relay-side dedup, so naive replay would double messages.

Both failures stem from treating a routine relay restart as a catastrophic, lossy event instead of a recoverable handoff.

## What Changes

- **Offline debounce on the relay**: a daemon WS `close` schedules an offline transition after a grace window (default 30s) instead of firing immediately; a re-register for the same daemon within the window cancels it — no push, no flap.
- **Graceful shutdown drain**: the relay installs a SIGTERM/SIGINT handler that sets a `shuttingDown` flag suppressing all `daemonOfflinePush` during shutdown, and (optionally) sends connected daemons a `relay_restarting` hint so they reconnect promptly without alarm.
- **At-least-once daemon→relay event delivery**: every outgoing daemon event carries a monotonic `seq`; the daemon keeps a bounded outbound buffer of *unacked* events, no longer dropping on write failure, and replays unacked events on reconnect.
- **Relay-side idempotency + acks**: the relay dedups events via a uniqueness key (`daemon_id` + `seq`) using `ON CONFLICT DO NOTHING`, and sends a batched `event_ack { up_to_seq }` so the daemon can trim its buffer.
- Buffer overflow is bounded by back-pressure (block the producer; zero loss) with a configurable cap.

## Capabilities

### New Capabilities
- `relay-offline-debounce`: Relay defers and can cancel the daemon-offline transition (push + DB + broadcast) across short disconnects, and suppresses offline notifications during its own graceful shutdown.
- `daemon-event-delivery`: At-least-once delivery of daemon→relay events via per-daemon sequence numbers, an unacked outbound buffer with reconnect replay, and relay-side dedup + acknowledgement.

### Modified Capabilities
<!-- No existing spec's stated requirements change; relay-routing and stream-protocol are touched at the implementation level only. -->

## Impact

- **Relay** (`relay/src/`): `router.ts` (debounce timers in `unregisterDaemon`/`registerDaemon`, dedup + ack in `handleDaemonMessage`), `server.ts` (SIGTERM handler, `shuttingDown` flag), `db.ts` (unique index on events for `(daemon_id, seq)` or event id, `ON CONFLICT DO NOTHING` insert), `push.ts` (guard on shutdown flag).
- **Daemon** (`internal/ws/client.go`): outbound buffer + `seq` stamping, replay on reconnect, `event_ack` handling, `SendMsg` no longer drops; `internal/protocol/types.go` (new `seq` field on `DaemonEvent`, new `event_ack` / optional `relay_restarting` message types).
- **DB schema**: add `daemon_seq` column + partial unique index to `events` (idempotent migration); back-compat for legacy daemons that send no `seq` (treated as always-insert, never deduped).
- **Back-compat**: older daemons (no `seq`) and older relays (no `event_ack`) continue to work — the buffer simply never trims via ack and falls back to best-effort, matching today's behavior.

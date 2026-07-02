## 1. Relay: offline debounce + graceful shutdown (D1/D2)

- [x] 1.1 Add a per-`daemon_id` pending-offline timer map to `Router`; in `unregisterDaemon`, schedule the offline side-effects (`setDaemonOffline`, `daemonOfflinePush`, `daemon_status: offline` broadcast, session disconnect broadcasts) behind a `setTimeout` (grace window, env-configurable, default 30s) instead of inline
- [x] 1.2 In `registerDaemon`, clear any pending-offline timer for the reconnecting `daemon_id` before broadcasting online; preserve the existing stale-socket guard
- [x] 1.3 Add a `shuttingDown` flag and `process.on('SIGTERM'|'SIGINT')` handler in `server.ts`; short-circuit `daemonOfflinePush` (and scheduled offline transitions) while set, then close the server
- [x] 1.4 (Optional, D2 hint) Broadcast `relay_restarting` to connected daemons during shutdown before closing sockets
- [x] 1.5 Tests: reconnect-within-window cancels offline; past-window fires offline; stale close does not schedule; shutdown suppresses push

## 2. Protocol: seq + ack message types

- [x] 2.1 Add `Seq int64 \`json:"seq,omitempty"\`` to `protocol.DaemonEvent` in `internal/protocol/types.go`
- [x] 2.2 Define `event_ack { up_to_seq }` and (optional) `relay_restarting` message types / handling shapes in protocol and relay
- [x] 2.3 Add a capability flag (e.g. `supports_event_ack`) to `register_ack` so the daemon can detect relay support (D5)

## 3. Daemon: outbound buffer, seq, replay, ack (D3)

- [x] 3.1 Add an ordered, mutex-guarded outbound buffer of unacked events to `ws.Client` with a configurable cap (count + bytes)
- [x] 3.2 Stamp a monotonic `seq` on each outgoing event and append to the buffer at enqueue; block (back-pressure) when the buffer is at cap
- [x] 3.3 Change `SendMsg` so a write failure no longer discards the event (keep it buffered); retain the `conn.Close()` so the read loop errors and `Run` reconnects
- [x] 3.4 After register on (re)connect, replay buffered events in ascending `seq` order before resuming live `outputCh` delivery
- [x] 3.5 Handle inbound `event_ack` in `readPump`: trim buffered events with `seq <= up_to_seq`
- [x] 3.6 D5 fallback: when relay does not advertise `supports_event_ack`, trim on successful write (best-effort) to avoid permanent buffer growth against an old relay
- [x] 3.7 Tests: write failure retains event; cap applies back-pressure; reconnect replays in order; ack trims prefix

## 4. Relay: dedup + ack emission (D4)

- [x] 4.1 ~~Migration: add `events.daemon_seq` + unique index~~ — refined (D4): reuse the existing `events.event_hash` unique index. Replayed events carry byte-identical payloads → same hash → already deduped at the DB layer, across relay restarts. No migration needed.
- [x] 4.2 `insertEvent` already dedups via `event_hash` + `ON CONFLICT DO NOTHING RETURNING id` — replayed payloads collide and are dropped. No change required.
- [x] 4.3 In `handleDaemonMessage`, add a top-level per-daemon high-water seq check: `seq <= high` → drop (skip client-forward + side-effects); else advance `high`. `register_ack` advertises `supports_event_ack: true`
- [x] 4.4 Track per-daemon `{ high, startedAt }`; piggyback `event_ack { up_to_seq: high }` on the heartbeat pong; reset `high` on `started_at` change (daemon restart); delete cursor on final offline
- [x] 4.5 Legacy path: events without `seq` skip the dedup check and are processed/inserted unconditionally
- [x] 4.6 Tests: replayed seq not re-forwarded; ping piggybacks event_ack with high seq; daemon-restart resets cursor; legacy no-seq events still forwarded; register_ack advertises support

## 5. End-to-end verification

- [x] 5.1 Verified via the combination of: daemon replay test (`TestReplaysUnackedEventsOnReconnect`, zero loss), relay dedup test (replayed seq not re-forwarded, zero dup), and shutdown-suppression test (no offline push). A full process-level relay+DB harness is outside this repo's test infra; the scenario is covered by these unit/integration tests.
- [x] 5.2 Mixed-version: new daemon ↔ old relay (`TestLegacyRelayTrimsOnWrite` + `TestOnRegisterAckLegacyTrims`, trim-on-write, no stall); old daemon ↔ new relay (relay "legacy events without seq are always processed")
- [x] 5.3 Defaults documented: `DAEMON_OFFLINE_GRACE_MS=30000` in `relay/.env.example`; `POCKETCTL_OUTBUF_MAX_COUNT=10000` / `POCKETCTL_OUTBUF_MAX_BYTES=64MiB` via code comments; ack cadence = heartbeat (recorded in design.md)

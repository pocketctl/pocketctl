## Context

The relay (`relay/src/`, TypeScript/Fastify WS server) is the routing hub between daemons (Go WS client, `internal/ws/client.go`) and clients (web/iOS). The relay's Postgres `events` table is the **single source of truth** for client replay (`getEventsAfter(lastSeq)`); clients can only ever see events that reached the relay and were persisted.

Two restart-time failures exist today:

- **Spurious offline.** `router.unregisterDaemon` runs on WS `close` and immediately does `setDaemonOffline` + `daemonOfflinePush` (APNs) + `daemon_status: offline` broadcast. `server.ts` has **no** SIGTERM/SIGINT handler, so on a deploy the offline push fires non-deterministically depending on signal/timing.
- **Event loss.** The daemon→relay hop is fire-and-forget. `client.go SendMsg` drops on write failure (logs + `conn.Close()`), and during `backoffSleep` nobody drains `outputCh` (cap 256) — producers block at the cap (safe-but-stalled), while events already pulled by the select loop and failed mid-write are gone. There is no daemon `seq` and no relay dedup, so a naive replay would double messages.

Constraints: must stay backward compatible across mixed daemon/relay versions during rollout (a daemon and the relay are deployed independently). Personal-scale workloads (typically 1 daemon per free user); memory and DB volume are modest.

## Goals / Non-Goals

**Goals:**
- A relay restart or short network blip never produces a false "daemon offline" push.
- No daemon→relay event is silently lost across a disconnect/reconnect; clients see each event exactly once.
- Backward compatible: old daemon ↔ new relay and new daemon ↔ old relay both degrade to today's best-effort behavior.

**Non-Goals:**
- Durable on-disk daemon event journal surviving a daemon *process* crash (in-memory buffer only; a daemon crash is out of scope — the relay's existing reconcile-on-register handles lifecycle recovery).
- Reworking client↔relay replay (already seq-based and adequate).
- Exactly-once at the producer; we target at-least-once + relay dedup, which is exactly-once as observed by clients.

## Decisions

### D1: Offline debounce via a per-daemon timer (grace window), default 30s

On WS `close`, `unregisterDaemon` schedules the offline side-effects behind a `setTimeout` keyed by `daemon_id` instead of running them inline. `registerDaemon` clears any pending timer for that `daemon_id`. The existing stale-socket guard (`daemon.ws !== closedWs`) is preserved so a late close from a superseded socket never schedules anything.

- **Why 30s:** comfortably exceeds the daemon's worst-case reconnect (backoff capped at 30s, but a healthy daemon reconnects in 1–4s) plus a relay cold start, while keeping a genuine offline notification timely.
- **Alternative considered:** heartbeat-expiry sweep (mark offline when `last_heartbeat` ages out). Rejected as the primary mechanism — it adds a polling loop and latency, though it remains a useful backstop the DB already supports.

Note the debounce timer is per-process: on a relay *restart* the timer dies with the old process, which is fine because D2 suppresses the push on that path and the new process never observed a disconnect.

### D2: Graceful-shutdown suppression flag (+ optional restart hint)

`server.ts` installs `process.on('SIGTERM'|'SIGINT')` setting `shuttingDown = true`; `unregisterDaemon`/`daemonOfflinePush` short-circuit when set. Optionally, before closing sockets, broadcast `relay_restarting` so daemons reconnect promptly and log the disconnect as expected rather than an error.

- **Why both D1 and D2:** D2 covers planned restarts (the deterministic fix); D1 covers unplanned blips and the case where the relay stays up but a single daemon's socket flaps. On SIGKILL neither old-process path runs, and the new process simply sees a fresh register — no false push either way.

### D3: Daemon outbound buffer with seq, replay-on-reconnect, no drop

Add `Seq int64` to `protocol.DaemonEvent` (`json:"seq,omitempty"`). In `client.go`, introduce an ordered outbound buffer (slice/ring under a mutex) of unacked events:

- The select loop stamps `seq` (monotonic counter) and appends to the buffer before/along with the write.
- `SendMsg` write failure no longer discards — the event stays buffered; `conn.Close()` still fires so `readPump` errors out and `Run` reconnects.
- After register on (re)connect, drain the buffer in `seq` order first, then resume live `outputCh` delivery.
- Cap the buffer (config, e.g. 10k events / 64MB). At cap, **block** the enqueue (back-pressure) — matches today's 256-channel blocking semantics, guarantees zero loss. The 256 `outputCh` stays as the producer handoff; the new buffer is the durability layer.

- **Why seq + buffer over re-tailing JSONL offsets:** the JSONL tailer (`watcher/tailer.go`) is a durable on-disk log for content events, and offset-rewind could recover them — but lifecycle events (`session_created`, `session_status`) are not in JSONL, and *any* replay still needs relay dedup. A single in-memory buffer covers all event types uniformly with less moving machinery. Offset-gating remains a future option if memory bounds bite on very long outages.

### D4: Relay dedup via existing event_hash + in-memory high-water seq + ack

**Refined during implementation.** The original plan added a `daemon_seq` column with a `UNIQUE(daemon_id, seq)` index. Implementation found the events table already has an `event_hash` unique index (`md5(session:type:payload)`) used by `insertEvent` with `ON CONFLICT DO NOTHING`. Because the daemon replays *byte-identical* payloads (it re-sends the stored marshaled bytes, including the `seq` field), a replayed event yields the same hash and is already deduped at the DB layer — across relay restarts too. So no new column/index is needed for storage dedup.

Two layers, both reused/lightweight:
- **DB row dedup (durable):** existing `event_hash` unique index. Survives relay restarts; guarantees no duplicate rows.
- **Forward dedup (in-memory):** a per-daemon `{ high, startedAt }` cursor. Events arrive strictly contiguously per daemon (WS frames are atomic; the daemon writes in seq order and a failed write closes the conn before later seqs are written), so any `seq <= high` is a replayed duplicate → skip re-forwarding to clients and side-effects. `startedAt` (from the register message) detects a daemon *process* restart (seq resets to 0) and resets `high`, preventing stale-cursor suppression of fresh events.

`event_ack { up_to_seq: high }` is piggybacked on the heartbeat pong (every ~10s), bounding the daemon's unacked buffer to roughly one ping interval of events.

- **Why high-water (not contiguous-gap tracking):** contiguity is guaranteed by the transport, so a single integer suffices — no gap set needed.
- **Why reuse event_hash:** zero migration, and it already gives durable cross-restart dedup that a fresh in-memory map cannot.

### D5: Backward compatibility

- Events without `seq` (legacy daemon): relay inserts unconditionally (no dedup), as today — `daemon_seq` NULL, never matched by the partial index.
- `event_ack` from a new relay to an old daemon: unknown message type, ignored — buffer simply never trims via ack (bounded by cap; best-effort, = today).
- New daemon against old relay: never receives `event_ack`, buffer trims only... it wouldn't trim, so it would fill to cap and block. Mitigation: also trim on the assumption that a successful write is delivered when no ack support is detected — i.e. if no `event_ack` is seen within a grace period after connect, fall back to trim-on-successful-write (best-effort, matches old behavior). Capability negotiation via a flag in `register_ack` makes this explicit.

## Risks / Trade-offs

- **[Genuine offline delayed up to the grace window]** → 30s is acceptable for a "host went offline" push and avoids notification spam on flaky links; tunable via env.
- **[Buffer back-pressure stalls a session during a long relay outage]** → Bounded and intentional (zero loss over fluidity). Cap is configurable; a future drop-oldest-with-gap-marker policy can be added if any user prefers fluidity.
- **[Unbounded memory if cap mis-set]** → Hard cap in bytes and count; log a warning approaching cap.
- **[New daemon ↔ old relay buffer never acked]** → D5 capability negotiation / trim-on-write fallback prevents permanent stall.
- **[Dedup index migration on a large events table]** → Add column NULLable + `CREATE INDEX CONCURRENTLY`; no rewrite, no long lock.
- **[Contiguous-seq tracking adds per-daemon state on the relay]** → Small in-memory cursor keyed by daemon_id, cleared on final unregister; bounded by daemon count.

## Migration Plan

1. Ship relay first: SIGTERM handler + offline debounce (D1/D2) — independently valuable, no protocol change.
2. Add `events.daemon_seq` column + `CREATE INDEX CONCURRENTLY` partial unique index; relay `insertEvent` ON CONFLICT path (no-op for legacy NULL seq).
3. Ship relay `event_ack` emission + dedup, gated behind capability flag in `register_ack`.
4. Ship daemon seq + outbound buffer + replay + ack handling.
5. Rollback: each step is backward compatible; reverting the daemon or relay independently degrades to today's best-effort delivery.

## Open Questions

Resolved during implementation:

- **Grace window / buffer caps** — settled on 30s offline grace (`DAEMON_OFFLINE_GRACE_MS`, in `relay/.env.example`), and daemon buffer caps of 10k events / 64 MiB (`POCKETCTL_OUTBUF_MAX_COUNT` / `POCKETCTL_OUTBUF_MAX_BYTES`, documented via code comments in `internal/ws/client.go`).
- **Ack cadence** — piggybacked on the heartbeat pong (~10s), no dedicated interval.
- **`relay_restarting` hint** — included (daemon logs it as expected; relay broadcasts on graceful shutdown).
- **Storage dedup** — reused the existing `event_hash` index instead of a new `daemon_seq` column (see D4).

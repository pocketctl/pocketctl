## ADDED Requirements

### Requirement: Per-daemon event sequence numbers

Every event the daemon sends to the relay SHALL carry a monotonically increasing `seq` that is unique per daemon connection lifetime. The `seq` SHALL be assigned at enqueue time and never reused or reordered.

#### Scenario: Sequence increases per event

- **WHEN** the daemon emits a series of events to the relay
- **THEN** each event carries a `seq` strictly greater than the previous event's `seq`

#### Scenario: Legacy daemon without seq

- **WHEN** an older daemon connects and sends events without a `seq` field
- **THEN** the relay accepts and processes those events as before (no dedup applied)

### Requirement: Bounded unacked outbound buffer

The daemon SHALL retain every sent-but-unacknowledged event in a bounded outbound buffer. `SendMsg` SHALL NOT discard an event on write failure; the event SHALL remain in the buffer for replay. When the buffer reaches its configured cap, the daemon SHALL apply back-pressure to producers (block) rather than drop events.

#### Scenario: Write failure retains the event

- **WHEN** a write to the relay fails on a half-open socket
- **THEN** the event remains in the outbound buffer and is not lost

#### Scenario: Buffer cap applies back-pressure

- **WHEN** the relay is unreachable and the outbound buffer reaches its configured cap
- **THEN** event producers block until capacity is available, and no event is dropped

### Requirement: Replay of unacked events on reconnect

After a successful (re)connection and register, the daemon SHALL replay all events still in its outbound buffer, in ascending `seq` order, before resuming live event delivery.

#### Scenario: Events produced during an outage are delivered after reconnect

- **WHEN** the relay is down while the daemon produces events, and the daemon later reconnects
- **THEN** the daemon replays the buffered events in order and the relay receives them

#### Scenario: Replay precedes new events

- **WHEN** the daemon reconnects with buffered unacked events and also has new events to send
- **THEN** the buffered events are sent first, in `seq` order, before any newly produced events

### Requirement: Relay-side dedup and acknowledgement

The relay SHALL persist daemon events idempotently, deduplicating by (`daemon_id`, `seq`) so that a replayed event is never stored or forwarded twice. The relay SHALL periodically send the daemon an `event_ack { up_to_seq }` acknowledging the highest contiguous `seq` it has durably persisted. On receiving `event_ack`, the daemon SHALL trim acknowledged events from its outbound buffer.

#### Scenario: Replayed event is not duplicated

- **WHEN** the relay receives an event with a (`daemon_id`, `seq`) it has already persisted
- **THEN** the relay does not insert a duplicate row and does not re-forward it to clients

#### Scenario: Ack trims the buffer

- **WHEN** the daemon receives `event_ack { up_to_seq: N }`
- **THEN** the daemon removes all buffered events with `seq <= N`

#### Scenario: No client-visible duplicates after reconnect

- **WHEN** a daemon reconnects and replays events that partially reached the relay before the disconnect
- **THEN** subscribed clients see each event exactly once

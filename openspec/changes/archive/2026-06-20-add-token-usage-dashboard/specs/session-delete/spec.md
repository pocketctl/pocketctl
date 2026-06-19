## MODIFIED Requirements

### Requirement: Relay deletes session data and creates tombstone
Relay SHALL compensate the session's token usage into `token_daily_stats` before deleting session data, so that deleting a session never reduces historical consumption totals. In a single database transaction: aggregate the session's per-day/per-model token usage from its `agent_text` events into `token_daily_stats` (`INSERT ... ON CONFLICT (user_id, daemon_id, date, model) DO UPDATE SET ... = ... + EXCLUDED ...`), then delete the session's events, then delete the session row, then insert the tombstone.

#### Scenario: Relay processes session_delete with compensation
- **WHEN** Relay receives `session_delete` message with a valid `session_id`
- **THEN** Relay, in a single transaction, aggregates that session's `agent_text` usage by `(date, model)` into `token_daily_stats` via upsert
- **AND** deletes all events for that session from `events` table
- **AND** deletes the session from `sessions` table
- **AND** inserts the session_id into `deleted_sessions` table
- **AND** sends `session_deleted` response to the originating client

#### Scenario: Deleted session preserves historical totals
- **WHEN** a session that consumed N tokens is deleted
- **THEN** the corresponding `(date, model)` cells in `token_daily_stats` are incremented by that session's per-day/per-model breakdown
- **AND** the user's total / daily / model-distribution consumption shown on the dashboard remains unchanged by the deletion

#### Scenario: Relay rejects delete without session_id
- **WHEN** Relay receives `session_delete` message without `session_id`
- **THEN** Relay sends error response to client

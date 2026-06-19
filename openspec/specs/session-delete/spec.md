## ADDED Requirements

### Requirement: User can delete exited sessions
App SHALL allow users to delete sessions that are in terminal state (exited, completed, error, killed) via swipe-to-delete gesture. Non-terminal sessions (running, busy, idle, waiting_approval) SHALL NOT be deletable.

#### Scenario: Delete an exited session
- **WHEN** user swipes left on an exited session card
- **THEN** a red "删除" button appears on the right side

#### Scenario: Delete button not shown for active sessions
- **WHEN** user swipes left on a running or idle session card
- **THEN** no delete button appears

#### Scenario: Execute delete
- **WHEN** user taps the "删除" button
- **THEN** session is removed from the local list immediately
- **AND** a `session_delete` message is sent to Relay via WebSocket

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

### Requirement: Relay broadcasts deletion to all user clients
Relay SHALL broadcast `session_deleted` event to all WebSocket clients belonging to the same user.

#### Scenario: Multi-device sync
- **WHEN** user deletes a session on device A
- **THEN** all other devices of the same user receive `session_deleted` event
- **AND** those devices remove the session from their local list

### Requirement: Tombstone prevents automatic resurrection
When Relay receives a `session_discovered` event for a session that exists in `deleted_sessions`, it SHALL skip the event and not recreate the session.

#### Scenario: Watcher scan after delete
- **WHEN** a session is deleted and tombstoned
- **AND** Watcher subsequently discovers the same session file
- **AND** Relay receives `session_discovered` for that session_id
- **THEN** Relay checks `deleted_sessions` table
- **AND** Relay skips the event (does not upsert session)

#### Scenario: Tombstone only blocks session_discovered
- **WHEN** a session is deleted and tombstoned
- **AND** Relay receives `session_discovered` for that session_id
- **THEN** Relay checks the tombstone and skips the event
- **AND** all other event types (`session_status`, `agent_text`, `tool_call`, etc.) pass through without tombstone check

### Requirement: Deleted session can be restored via --continue
When a user runs `claude --continue` on a deleted session, the session SHALL reappear in the App.

#### Scenario: Continue a deleted session
- **WHEN** user deletes session A from App
- **AND** user runs `claude --continue` in the same directory
- **AND** Claude CLI updates session A's file (new PID, status changes to idle)
- **AND** Watcher detects the file change and emits "changed" event
- **AND** Daemon sends `session_discovered` to Relay
- **THEN** Relay processes the event (changed events bypass tombstone check)
- **AND** session A reappears in the App's session list with full history

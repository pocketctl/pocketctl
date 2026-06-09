## MODIFIED Requirements

### Requirement: Session routing between client and daemon
The relay SHALL route messages between clients and daemons based on `session_id`. The relay SHALL maintain a mapping of `session_id → daemon_id` to know which daemon handles each session.

The relay SHALL handle a new `generate_title_request` event from daemons. When received, the relay SHALL call the title generation service with the provided user and assistant messages, conditionally update the session title in the database (only if the current title matches the default pattern `Terminal Session-%`), and broadcast the updated title to subscribed clients.

#### Scenario: Client sends message to session
- **WHEN** client sends `user_message` with `session_id: "abc"`
- **THEN** relay looks up which daemon owns session "abc"
- **AND** relay forwards the message to that daemon's WebSocket connection

#### Scenario: Daemon sends event to client
- **WHEN** daemon sends `agent_text` event with `session_id: "abc"`
- **THEN** relay looks up which client(s) are subscribed to session "abc"
- **AND** relay forwards the event to those client WebSocket connections

#### Scenario: Daemon sends generate_title_request
- **WHEN** daemon sends `generate_title_request` with `session_id`, `user_message`, and `assistant_message`
- **THEN** relay calls the title generation service with both messages
- **AND** relay updates the session title in the database only if the current title matches `Terminal Session-%`
- **AND** relay broadcasts `session_title_update` to all subscribed clients

#### Scenario: generate_title_request for session with custom title
- **WHEN** daemon sends `generate_title_request` for a session whose title is already "React暗色模式组件"
- **THEN** relay SHALL skip the title generation and database update
- **AND** no `session_title_update` event is broadcast

### Requirement: Session database schema extensions
The relay SHALL extend the sessions table with `last_activity_at` and `exit_reason` columns. Both columns SHALL be nullable to maintain backward compatibility.

The relay SHALL provide a conditional title update function that only updates the title when the current value matches the default pattern `Terminal Session-%`.

#### Scenario: Database migration on startup
- **WHEN** relay starts and the `last_activity_at` column does not exist in the sessions table
- **THEN** relay executes `ALTER TABLE sessions ADD COLUMN last_activity_at TIMESTAMPTZ`
- **AND** relay executes `ALTER TABLE sessions ADD COLUMN exit_reason VARCHAR(32)`

#### Scenario: Conditional title update — default title exists
- **WHEN** relay updates a session title where the current title is "Terminal Session-1def4567"
- **THEN** the SQL update uses a WHERE clause: `title LIKE 'Terminal Session-%'`
- **AND** the title is updated to the generated value

#### Scenario: Conditional title update — custom title exists
- **WHEN** relay attempts to update a session title where the current title is "React暗色模式组件"
- **THEN** the SQL WHERE clause `title LIKE 'Terminal Session-%'` does not match
- **AND** no update occurs

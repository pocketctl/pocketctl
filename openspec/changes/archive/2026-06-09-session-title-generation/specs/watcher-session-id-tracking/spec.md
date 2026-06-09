## MODIFIED Requirements

### Requirement: Watcher tracks sessions by session ID
Watcher SHALL use session ID as the primary key for tracking known sessions, instead of file path (PID). This ensures that `claude --continue` which creates a new process with the same session ID is recognized as the same session.

When the watcher detects a session with both a user message and an assistant response available in the JSONL, it SHALL emit a `generate_title_request` event containing both messages. The watcher SHALL track a `titleGenerated` flag per session to ensure this event is emitted at most once per session.

#### Scenario: --continue creates new PID file
- **WHEN** session A exists with PID 100 (file `100.json`)
- **AND** user runs `claude --continue` which creates PID 200 (file `200.json`) with the same session ID
- **AND** Watcher detects the new file `200.json`
- **THEN** Watcher recognizes the session ID is already known
- **AND** Watcher updates the tracked filepath and PID
- **AND** Watcher emits "changed" event (not "discovered")
- **AND** no duplicate session is created in the App

#### Scenario: Daemon restart rescans all files
- **WHEN** Daemon restarts and Watcher scans all session files
- **AND** multiple files share the same session ID (old PID file still on disk)
- **THEN** Watcher keeps only the most recent file per session ID
- **AND** only one "discovered" event is emitted per session ID

#### Scenario: First user and assistant messages trigger title generation
- **WHEN** the watcher detects the first user message AND the first assistant response in a session's JSONL
- **AND** the `titleGenerated` flag for this session is false
- **THEN** the watcher emits a `generate_title_request` event with `session_id`, `user_message`, and `assistant_message` fields
- **AND** the watcher sets `titleGenerated` to true for this session

#### Scenario: Title generation not repeated
- **WHEN** the watcher detects additional messages in the JSONL for a session where `titleGenerated` is already true
- **THEN** the watcher does NOT emit another `generate_title_request` event

## ADDED Requirements

### Requirement: Extract assistant message from JSONL
The adapter SHALL provide a function to extract the first assistant (model) response text from a JSONL file. This function SHALL filter out tool call results, system messages, and empty responses, returning only the first substantive text output from the assistant.

#### Scenario: Extract first assistant text response
- **WHEN** the JSONL file contains a sequence of messages including user messages, assistant text, and tool calls
- **THEN** the function returns the first assistant text content, excluding tool_use and tool_result messages

#### Scenario: No assistant response yet
- **WHEN** the JSONL file contains only user messages and no assistant responses
- **THEN** the function returns an empty string

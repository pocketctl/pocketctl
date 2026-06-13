## MODIFIED Requirements

### Requirement: Terminal session discovery emits event only after JSONL confirmed
The daemon SHALL emit `session_discovered` for a terminal session only after the JSONL tailer has successfully started (the JSONL file exists and is readable). If the JSONL file does not exist after 60 seconds of retries, the session SHALL be silently discarded without appearing in the Web client.

#### Scenario: Normal terminal session
- **WHEN** a new Claude Code session is started and its JSONL file is immediately available
- **THEN** the tailer starts successfully
- **AND** `session_discovered` is emitted to the relay

#### Scenario: --continue ghost session
- **WHEN** Claude Code `--continue` creates a session entry with a new sessionId
- **AND** no JSONL file exists for this sessionId
- **AND** the tailer retries for 60 seconds without finding the JSONL
- **THEN** the session SHALL be silently discarded
- **AND** no `session_discovered` event is emitted

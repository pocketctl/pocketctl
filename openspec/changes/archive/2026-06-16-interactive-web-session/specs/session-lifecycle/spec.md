## ADDED Requirements

### Requirement: Daemon session persistent interactive lifecycle
The daemon (web-created) session SHALL follow a persistent lifecycle with the PTY claude process alive across messages: `idle ↔ running`, replacing the prior one-shot `running → completed` model where each message spawned a fresh `claude -p` process. The `completed` state SHALL be reached only on explicit session end, not after each message.

#### Scenario: Daemon session multi-message lifecycle
- **WHEN** a daemon session receives a first message and then follow-ups
- **THEN** state transitions follow: `idle` → `running` (processing) → `idle` (awaiting) → `running` → `idle`
- **AND** each transition emits a `session_status` event
- **AND** the PTY claude process is NOT respawned between messages

#### Scenario: Daemon session reaches completed only on explicit end
- **WHEN** the user explicitly ends the session (or the PTY process exits)
- **THEN** the session transitions to `completed` or `exited`
- **AND** no further messages are accepted without a resume

#### Scenario: Terminal session lifecycle unchanged
- **WHEN** a terminal session (user's interactive claude discovered via watcher) is active
- **THEN** its lifecycle (running → idle → exited) is unchanged by this change
- **AND** the existing `--resume` handoff for terminal sessions continues to work

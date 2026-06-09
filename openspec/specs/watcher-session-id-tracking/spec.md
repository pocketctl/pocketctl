## ADDED Requirements

### Requirement: Watcher tracks sessions by session ID
Watcher SHALL use session ID as the primary key for tracking known sessions, instead of file path (PID). This ensures that `claude --continue` which creates a new process with the same session ID is recognized as the same session.

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

### Requirement: Watcher maintains filepath-to-sessionId index
Watcher SHALL maintain a `fileToSession` map that maps file paths to session IDs, enabling correct cleanup when a file is removed.

#### Scenario: Old PID file removed after --continue
- **WHEN** session A has files `100.json` and `200.json` (both same session ID)
- **AND** old process exits and `100.json` is removed
- **AND** Watcher detects the file removal
- **THEN** Watcher looks up session ID via `fileToSession["100.json"]`
- **AND** Watcher checks if other files still track this session ID
- **AND** since `200.json` still exists, Watcher does NOT emit "removed" event

#### Scenario: Last file for session removed
- **WHEN** session A has only one file `200.json`
- **AND** the file is removed
- **AND** Watcher detects the removal
- **THEN** Watcher emits "removed" event for session A
- **AND** Watcher cleans up both `knownSessions` and `fileToSession` entries

### Requirement: Watcher emits correct event types
Watcher SHALL emit "discovered" for genuinely new sessions and "changed" for sessions that are already known but have updated file content.

#### Scenario: New session file appears
- **WHEN** a new session file appears with a session ID not in `knownSessions`
- **THEN** Watcher emits "discovered" event

#### Scenario: Known session file updated
- **WHEN** a session file is modified (write event)
- **AND** the session ID is already in `knownSessions`
- **THEN** Watcher emits "changed" event with updated session info

#### Scenario: New file with known session ID
- **WHEN** a new file appears with a session ID that already exists in `knownSessions`
- **THEN** Watcher updates the filepath and PID in `knownSessions`
- **AND** Watcher emits "changed" event (not "discovered")

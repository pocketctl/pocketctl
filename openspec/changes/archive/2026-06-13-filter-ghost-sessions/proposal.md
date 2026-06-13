## Why

Claude Code's `--continue` temporarily creates new session IDs in `~/.claude/sessions/` that point back to the original session's JSONL file. The daemon's watcher discovers these transient sessions and reports them to the relay, creating "ghost sessions" in the Web client — empty session cards with no JSONL content and no actual conversation data.

## What Changes

- **Daemon**: Skip `session_discovered` for terminal sessions when no JSONL file exists (the session is a --continue ghost)
- The daemon's JSONL tailer retry logic already handles the case where the JSONL doesn't exist yet (up to 60s). If after retries the file still doesn't exist, the session was a ghost and should not be reported.

## Capabilities

### Modified Capabilities

- `session-lifecycle`: Terminal session discovery now requires an existing JSONL file or successful tailer startup before emitting `session_discovered` to the relay

## Impact

- **Daemon (`cmd/pocketctl/main.go`)**: `handleWatcherEvents` — defer `session_discovered` event emission until tailer successfully starts (already partially implemented with retry logic)
- **Session manager (`internal/session/manager.go`)**: `RegisterTerminalSession` — emit event only after tailer confirms JSONL exists

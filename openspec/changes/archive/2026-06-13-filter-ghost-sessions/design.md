## Context

Claude Code `--continue` creates a new PID file in `~/.claude/sessions/` with a new `sessionId`, but the conversation JSONL remains at the original session's path. The daemon discovers the new session ID and reports it, but the tailer fails to start (no JSONL). After 60s of retries, the tailer gives up, but the empty session is already visible in the Web client.

## Decision

**Defer `session_discovered` until tailer confirms JSONL exists.**

Current flow:
```
watcher → discovered → RegisterTerminalSession → emit session_discovered
                                                  → start tailer (may fail)
```

New flow:
```
watcher → discovered → RegisterTerminalSession → start tailer (with retry)
                    ↙                            ↓ success
              (no emit yet)               emit session_discovered
```

Only one change needed: move the `sm.outputCh <- protocol.DaemonEvent{Type: "session_discovered", ...}` from `RegisterTerminalSession` into the tailer goroutine, after `NewJSONLTailerFromStart` succeeds.

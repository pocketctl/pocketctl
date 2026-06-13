## 1. Defer session_discovered until tailer confirms JSONL

- [x] 1.1 Move `session_discovered` event emission from `RegisterTerminalSession` into the tailer goroutine after successful `NewJSONLTailerFromStart`
- [x] 1.2 Remove the immediate `session_discovered` emit in `session/manager.go` `RegisterTerminalSession`
- [x] 1.3 Emit `session_discovered` only after tailer is confirmed started (JSONL exists and is readable)
- [x] 1.4 Build Go daemon, restart local daemon, verify ghost sessions no longer appear
- [x] 1.5 Verify normal terminal sessions still appear correctly (new Claude sessions with actual JSONL files)

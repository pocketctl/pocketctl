# Claude Code cross-device control

Pocketctl integrates Claude Code through two intentionally different modes.

## Capability matrix

| Claude mode | Content sync | Continue from Web/iOS | Remote approval | Shared runtime |
|---|---|---|---|---|
| independently started terminal | JSONL history + live tail | idle/exited `--resume` handoff | no; Claude native terminal prompt | no |
| Pocketctl-created daemon PTY | JSONL/PTY projection | yes | yes, Web/iOS | daemon-owned PTY only |
| managed experimental | not enabled | not enabled | not enabled | no-go on Claude Code 2.1.198 |

Terminal handoff is not simultaneous control. While an independently started
Claude process is running or waiting on its native approval prompt, remote text
input remains read-only. Once it is idle or has exited, Pocketctl can start a
one-shot `claude --resume` turn and continue the same conversation.

## Approval behavior

Pocketctl-created Claude sessions install a PreToolUse Hook that connects to the
daemon's private approval socket. Pending requests are keyed by request ID:

- multiple requests can coexist;
- replay and Relay reconnect upsert the same card;
- the first Web/iOS response wins;
- a later response converges as `resolved_elsewhere`;
- timeout, Hook disconnect, session drain, daemon shutdown, and daemon restart
  close the card with a reason.

The daemon keeps a private `0600` crash journal containing only session ID,
request ID, and creation time. It never stores tool input, cwd, prompt, or the
answer. After a crash, the old Hook connection cannot be recovered, so the new
daemon emits `daemon_restarted` closure events instead of making stale cards
actionable again.

Independently started terminal Claude sessions keep Claude's native terminal
approval prompt. Pocketctl does not suppress local approval merely to simulate
terminal co-approval.

## JSONL V2

The optional Claude JSONL V2 tailer adds deterministic event IDs and
loss-aware reading:

- IDs remain stable across daemon restart;
- repeated identical text at different record offsets remains distinct;
- a partial final record is not committed until its newline arrives;
- truncate and replace are detected;
- an oversized or malformed record does not block later valid records.

Rollout flags:

```text
POCKETCTL_CLAUDE_APPROVAL_V2=1
POCKETCTL_CLAUDE_JSONL_V2=1
```

Both flags affect Claude only. Codex continues using its app-server interaction
authority, and OpenCode continues using its serve/HTTP/SSE interaction
authority.

## Managed runtime status

Claude Code 2.1.198 advertises `--remote-control`, stream-json input/output, and
resume. It does not expose a documented machine-readable local contract for:

- terminal and daemon attaching to one authority;
- independent event subscription;
- send/steer/interrupt on the same live turn;
- pending approval enumeration;
- first-writer-wins resolved notification;
- daemon restart reattachment.

Pocketctl therefore does not enable `POCKETCTL_CLAUDE_MANAGED` or advertise
`shared_runtime`/`terminal_coapproval`. See
`docs/superpowers/specs/claude-managed-runtime-feasibility.md`.

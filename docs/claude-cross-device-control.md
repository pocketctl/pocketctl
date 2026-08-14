# Claude Code cross-device control

Pocketctl integrates Claude Code through two intentionally different modes.

## Capability matrix

| Claude mode | Content sync | Continue from Web/iOS | Remote approval | Shared runtime |
|---|---|---|---|---|
| independently started terminal | JSONL history + live tail | idle/exited `--resume` handoff | **yes (Channel relay)**; Claude native terminal prompt stays authoritative | no |
| Pocketctl-created daemon PTY | JSONL/PTY projection | yes | yes, Web/iOS (in-process Hook broker) | daemon-owned PTY only |
| managed experimental | not enabled | not enabled | not enabled | no-go on Claude Code 2.1.198 |

Terminal handoff is not simultaneous control. While an independently started
Claude process is running or waiting on its native approval prompt, remote text
input remains read-only. Once it is idle or has exited, Pocketctl can start a
one-shot `claude --resume` turn and continue the same conversation.

## Claude Channel permission relay (terminal sessions)

Independently started terminal Claude sessions can opt into the Pocketctl
Channel permission relay via `pocketctl agent claude-code enable`. The shim
installs under `~/.pocketctl/bin/claude` and injects the Pocketctl-owned
MCP config plus `--dangerously-load-development-channels=server:pocketctl`
for supported interactive launches. The native Claude terminal approval
prompt stays authoritative; the Channel only relays Web/iOS cards.

> **Channel availability (verified 2026-08-11 on Claude Code 2.1.227):**
> Channels require `channelsEnabled: true` in **Managed settings**
> (Team/Enterprise admin). The `--dangerously-load-development-channels`
> flag is silently ignored in 2.1.227 for individual users. The Pocketctl
> shim, IPC, registry, and approval-routing layers are complete and
> tested; the Channel relay path activates automatically once Managed
> settings enable Channels. See
> [docs/test-reports/claude-channel-approval-2026-08-11.md](test-reports/claude-channel-approval-2026-08-11.md)
> for the full E2E acceptance report.

- requires Claude Code **>= 2.1.211** (protocol floor is 2.1.81 but the
  production bar fixes relay approval preview spoofing risks);
- requires `channelsEnabled: true` in Managed settings (Claude Code 2.1.227+);
- gated by the `POCKETCTL_CLAUDE_CHANNEL_APPROVAL=1` rollout flag;
- 200ms bootstrap budget; falls back to native Claude on any daemon / probe
  / version failure;
- `--native`, help/version/print/bare/safe-mode/dangerously-skip-permissions
  /`--permission-mode bypassPermissions` and the auth/mcp/plugin/doctor/
  update/agents subcommands always run native (probe count = 0);
- remote verdicts are at-most-once; the daemon never replays a verdict
  after disconnect, daemon restart, or session end;
- Web/iOS show a neutral "submitted to Claude; result unconfirmed" state
  that never claims allow/deny; the copy always notes the terminal remains
  available.

The daemon does NOT modify `~/.claude/settings.json` during its lifecycle.
Legacy Pocketctl Hook entries are cleaned up once during an explicit
`agent claude-code enable`; user and third-party hooks are preserved.

## Approval behavior (daemon-owned PTY)

Pocketctl-created daemon Claude sessions install a project-scoped
PreToolUse Hook that connects to the daemon's private approval socket.
Pending requests are keyed by request ID:

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

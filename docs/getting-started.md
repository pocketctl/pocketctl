# Agent setup and commands

[Back to README](../README.md)

## Enable shared terminal control

Daemon startup can automatically enable eligible Codex/OpenCode launchers;
use `--no-agent-auto-enable` to skip this. Launchers are reversible and do not
install, replace, or upgrade the underlying agent CLI.

### Codex

```bash
pocketctl agent codex enable
pocketctl agent codex status
codex
```

Use `codex --native ...` for a one-off bypass, or
`pocketctl agent codex disable` to remove the PocketCtl launcher.

**Multiple Codex accounts on one machine.** Isolated Codex homes
(`~/.codex-a`, `~/.codex-proxy`, …) can all be watched at once — pass extra
homes with repeatable `--codex-home <dir>` flags or the
`POCKETCTL_CODEX_HOMES` environment variable, then pick the account when
starting a session from Web or iOS.

### OpenCode

```bash
pocketctl agent opencode enable
pocketctl agent opencode status
opencode
```

Use `opencode --native ...` for a one-off bypass, or
`pocketctl agent opencode disable` to remove the PocketCtl launcher.

### DeepSeek Harness (preview)

Start the native Host, then attach PocketCtl using its printed launch URL:

```bash
dsh web --no-open
# In another terminal, paste the actual URL printed above:
pocketctl agent dsh enable --url 'http://127.0.0.1:PORT/?token=TOKEN'
pocketctl agent dsh status
```

Open that launch URL for local interaction. The daemon discovers sessions under
its `--allowed-cwd-root` directories; select the same session in PocketCtl Web
for remote interaction. Both clients share one Host and session ID. Keep the
Host running; `pocketctl agent dsh disable` detaches PocketCtl without stopping
DSH. After restarting the Host, enable again with its new launch URL.

The bootstrap credential stays in `~/.pocketctl/dsh.json` with mode `0600` and is
not sent to Relay. Only loopback Host URLs are accepted. This integration targets
DSH's existing Host; it does not start a separate ACP runtime. Electron Desktop
0.2.0-rc.2 has also passed local-daemon/Docker-Relay acceptance for shared input,
questions, approvals, cancellation, and bidirectional model/effort/permission
selection. Web (including mobile layout) and iOS expose the native settings.
Model and effort changes affect subsequent requests and also save the Host's
default model. Full-access/custom permission presets require the daemon-local
`--allow-dangerous-remote-permissions` opt-in. Desktop currently requires an explicit
local bridge plugin to export its Host launch URL; automatic Desktop attachment
is not implemented. Remote worktree/fork creation and attachment uploads are
not covered.

## Managed session control and full-access permissions

Remote session control and agent execution permissions are separate settings.
Sending messages, answering approvals, and interrupting tasks do not require bypassing
approvals. Full access or approval bypass requires both a daemon-local opt-in and
the corresponding permission selection for the session.

### Confirm that PocketCtl manages the session

Enable the integration on the development host as the user running the daemon,
and keep the daemon online and connected to Relay:

- **Codex CLI**: run `pocketctl agent codex enable` as shown above. Open a new login
  shell if PATH has not taken effect, then use `codex` or `codex resume <thread-id>`
  to create or resume a session. The official TUI and Web/iOS share input,
  approvals, questions, and interrupts. Already running native processes are not
  automatically converted to managed sessions.
- **Claude Code**: select Claude Code in **New session** on Web/iOS to create a
  PocketCtl-owned PTY. Channel integration for an independent terminal provides
  approval relay only; resume handoff is available once the session is idle or exited.
- **Codex Desktop**: sessions are currently read-only observers. Enabling high
  permissions does not make them remotely controllable.

See [Codex shared control](codex-managed-terminal.md) and
[Claude Code cross-device control](claude-cross-device-control.md) for capabilities
and limitations.

### Allow full access or approval bypass

For a directly started daemon, add the local opt-in:

```bash
pocketctl daemon start --allow-dangerous-remote-permissions
```

For a system-supervised daemon, persist the flag in the service startup arguments:

```bash
pocketctl daemon service install --allow-dangerous-remote-permissions
```

These are minimal examples. Preserve existing `--prod` / `--relay`,
`--allowed-cwd-root`, `--codex-home`, and other settings. If a daemon is already
running, wait for active tasks to finish, run `pocketctl daemon stop`, then apply
the new configuration using the same direct-start or service-managed approach.

Next, select the permissions when creating a **new session** on Web/iOS:

| Agent | Permission selection |
|---|---|
| Codex CLI | Full access: `danger-full-access`; select `never` if no approvals are wanted. |
| Claude Code | Bypass permissions: `bypassPermissions`. |

The flag is off by default. It allows clients to request high permissions; it does
not select them automatically or modify existing sessions. It also does not expand
the remote working-directory scope authorized by `--allowed-cwd-root`.
High-permission modes can bypass normal approval or sandbox restrictions; use them
only for hosts and tasks you trust.

### Verify the configuration

```bash
pocketctl daemon status
pocketctl agent codex status
pocketctl daemon diagnose <session-id>
```

For Claude Code, use `pocketctl agent claude-code status` instead. `agent status`
checks the integration, while `daemon diagnose` checks whether the actual session
is controlled. Neither confirms full-access permissions for the session.
The daemon startup output `dangerous remote permissions=true` confirms the local
opt-in; also check the permissions selected when creating the session.
Run `pocketctl help` for other options.

## Essential commands

| Command | Purpose |
|---|---|
| `pocketctl login [--prod] [--email]` | Authenticate through browser device flow or email verification. |
| `pocketctl daemon start [--prod]` | Start the daemon and discover local agents. |
| `pocketctl daemon status [--no-update-check]` | Show status; in an interactive terminal, offer updates newer than the running daemon. |
| `pocketctl daemon doctor` | Diagnose configuration and connection problems. |
| `pocketctl daemon diagnose <session-id>` | Check whether one session is proxied and print a reason and recovery advice. |
| `pocketctl daemon logs` | Locate or follow daemon logs. |
| `pocketctl daemon update [--version TAG]` | Download and verify a published update. |
| `pocketctl agent <agent> status` | Inspect launcher, capability, and runtime state. |
| `pocketctl agent zcode sync enable` | Enable read-only ZCode history sync; restart the daemon to apply it. |
| `pocketctl uninstall [--yes] [--keep-binary]` | Remove the daemon and local PocketCtl data. |

Run `pocketctl help` or the relevant subcommand with `--help` for all options.

`daemon status` prints status first. Update checks time out after two seconds;
failed checks, equal/older versions, and noninteractive calls never prompt.
Press Enter to keep the current version, or answer `y` to update and refresh status.
For a root-owned system binary, `daemon update` requests sudo authorization before
downloading. Only the verified installation runs as root; daemon restart retains
the invoking user's identity. Automatic elevation requires a root-controlled
executable and parent directories. Cancellation leaves the binary and daemon
unchanged. `--no-restart` installs without restarting the daemon.

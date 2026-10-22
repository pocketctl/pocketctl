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

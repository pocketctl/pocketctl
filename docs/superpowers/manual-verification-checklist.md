# Windows Manual Verification Checklist

> For when a real Windows machine (or VM) is available. Validates the full daemon lifecycle
> including PR4 Windows-specific implementations (Mutex, named pipes, control channel, ConPTY).
>
> Prerequisites: Go 1.25+ installed, PowerShell 7+ (pwsh), Git.

---

## 1. Build

```powershell
git clone <repo-url> pocketctl
cd pocketctl
go build -o pocketctl.exe ./cmd/pocketctl
```

**Expected:** `pocketctl.exe` produced, exit code 0. No cross-compilation flags needed on native Windows.

---

## 2. Daemon Start (Foreground)

```powershell
# Use a fake relay so the WS connection fails fast but daemon stays alive
.\pocketctl.exe daemon start --foreground --relay ws://127.0.0.1:1/fake --token test-token
```

**Expected:**
- Process starts without crash.
- Stdout shows startup log (log level, PID, relay URL).
- WS connection failure is logged as a warning/error but daemon does **not** exit
  (non-fatal in foreground mode; the daemon waits on context cancel).
- Process remains running (check with `Get-Process pocketctl`).

**If daemon exits immediately:** check `--foreground` flag is reaching the daemon;
relay connection may be fatal in some code paths -- this is a bug to capture.

---

## 3. Single-Instance Lock (Mutex)

Open a **second** PowerShell window while the first daemon is running:

```powershell
.\pocketctl.exe daemon start --foreground --relay ws://127.0.0.1:1/fake --token test-token
```

**Expected:**
- Second process exits with non-zero code.
- Stderr prints a message like "another pocketctl daemon is already running"
  (`daemon.lock_held` i18n key).
- The `Global\pocketctl-daemon` named mutex prevented the second instance.

**Verify mutex exists:**
```powershell
# While daemon is running, check the mutex handle
handle64.exe -p <PID> | Select-String "pocketctl-daemon"
# Or use Process Explorer: Find > Handle or DLL > "pocketctl-daemon"
```

---

## 4. Terminal Session Discovery (Watcher)

1. Start Claude Code in a terminal:
   ```powershell
   claude
   ```
2. The daemon's session watcher scans `~\.claude\sessions\*.json`.

**Expected:**
- Daemon log shows `session discovered` with the Claude session's PID and session ID.
- If `--debug` is used, watcher events appear in console output.

**Verify session file:**
```powershell
Get-ChildItem "$env:USERPROFILE\.claude\sessions\*.json" | Sort-Object LastWriteTime -Descending | Select -First 1
```

---

## 5. Approval Flow (Claude Hook -> Named Pipe)

The daemon hosts an approval broker on `\\.\pipe\pocketctl-approval`.
Claude Code's PreToolUse hook calls `pocketctl __hook`, which connects to this pipe.

### 5a. Verify Hook Installation

```powershell
Get-Content "$env:USERPROFILE\.claude\settings.json" | ConvertFrom-Json | Select -ExpandProperty hooks
```

**Expected:** A `PreToolUse` hook entry pointing to `pocketctl __hook`.

### 5b. Verify Named Pipe Exists

While daemon is running:

```powershell
[System.IO.Directory]::GetFiles("\\.\pipe\") | Where-Object { $_ -match "pocketctl" }
```

**Expected:** `\\.\pipe\pocketctl-approval` appears in the list.

### 5c. Trigger Approval Request

In a Claude Code session, perform an action that requires tool approval
(e.g., `Bash` with a shell command). The hook should fire:

1. Claude Code sends `PreToolUse` event to `pocketctl __hook`.
2. `pocketctl __hook` reads stdin, connects to `\\.\pipe\pocketctl-approval`,
   sends a JSON request with `session_id`, `tool`, `input`.
3. The broker blocks waiting for a client decision (web UI, iOS, or local terminal prompt).
4. Decision flows back through the pipe as `{"allow": true/false, "reason": "..."}`.

**Expected:**
- Daemon log shows incoming hook request.
- Claude Code receives allow/deny response within the timeout (10 min).
- If no client is connected to approve, the request times out and is auto-denied.

---

## 6. Daemon Stop via Control Channel

From another terminal (while daemon is running):

```powershell
.\pocketctl.exe daemon stop
```

**What happens internally:**
1. CLI reads PID from `~\.pocketctl\daemon.pid`.
2. Connects to `\\.\pipe\pocketctl-control-<PID>`.
3. Sends `"stop\n"` over the pipe.
4. Daemon receives the command, calls `onStop()` which cancels the context.
5. All goroutines (watchers, WS client, approval server) shut down gracefully.
6. Daemon process exits.

**Expected:**
- `daemon stop` prints confirmation message and exits 0.
- The daemon process exits within ~5 seconds (graceful shutdown).
- `Get-Process pocketctl` shows no remaining process.

**If daemon does not stop:**
- Check if `\\.\pipe\pocketctl-control-<PID>` exists while daemon is running.
- Check daemon log for control channel startup message.
- Possible bug: control channel not starting, or named pipe path mismatch.

---

## 7. Cleanup

```powershell
# Verify no leftover processes
Get-Process pocketctl -ErrorAction SilentlyContinue

# Verify no leftover pipes (daemon should clean up on exit)
[System.IO.Directory]::GetFiles("\\.\pipe\") | Where-Object { $_ -match "pocketctl" }

# Check PID file is removed
Test-Path "$env:USERPROFILE\.pocketctl\daemon.pid"
```

**Expected:** No pocketctl process, no named pipes, PID file gone.

---

## Summary of Windows-Specific Mechanisms

| Mechanism | Implementation | Named Pipe / Object |
|---|---|---|
| Single-instance lock | `Global\pocketctl-daemon` named mutex | Kernel object, auto-released on process exit |
| Control channel | `\\.\pipe\pocketctl-control-{pid}` | `go-winio.ListenPipe`, receives `"stop\n"` |
| Approval broker | `\\.\pipe\pocketctl-approval` | `go-winio.ListenPipe`, JSON request/response |
| Daemonize | `CREATE_NO_WINDOW \| DETACHED_PROCESS` | No ConPTY; silent background process |
| Session watcher | `~\.claude\sessions\*.json` | Filesystem polling via fsnotify |

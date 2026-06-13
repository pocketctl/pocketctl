## ADDED Requirements

### Requirement: Web force-kick daemon from settings
The Web settings host management page SHALL allow users to forcibly disconnect a remote daemon, requiring email re-verification.

#### Scenario: Force-kick button visible for online daemon
- **WHEN** user views the host management tab in settings
- **AND** at least one daemon is online
- **THEN** each online daemon row displays a "强制下线" (Force Disconnect) button

#### Scenario: Force-kick triggers email verification dialog
- **WHEN** user clicks "强制下线" on a daemon
- **THEN** a confirmation dialog appears with:
  - A warning about disrupting running sessions
  - An email verification code input field
  - Instruction text: "验证码已发送至 m***@example.com"
- **AND** the system calls `POST /api/auth/email/send` to send a verification code to the user's email

#### Scenario: Force-kick requires correct verification code
- **WHEN** user enters the correct email verification code and clicks "确认强制下线"
- **THEN** the system calls `POST /api/auth/email/verify` to verify the code
- **AND** on success, calls `POST /api/auth/revoke` with the daemon's active token
- **AND** the daemon receives a `kicked` WebSocket message
- **AND** the daemon list updates to show the daemon as offline

#### Scenario: Force-kick with incorrect verification code
- **WHEN** user enters an incorrect or expired verification code
- **THEN** the dialog shows an error message: "验证码无效或已过期"
- **AND** the daemon remains online

#### Scenario: Force-kick rate limited
- **WHEN** user has performed 3 force-kick operations in the last hour
- **THEN** the "强制下线" button is disabled
- **AND** a tooltip shows: "操作过于频繁，请 1 小时后再试"

#### Scenario: Force-kick button hidden for offline daemon
- **WHEN** a daemon is offline
- **THEN** the "强制下线" button is not displayed for that daemon

### Requirement: Daemon handles kicked message gracefully
The Go daemon SHALL handle the `kicked` WebSocket message by performing a graceful shutdown.

#### Scenario: Daemon receives kicked message with grace period
- **WHEN** daemon receives a WebSocket message `{ "type": "kicked", "reason": "force_kick", "message": "...", "grace_period_seconds": 0 }`
- **THEN** daemon logs the kick reason
- **AND** daemon sends final status updates for all active sessions
- **AND** daemon closes the WebSocket connection
- **AND** daemon exits with code 0

#### Scenario: Daemon receives takeover notification with grace period
- **WHEN** daemon receives a WebSocket message `{ "type": "kicked", "reason": "new_login", "message": "...", "grace_period_seconds": 300, "new_hostname": "host-B" }`
- **AND** `grace_period_seconds` is greater than 0
- **THEN** daemon logs the takeover notification
- **AND** daemon sets a timer for the grace period
- **AND** daemon continues normal operation during the grace period
- **AND** after the grace period, daemon performs graceful shutdown

### Requirement: CLI takeover notification on login
The pocketctl CLI SHALL notify the user when their new login will displace an existing daemon.

#### Scenario: CLI detects existing online daemon
- **WHEN** user runs `pocketctl login` (device flow or email)
- **AND** the Relay detects an existing online daemon for the same user with a different `machine_id`
- **THEN** the CLI flow pauses and displays:
  - "⚠️ 检测到已在线设备: <hostname> (上线于 <time>)"
  - "请选择:"
  - "[1] 我知道了，先去旧机器停止 (推荐)"
  - "[2] 我无法操作旧机器，申请强制切换"
  - "[3] 取消"

#### Scenario: User selects self-service option
- **WHEN** user selects option [1]
- **THEN** CLI displays: "旧设备将收到切换通知。5 分钟后旧连接将自动断开。你可以现在去旧机器上保存工作。"
- **AND** CLI continues with login after the grace period

#### Scenario: User selects force-kick option
- **WHEN** user selects option [2]
- **THEN** CLI displays: "请打开 Web 客户端完成强制切换: http://<relay-host>/app/settings"
- **AND** CLI provides a link to the settings page
- **AND** CLI waits for the old daemon to be kicked before continuing

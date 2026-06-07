## MODIFIED Requirements

### Requirement: Session list view
The web UI SHALL display a list of all agent sessions with their status, agent type, last activity time, and exit reason (when applicable). The status SHALL be displayed using distinct visual indicators for each of the 8 session states. The web UI SHALL sort sessions by `last_activity_at` descending.

#### Scenario: Active sessions displayed
- **WHEN** user opens the web UI
- **THEN** the session list shows all sessions with status indicator, agent type, cwd, exit reason (if any), and relative time of last activity
- **AND** sessions are sorted by most recent activity first

#### Scenario: Session list updates in real-time
- **WHEN** a new session is created on the daemon
- **THEN** the session list updates automatically without page refresh

#### Scenario: Session status color coding
- **WHEN** session list is displayed
- **THEN** each session shows a status indicator with the following color scheme:
  - Running: green (#22C55E) with pulse animation
  - Idle: yellow (#EAB308)
  - Waiting Approval: orange (#F97316)
  - Exited: gray (#6B7280)
  - Completed: gray (#9CA3AF) with checkmark icon
  - Disconnected: blue (#3B82F6) with dashed border
  - Error: red (#EF4444)
  - Killed: red (#DC2626) with X icon

#### Scenario: Exited session shows exit reason
- **WHEN** a session has status `exited`
- **THEN** the session list item displays the exit reason as a subtitle (e.g., "正常退出", "用户中断")
- **AND** exit reason is displayed in the user's locale

### Requirement: Session detail view with streaming output
The web UI SHALL display a chat-like interface for each session showing real-time streaming output from the agent. Messages SHALL appear as they are received over WebSocket. The detail view SHALL display an exit banner when the session is in `exited` state and a disconnected banner when the session's daemon is offline.

#### Scenario: Streaming text appears incrementally
- **WHEN** agent sends `agent_text` events with `streaming: true`
- **THEN** the UI appends text to the current message bubble in real-time
- **AND** shows a typing/cursor indicator while streaming

#### Scenario: Tool calls displayed distinctly
- **WHEN** agent sends `tool_call` event for `Read` or `Bash`
- **THEN** UI renders a collapsible card showing tool name, input parameters, and output
- **AND** tool cards are visually distinct from text messages

#### Scenario: Exited session shows exit banner
- **WHEN** session status changes to `exited`
- **THEN** UI displays a banner at the top of the detail view with: "Session 已退出" + exit reason + relative time
- **AND** UI shows a "Resume Session" button in the banner (if daemon is online)

#### Scenario: Disconnected session shows disconnected banner
- **WHEN** session's daemon goes offline
- **THEN** UI displays a warning banner: "Daemon 离线 — 等待恢复" with last online time
- **AND** message input is disabled
- **AND** existing conversation remains visible in read-only mode

### Requirement: WebSocket reconnection
The web UI SHALL automatically reconnect to the relay when the WebSocket connection drops. The UI SHALL show a connection status indicator (connected/disconnected). The UI SHALL track daemon online status per-daemon and compute effective session status.

#### Scenario: Connection lost
- **WHEN** WebSocket connection drops
- **THEN** UI shows a "Reconnecting..." banner
- **AND** existing session output remains visible (read-only)
- **AND** UI automatically reconnects and resumes streaming when connection is restored

#### Scenario: Daemon goes offline
- **WHEN** web client receives `daemon_status` event with `status: "offline"`
- **THEN** UI marks the daemon as offline locally
- **AND** all sessions belonging to that daemon display as `disconnected`
- **AND** message input is disabled for those sessions

#### Scenario: Daemon comes back online
- **WHEN** web client receives `daemon_status` event with `status: "online"`
- **THEN** UI clears the offline status for that daemon
- **AND** sessions revert to their real status from the last known state
- **AND** message input is re-enabled for non-terminal sessions

## ADDED Requirements

### Requirement: Daemon online status banner
The web UI SHALL display a persistent banner at the top of the page when any daemon goes offline. The banner SHALL show the daemon hostname, offline duration, and a brief explanation.

#### Scenario: Daemon offline banner displayed
- **WHEN** a daemon goes offline
- **THEN** a warning banner appears at the top of the web UI
- **AND** banner shows: "⚠️ Daemon "macbook-pro" 离线" with the relative time since last heartbeat
- **AND** banner does not block interaction with other daemons' sessions

#### Scenario: Multiple daemons offline
- **WHEN** two daemons are offline simultaneously
- **THEN** banner shows aggregate message: "⚠️ 2 Daemons 离线" with expandable details

#### Scenario: Daemon reconnects
- **WHEN** an offline daemon reconnects
- **THEN** its offline banner is removed (or count decremented)
- **AND** its sessions automatically refresh with current status

### Requirement: Resume session from web
The web UI SHALL provide a "Resume Session" button for sessions in `exited` state when their daemon is online. Clicking the button SHALL send a `user_message` to resume the session via `claude --resume`.

#### Scenario: Resume button visible on exited session
- **WHEN** user views a session detail page and session status is `exited` AND daemon is online
- **THEN** a "Resume Session" button is displayed in the exit banner
- **AND** clicking the button opens the message input with a prompt to type a message

#### Scenario: Resume sends user_message
- **WHEN** user types a message in an exited session and submits
- **THEN** UI sends `user_message` over WebSocket
- **AND** session status transitions from `exited` to `running`
- **AND** exit banner is replaced with normal streaming UI

#### Scenario: Resume not available when daemon offline
- **WHEN** session status is `exited` AND daemon is offline
- **THEN** "Resume Session" button is hidden or disabled
- **AND** tooltip shows "需要 Daemon 在线才能恢复"

#### Scenario: Resume fails with error
- **WHEN** user attempts to resume and daemon returns an error (e.g., session data expired)
- **THEN** UI shows error message: "Session 历史已过期，无法恢复"
- **AND** session status remains `exited`

### Requirement: Session archive and read-only indicator
The web UI SHALL display a visual indicator for sessions in terminal states (`exited`, `completed`, `error`, `killed`) to distinguish between "resumable" and "read-only history".

#### Scenario: Exited session shows resumable badge
- **WHEN** session status is `exited` AND daemon is online
- **THEN** session shows a "可恢复" badge with a blue accent
- **AND** message input is available for resume

#### Scenario: Completed session shows read-only badge
- **WHEN** session status is `completed`
- **THEN** session shows a "只读" badge with a gray accent
- **AND** message input is hidden or replaced with "Session 已结束" text

#### Scenario: Error session shows error badge with details
- **WHEN** session status is `error`
- **THEN** session shows an "异常退出" badge with a red accent
- **AND** error message is displayed in the detail view

### Requirement: Session lifecycle timeline
The web UI SHALL display a mini timeline in the session detail view showing the key lifecycle events of the session.

#### Scenario: Timeline displays lifecycle events
- **WHEN** user views a session detail page
- **THEN** a timeline is displayed at the bottom of the page showing: Created → Running → Idle → Exited/Completed
- **AND** each milestone shows a timestamp
- **AND** the current state is highlighted

#### Scenario: Timeline updates in real-time
- **WHEN** session status changes
- **THEN** timeline adds a new milestone for the state change
- **AND** timeline animates the transition

### Requirement: Relative time display
The web UI SHALL display `last_activity_at` as a relative time string in the session list and detail views.

#### Scenario: Recent activity
- **WHEN** session's `last_activity_at` is less than 1 minute ago
- **THEN** display "刚刚"

#### Scenario: Minutes ago
- **WHEN** session's `last_activity_at` is between 1 and 59 minutes ago
- **THEN** display "X分钟前"

#### Scenario: Hours ago
- **WHEN** session's `last_activity_at` is between 1 and 23 hours ago
- **THEN** display "X小时前"

#### Scenario: Days ago
- **WHEN** session's `last_activity_at` is more than 24 hours ago
- **THEN** display the date in "MM-DD HH:mm" format

### Requirement: Browser notifications for session state changes
The web UI SHALL send browser notifications when a session transitions to a terminal state (`exited`, `error`, `killed`) and the user is not currently viewing that session.

#### Scenario: Notification permission request
- **WHEN** user first visits the web UI
- **THEN** UI requests browser notification permission with a clear explanation: "允许通知以在 Session 结束时收到提醒"

#### Scenario: Session exited notification
- **WHEN** a session transitions to `exited` state AND user is not on that session's detail page
- **THEN** browser notification is sent: "Session "xxx" 已退出"
- **AND** clicking the notification navigates to the session detail page

#### Scenario: User is viewing the session
- **WHEN** a session transitions to `exited` state AND user is currently on that session's detail page
- **THEN** no browser notification is sent (in-page banner is sufficient)

#### Scenario: Notifications disabled
- **WHEN** user has denied notification permission
- **THEN** no notification permission prompt is shown again
- **AND** state changes are only visible in the UI

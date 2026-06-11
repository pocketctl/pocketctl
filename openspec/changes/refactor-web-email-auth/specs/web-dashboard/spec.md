## ADDED Requirements

### Requirement: Dashboard layout with sidebar navigation
The Web dashboard page SHALL use a sidebar layout matching the design draft at `ui-design/pocketctl-design-system/web/dashboard.html`, with the sidebar width at 260px on desktop, collapsing to 72px on tablet, and hiding on mobile.

#### Scenario: Desktop sidebar
- **WHEN** viewport width is >= 1024px
- **THEN** sidebar is displayed at 260px width with icon + text labels

#### Scenario: Tablet collapsed sidebar
- **WHEN** viewport width is between 768px and 1023px
- **THEN** sidebar collapses to 72px showing only icons

#### Scenario: Mobile hidden sidebar
- **WHEN** viewport width is < 768px
- **THEN** sidebar is hidden and accessible via a hamburger menu toggle

### Requirement: Daemon card grid
The dashboard SHALL display online daemons as cards in a responsive grid showing hostname, alias, session count, agent types, and online status.

#### Scenario: Daemon card displays host info
- **WHEN** one or more daemons are online
- **THEN** each daemon is displayed as a card with: daemon icon, hostname, alias (if set), agent types as tags, and online status indicator (green dot)

#### Scenario: Inline alias editing
- **WHEN** user clicks on the alias text on a daemon card
- **THEN** the alias becomes an editable input field
- **AND** pressing Enter or blurring saves the alias via `PUT /api/daemons/:daemonId/alias`
- **AND** the card updates to show the new alias

#### Scenario: Reset alias to default
- **WHEN** user clears the alias input and saves
- **THEN** the alias reverts to the daemon hostname

#### Scenario: Empty daemon state
- **WHEN** no daemons are online
- **THEN** an empty state message is displayed: "暂无在线主机" with a prompt to start the daemon

### Requirement: Session list in dashboard
The dashboard SHALL display a list of active sessions below the daemon cards, with columns for session title, source (terminal/web), hostname, status, and last activity time.

#### Scenario: Session list displays active sessions
- **WHEN** active sessions exist
- **THEN** a table shows each session with: title, source badge (终端/Web), hostname, status indicator, and relative last activity time

#### Scenario: Session list sorted by activity
- **WHEN** session list is displayed
- **THEN** sessions are sorted by `last_activity_at` descending (most recent first)

#### Scenario: Click session navigates to detail
- **WHEN** user clicks on a session row
- **THEN** the app navigates to `/session/:id`

#### Scenario: No sessions state
- **WHEN** no active sessions exist
- **THEN** an empty state is displayed with a prompt to create a new session

### Requirement: Dashboard quick stats
The dashboard SHALL display quick statistics at the top: total online daemons, total active sessions, and total sub-agents across all sessions.

#### Scenario: Stats display counts
- **WHEN** dashboard loads with data
- **THEN** stat cards show: online daemon count, active session count, and total sub-agent count
- **AND** counts update in real-time as daemons/sessions change

### Requirement: Daemon offline state in dashboard
The dashboard SHALL visually distinguish offline daemons from online ones.

#### Scenario: Offline daemon card
- **WHEN** a daemon goes offline (receives `daemon_status` event with `status: "offline"`)
- **THEN** the daemon card shows a grayed-out appearance with an "离线" badge
- **AND** sessions belonging to that daemon show as `disconnected`

#### Scenario: Daemon reconnects
- **WHEN** a daemon comes back online
- **THEN** the daemon card reverts to full color with "在线" badge
- **AND** its sessions update to their real status

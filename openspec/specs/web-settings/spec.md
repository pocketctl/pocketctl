## ADDED Requirements

### Requirement: Settings page with tabbed sidebar navigation
The Web settings page SHALL use a two-column layout with a vertical tab navigation on the left and content panel on the right, matching the design draft at `ui-design/pocketctl-design-system/web/settings.html`.

#### Scenario: Settings tabs displayed
- **WHEN** user navigates to `/settings`
- **THEN** a left sidebar shows setting categories: 账户, 主机管理, 外观, 通知
- **AND** the first tab (账户) is active by default

#### Scenario: Switch settings tab
- **WHEN** user clicks a different tab in the settings sidebar
- **THEN** the right content panel switches to that tab's content
- **AND** the active tab is visually highlighted

### Requirement: Account settings
The settings page SHALL display the current user's account information including login methods (phone/email) and a logout option.

#### Scenario: Display account info
- **WHEN** the 账户 tab is active
- **THEN** the page displays the user's bound phone number (if any) and email (if any)
- **AND** shows the account creation date

#### Scenario: Logout from settings
- **WHEN** user clicks "退出登录"
- **THEN** tokens are cleared from localStorage
- **AND** user is redirected to `/login`

### Requirement: Host management
The settings page SHALL list all daemons (both online and offline) with hostname, alias, status, and last seen time.

#### Scenario: Host list displays all daemons
- **WHEN** the 主机管理 tab is active
- **THEN** a list of all daemons is displayed with: hostname, alias, online/offline status, and last seen time

#### Scenario: Edit daemon alias from settings
- **WHEN** user edits a daemon's alias in the host list
- **THEN** the alias is saved via `PUT /api/daemons/:daemonId/alias`
- **AND** the list updates immediately

### Requirement: Appearance settings
The settings page SHALL provide theme selection (dark/light/system) and persist the user's preference.

#### Scenario: Theme selector
- **WHEN** the 外观 tab is active
- **THEN** a theme selector is displayed with options: 深色, 浅色, 跟随系统
- **AND** the current selection is highlighted

#### Scenario: Change theme
- **WHEN** user selects a different theme
- **THEN** the `data-theme` attribute updates immediately
- **AND** the preference is saved to `localStorage` with key `pocketctl-theme`

#### Scenario: Follow system theme
- **WHEN** user selects "跟随系统"
- **THEN** the theme automatically switches based on `prefers-color-scheme` media query
- **AND** updates in real-time when the system preference changes

### Requirement: Notification settings
The settings page SHALL provide browser notification permission management and notification preference toggles.

#### Scenario: Notification permission status
- **WHEN** the 通知 tab is active
- **THEN** the current browser notification permission status is displayed (已允许/已拒绝/未设置)
- **AND** a button to request or change permission is shown

#### Scenario: Toggle notification preferences
- **WHEN** user toggles notification preferences (e.g., session completed, daemon offline)
- **THEN** preferences are saved to `localStorage`
- **AND** notifications are filtered based on these preferences
## ADDED Requirements

### Requirement: Force-kick daemon from host management
The Web settings host management page SHALL provide a force-kick action for online daemons with email re-verification.

#### Scenario: Force-kick button displayed per daemon
- **WHEN** the host management tab is active
- **AND** a daemon is online
- **THEN** a "强制下线" button is displayed in that daemon's row

#### Scenario: Force-kick confirmation dialog
- **WHEN** user clicks "强制下线"
- **THEN** a modal dialog appears with:
  - Warning text about disrupting active sessions
  - Email verification code input field
  - Send-code and confirm buttons
- **AND** the system sends a verification code to the user's bound email

#### Scenario: Force-kick success
- **WHEN** user enters the correct verification code and confirms
- **THEN** the daemon is kicked and removed from the online list
- **AND** a success toast is displayed
- **AND** the daemon status changes to "offline" in the list

#### Scenario: Force-kick failure
- **WHEN** user enters an incorrect verification code
- **THEN** an error message is displayed in the dialog
- **AND** the daemon remains online

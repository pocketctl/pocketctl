## ADDED Requirements

### Requirement: HostsView status labels use i18n
The system SHALL display host status labels ("在线"/"离线") and reconnect status via `t()` translation calls, respecting the current locale setting.

#### Scenario: Online host shows translated status
- **WHEN** a daemon is online and locale is "en"
- **THEN** statusLabel() returns "Online"

#### Scenario: Offline host shows translated status
- **WHEN** a daemon is offline and locale is "zh"
- **THEN** statusLabel() returns "离线"

#### Scenario: Reconnecting host shows translated status
- **WHEN** a daemon status is "reconnecting" and locale is "en"
- **THEN** statusLabel() returns "Restarting"

### Requirement: Agent version indicators use i18n
The system SHALL display agent version placeholders and meta labels via `t()` translation calls.

#### Scenario: Agent version pending shows translated text
- **WHEN** agent version is unknown and locale is "zh"
- **THEN** agentVersionLabel() returns "版本待上报"

#### Scenario: Agent upgrade available shows translated meta
- **WHEN** agent has a newer version and locale is "en"
- **THEN** agentMetaLabel() returns "Update available"

#### Scenario: Agent installed latest shows translated meta
- **WHEN** agent is at latest version and locale is "zh"
- **THEN** agentMetaLabel() returns "已安装 · 最新"

### Requirement: Token consumption section uses i18n
The system SHALL display the "Token 消耗" section title and all token stat labels ("主机总计"/"今日消耗"/"本月消耗") via `t()` translation calls.

#### Scenario: Token section title translated
- **WHEN** viewing host detail panel and locale is "en"
- **THEN** the token section heading displays "Token Usage"

#### Scenario: Token stats labels translated
- **WHEN** viewing host detail panel and locale is "en"
- **THEN** the three stat labels display "Host Total", "Today", "This Month"

#### Scenario: No token records message translated
- **WHEN** no session token records exist and locale is "zh"
- **THEN** an empty-state message shows "暂无会话消耗记录"

### Requirement: Confirm dialogs use i18n
The system SHALL display force-kick and unregister confirmation dialog titles, descriptions, and button text via `t()` calls with parameter interpolation for host names.

#### Scenario: Force-kick dialog translated
- **WHEN** user triggers force-kick on host "my-server" and locale is "en"
- **THEN** the dialog title shows 'Force kick "my-server"?', description shows "Disconnect the daemon immediately...", and confirm button shows "Force Kick"

#### Scenario: Unregister dialog translated
- **WHEN** user triggers unregister on host "my-server" and locale is "zh"
- **THEN** the dialog title shows '注销「my-server」？', description shows "从账户移除主机...", and confirm button shows "注销主机"

### Requirement: Toast messages use i18n
The system SHALL display all toast notification messages via `t()` calls with parameter interpolation where the message includes dynamic values.

#### Scenario: Upgrade failed toast translated
- **WHEN** agent upgrade request fails and locale is "zh"
- **THEN** toast shows "升级请求发送失败"

#### Scenario: Copy info toast with host detail
- **WHEN** user copies host connection info "192.168.1.1" and locale is "zh"
- **THEN** toast shows "已复制 192.168.1.1"

#### Scenario: Rename success toast translated
- **WHEN** user renames host to "prod-server" and locale is "en"
- **THEN** toast shows 'Renamed to "prod-server"'

### Requirement: Confirm dialog cancel button uses common i18n key
The system SHALL display the cancel button label in confirm dialogs using the existing `common.cancel` translation key.

#### Scenario: Cancel button translated
- **WHEN** confirm dialog is open and locale is "en"
- **THEN** the cancel button shows "Cancel"

### Requirement: Confirm dialog loading state uses i18n
The system SHALL display the loading state text ("处理中…") via `t()` translation call.

#### Scenario: Loading state text translated
- **WHEN** confirm dialog action is loading and locale is "en"
- **THEN** the button text shows "Processing…"

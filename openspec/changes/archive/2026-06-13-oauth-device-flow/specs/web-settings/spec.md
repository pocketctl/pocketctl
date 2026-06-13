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

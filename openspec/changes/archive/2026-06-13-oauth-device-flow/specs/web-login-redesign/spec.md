## REMOVED Requirements

### Requirement: Dual login mode with tab switching
**Reason**: Phone SMS login is being removed. The login page now only has email verification code login — no tabs needed.
**Migration**: Remove the tab switching UI (`login-tabs`, `switchTab` function). Remove the phone login form (`content-phone`). The email login form becomes the direct content of the login card.

### Requirement: Email domain suffix selector
**Reason**: Simplified login — the full email address input replaces the local-part + suffix selector. This reduces UI complexity and supports all email domains.

## MODIFIED Requirements

### Requirement: Login page theme toggle
The login page SHALL provide a theme toggle button that switches between dark and light themes and persists the preference, applicable to both the main login page and the CLI device authorization page (`/login/cli`).

#### Scenario: Toggle theme on login page
- **WHEN** user clicks the theme toggle button (sun/moon icon)
- **THEN** the `data-theme` attribute on `<html>` changes
- **AND** the preference is saved to `localStorage` with key `pocketctl-theme`

#### Scenario: Restore saved theme
- **WHEN** the page loads and a theme preference exists in `localStorage`
- **THEN** the saved theme is applied automatically

#### Scenario: Theme toggle on device authorization page
- **WHEN** user visits `/login/cli`
- **THEN** the theme toggle button is present
- **AND** it functions identically to the main login page

### Requirement: Error banner
The login page and the device authorization page SHALL display error messages in a styled banner when authentication or authorization fails.

#### Scenario: Display error on failed login
- **WHEN** email code verification fails
- **THEN** an error banner appears with the error message

#### Scenario: Display error on failed device authorization
- **WHEN** device authorization fails (expired code, invalid code)
- **THEN** an error banner appears on `/login/cli` with the error message

### Requirement: Login button loading state
The login button on both the email login form and the device authorization confirmation button SHALL show a loading/disabled state during API calls.

#### Scenario: Email login button loading
- **WHEN** user clicks "登录" and the API call is in progress
- **THEN** the button shows "登录中..." and is disabled

#### Scenario: Device authorization button loading
- **WHEN** user clicks "授权此设备" and the API call is in progress
- **THEN** the button shows "授权中..." and is disabled

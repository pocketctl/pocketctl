## ADDED Requirements

### Requirement: Dual login mode with tab switching
The Web login page SHALL provide two login modes — phone SMS and email verification code — switched via tabs, matching the design draft at `ui-design/pocketctl-design-system/web/login.html`.

#### Scenario: Default to phone login tab
- **WHEN** user navigates to the login page
- **THEN** the phone login tab is active by default
- **AND** the phone number input and verification code input are displayed

#### Scenario: Switch between tabs
- **WHEN** user clicks the "邮箱登录" tab
- **THEN** the email tab becomes active with visual highlight
- **AND** the phone form is hidden
- **AND** the email form with domain suffix selector is displayed
- **AND** any error banner is cleared

#### Scenario: Tab visual states
- **WHEN** a tab is active
- **THEN** it SHALL have a distinct background (`--surface`) and text color (`--fg`)
- **WHEN** a tab is hovered (not active)
- **THEN** it SHALL show a highlight on hover

### Requirement: Theme-adaptive logo
The login page SHALL display the pocketctl logo that adapts to the current theme (dark/light).

#### Scenario: Dark theme logo
- **WHEN** the page theme is set to dark
- **THEN** the logo displayed is `logo-github-org.svg`

#### Scenario: Light theme logo
- **WHEN** the page theme is set to light
- **THEN** the logo displayed is `logo-github-org-light.svg`

#### Scenario: Logo changes on theme toggle
- **WHEN** user toggles the theme via the theme toggle button
- **THEN** the logo updates immediately without page reload

### Requirement: Verification code countdown
The login page SHALL implement a 60-second countdown timer on the "获取验证码" button after the user requests a verification code.

#### Scenario: Countdown starts on code request
- **WHEN** user clicks "获取验证码"
- **THEN** the button text changes to "60s 后重发"
- **AND** the button becomes disabled
- **AND** the countdown decrements every second

#### Scenario: Countdown completes
- **WHEN** the countdown reaches 0
- **THEN** the button text reverts to "获取验证码"
- **AND** the button becomes enabled again

#### Scenario: Countdown prevents double request
- **WHEN** the countdown is active
- **THEN** clicking the button has no effect

### Requirement: Email domain suffix selector
The email login form SHALL display a domain suffix (e.g., `@gmail.com`) as a visual suffix in the email input group.

#### Scenario: Email input with suffix
- **WHEN** the email tab is active
- **THEN** the email input group shows an input field for the local part and a suffix displaying `@gmail.com`
- **AND** the combined value (local + suffix) is submitted as the email address

### Requirement: Error banner
The login page SHALL display error messages in a styled banner when authentication fails.

#### Scenario: Display error on failed login
- **WHEN** login verification fails
- **THEN** an error banner appears above the tabs with the error message
- **AND** the banner has a red background (`--error-bg`) and red text (`--error`)

#### Scenario: Clear error on tab switch
- **WHEN** user switches between phone and email tabs
- **THEN** any visible error banner is hidden

### Requirement: Login button loading state
The login button SHALL show a loading/disabled state during the authentication API call.

#### Scenario: Button loading state
- **WHEN** user clicks "登录" and the API call is in progress
- **THEN** the button shows "登录中..." and is disabled
- **AND** the button uses reduced opacity (0.5)

#### Scenario: Button re-enabled on failure
- **WHEN** the API call fails
- **THEN** the button reverts to "登录" and is re-enabled

### Requirement: Login page theme toggle
The login page SHALL provide a theme toggle button that switches between dark and light themes and persists the preference.

#### Scenario: Toggle theme
- **WHEN** user clicks the theme toggle button (sun/moon icon)
- **THEN** the `data-theme` attribute on `<html>` changes
- **AND** the preference is saved to `localStorage` with key `pocketctl-theme`

#### Scenario: Restore saved theme
- **WHEN** the page loads and a theme preference exists in `localStorage`
- **THEN** the saved theme is applied automatically
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

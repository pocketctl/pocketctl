## REMOVED Requirements

### Requirement: Relay sends SMS verification code
**Reason**: SMS verification is being phased out entirely. The project adopted SMS as a temporary workaround because the domain had not passed ICP filing, which blocked email verification. OAuth 2.0 Device Flow now serves as the primary CLI auth method, with email verification code as the fallback.
**Migration**: Remove `POST /api/auth/sms/send` and `POST /api/auth/sms/verify` endpoints. Remove `config/sms.ts`. Remove SMS tab from Web login page. Remove SMS option from CLI login menu. The Go `api.SendSMS` and `api.VerifySMS` functions are removed.

### Requirement: Daemon CLI supports SMS verification code login
**Reason**: SMS login option removed from CLI. Users on GUI-enabled machines use OAuth Device Flow. Users on headless machines use email verification code.
**Migration**: The `pocketctl login` command menu removes the "手机号 + 验证码" option. The `loginViaPhone` function in `cmd/pocketctl/main.go` is removed.

### Requirement: Web login supports phone SMS tab
**Reason**: SMS tab removed from Web login page. Web login uses email verification code only.
**Migration**: Remove the phone tab from the Web login page. Remove SMS-related code from `web/src/composables/useAuth.ts`.

## MODIFIED Requirements

### Requirement: Daemon CLI supports email verification code login
The `pocketctl login` command SHALL support email verification code login as the login method for headless servers (no browser available).

#### Scenario: CLI auto-detects headless environment
- **WHEN** user runs `pocketctl login` on a machine without browser capability (no DISPLAY, no WAYLAND_DISPLAY, no `open` or `xdg-open`)
- **THEN** CLI SHALL automatically use the email verification code flow
- **AND** CLI displays: "检测到无浏览器环境，使用邮箱验证码登录"

#### Scenario: Select email login from menu
- **WHEN** user runs `pocketctl login` with the `--email` flag
- **THEN** CLI SHALL use the email verification code flow regardless of environment detection

#### Scenario: Email code login flow
- **WHEN** user runs the email verification code login flow
- **THEN** CLI prompts for email address
- **AND** CLI validates the email contains "@"
- **AND** CLI calls `POST /api/auth/email/send` to send a verification code
- **AND** CLI prompts for the 6-digit verification code
- **AND** CLI calls `POST /api/auth/email/verify` to authenticate
- **AND** on success, saves the JWT tokens to `~/.pocketctl/auth.json`

#### Scenario: Invalid email input
- **WHEN** user enters an email that does not contain "@"
- **THEN** CLI displays "错误: 请输入有效的邮箱地址" and exits

#### Scenario: Login success message
- **WHEN** email verification succeeds
- **THEN** CLI displays "登录成功!" with the saved token path

### Requirement: Web login supports email verification code tab
The Web login page SHALL provide email verification code login as the sole login method (phone SMS removed).

#### Scenario: Email login form displayed by default
- **WHEN** user navigates to the login page
- **THEN** the email login form is displayed as the only login method
- **AND** no tab switching UI is present (single-mode page)

#### Scenario: Send email verification code from web
- **WHEN** user enters an email and clicks "获取验证码"
- **THEN** a 60-second countdown starts on the button
- **AND** the button is disabled during the countdown
- **AND** the API call to `POST /api/auth/email/send` is made

#### Scenario: Login with email verification code
- **WHEN** user enters a 6-digit code and clicks "登录"
- **THEN** the API call to `POST /api/auth/email/verify` is made
- **AND** on success, tokens are saved and user is redirected to the dashboard
- **AND** on failure, an error banner is displayed

## ADDED Requirements

### Requirement: Relay sends email verification code
The Relay server SHALL provide an endpoint to send a 6-digit verification code to a user's email address via Tencent Cloud SES.

#### Scenario: Send verification code to valid email
- **WHEN** client sends `POST /api/auth/email/send` with `{ "email": "user@example.com" }`
- **THEN** Relay generates a 6-digit numeric code and sends it to the email address via Tencent Cloud SES
- **AND** Relay stores the code with a 5-minute expiry
- **AND** response returns `{ "success": true }`

#### Scenario: Send code with missing email
- **WHEN** client sends `POST /api/auth/email/send` without an email field
- **THEN** Relay responds with HTTP 400 and `{ "error": "email is required" }`

#### Scenario: Rate limit on code sending
- **WHEN** the same email requests a code more than once within 60 seconds
- **THEN** Relay responds with HTTP 429 and `{ "error": "please wait before requesting another code" }`

#### Scenario: Email service unavailable
- **WHEN** Tencent Cloud SES API call fails
- **THEN** Relay responds with HTTP 500 and `{ "error": "验证码发送失败，请稍后重试" }`

### Requirement: Relay verifies email code and authenticates
The Relay server SHALL provide an endpoint to verify an email verification code and return JWT tokens. If no user exists with that email, a new user SHALL be created automatically.

#### Scenario: Verify correct code
- **WHEN** client sends `POST /api/auth/email/verify` with `{ "email": "user@example.com", "code": "123456" }`
- **AND** the code matches the stored code and is not expired
- **THEN** Relay returns `{ "access_token": "...", "refresh_token": "...", "user": { "id": ..., "email": "user@example.com", "display_name": null } }`
- **AND** the verification code is deleted after successful verification

#### Scenario: Verify incorrect code
- **WHEN** client sends `POST /api/auth/email/verify` with a code that does not match the stored code
- **THEN** Relay responds with HTTP 400 and `{ "error": "invalid or expired verification code" }`

#### Scenario: Verify expired code
- **WHEN** client sends `POST /api/auth/email/verify` with a code that has expired (over 5 minutes old)
- **THEN** Relay responds with HTTP 400 and `{ "error": "invalid or expired verification code" }`

#### Scenario: Auto-register new user
- **WHEN** a verification is successful for an email that does not exist in the `users` table
- **THEN** a new user row is created with `email` set to the verified email and `phone` set to NULL
- **AND** JWT tokens are issued for the new user

### Requirement: Daemon CLI supports email verification code login
The `pocketctl login` command SHALL support email verification code login as an alternative to phone SMS login.

#### Scenario: Select email login from menu
- **WHEN** user runs `pocketctl login` and selects the email option
- **THEN** CLI prompts for email address
- **AND** CLI validates the email contains "@"
- **AND** CLI calls `POST /api/auth/email/send` to send a verification code
- **AND** CLI prompts for the 6-digit verification code
- **AND** CLI calls `POST /api/auth/email/verify` to authenticate
- **AND** on success, saves the JWT tokens to `~/.pocketctl/auth.json`

#### Scenario: Invalid email input
- **WHEN** user enters an email that does not contain "@"
- **THEN** CLI displays "错误: 请输入有效的邮箱地址" and exits

#### Scenario: Code send failure
- **WHEN** the verification code send API call fails
- **THEN** CLI displays the error message and exits

#### Scenario: Login success message
- **WHEN** email verification succeeds
- **THEN** CLI displays "登录成功!" with the saved token path

### Requirement: Web login supports email verification code tab
The Web login page SHALL provide an email verification code login tab as an alternative to the phone SMS tab.

#### Scenario: Switch to email tab
- **WHEN** user clicks the "邮箱登录" tab on the login page
- **THEN** the phone login form is hidden and the email login form is displayed
- **AND** the email input field shows a domain suffix selector (e.g., `@gmail.com`)

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

### Requirement: Email verification code is stored in memory
The Relay server SHALL store email verification codes in the same in-memory store used for SMS codes, with identical expiry and cleanup behavior.

#### Scenario: Code expires after 5 minutes
- **WHEN** a verification code is generated
- **THEN** it SHALL be valid for 5 minutes
- **AND** after expiry, verification attempts with that code SHALL fail

#### Scenario: Code is single-use
- **WHEN** a verification code is successfully verified
- **THEN** the code SHALL be deleted from the store
- **AND** the same code cannot be used again

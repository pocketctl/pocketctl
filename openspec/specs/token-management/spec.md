## ADDED Requirements

### Requirement: JWT includes jti claim
The JWT access token SHALL include a unique `jti` (JWT ID) claim for revocation support.

#### Scenario: Access token issued with jti
- **WHEN** Relay issues a new access token via any auth flow (device, email, refresh)
- **THEN** the JWT payload includes `"jti": "<128-bit-random-base64url>"`
- **AND** the `jti` is unique across all issued tokens

#### Scenario: Refresh token includes jti
- **WHEN** Relay issues a new refresh token
- **THEN** the JWT payload includes `"jti": "<128-bit-random-base64url>"`
- **AND** the `type` claim is `"refresh"`

### Requirement: JWT includes machine_id claim
The JWT access token SHALL include a `machine_id` claim to bind the token to a specific machine.

#### Scenario: Device flow token includes machine_id
- **WHEN** Relay issues an access token via the Device Flow
- **AND** the authorization request included a `machine_id`
- **THEN** the JWT payload SHALL include `"machine_id": "<value>"` matching the authorization request

#### Scenario: Email code token includes placeholder machine_id
- **WHEN** Relay issues an access token via email verification code (headless flow)
- **AND** no `machine_id` is provided in the login request
- **THEN** the JWT payload SHALL include `"machine_id": "unknown"`

### Requirement: Token revocation via revoked_tokens table
The Relay server SHALL check the `revoked_tokens` table when verifying access tokens.

#### Scenario: Valid token passes revocation check
- **WHEN** Relay verifies an access token whose `jti` is not in `revoked_tokens`
- **AND** the token signature and expiry are valid
- **THEN** verification succeeds and returns the token payload

#### Scenario: Revoked token fails verification
- **WHEN** Relay verifies an access token whose `jti` exists in `revoked_tokens`
- **THEN** verification fails with status `revoked`
- **AND** a WebSocket connection using this token is closed with code 4001

### Requirement: Refresh token rotation
The Relay server SHALL implement refresh token rotation — each refresh operation revokes the old refresh token and issues a new one.

#### Scenario: Successful refresh revokes old token
- **WHEN** client calls `POST /api/auth/refresh` with a valid refresh token
- **THEN** Relay verifies the refresh token
- **AND** Relay inserts the old refresh token's `jti` into `revoked_tokens` with `reason: "rotation"`
- **AND** Relay issues a new access token and a new refresh token
- **AND** the response includes `{ "access_token": "...", "refresh_token": "<new>" }`

#### Scenario: Reuse of revoked refresh token
- **WHEN** client calls `POST /api/auth/refresh` with a refresh token whose `jti` has been revoked
- **THEN** Relay responds with HTTP 401 and `{ "error": "invalid or expired refresh token" }`
- **AND** Relay inserts ALL refresh tokens for that user into `revoked_tokens` (breach detection)

### Requirement: Token cleanup job
The Relay server SHALL periodically purge expired entries from the `revoked_tokens` table.

#### Scenario: Expired access tokens purged
- **WHEN** the cleanup job runs (every 6 hours)
- **THEN** all entries in `revoked_tokens` with `revoked_at` older than 25 hours are deleted (access tokens expire in 24h)

#### Scenario: Expired refresh token entries purged
- **WHEN** the cleanup job runs
- **THEN** all entries in `revoked_tokens` with `revoked_at` older than 8 days and `reason: "rotation"` are deleted (refresh tokens expire in 7 days)

### Requirement: Audit log table
The Relay server SHALL maintain an `audit_log` table recording all authentication-related actions.

#### Scenario: Device authorization logged
- **WHEN** a device authorization is confirmed via `/api/auth/device/confirm`
- **THEN** an audit log entry is created with `action: "device_authorize"`, `user_id`, `ip`, and `details: { "client_id": "...", "machine_id": "..." }`

#### Scenario: Token revocation logged
- **WHEN** a token is revoked via `/api/auth/revoke`
- **THEN** an audit log entry is created with `action: "token_revoke"`, `user_id`, `ip`, and `details: { "reason": "...", "jti": "..." }`

#### Scenario: Force kick logged
- **WHEN** a daemon is force-kicked from the Web settings
- **THEN** an audit log entry is created with `action: "force_kick"`, `user_id`, `ip`, and `details: { "daemon_id": "...", "hostname": "..." }`

#### Scenario: New login displaces old daemon
- **WHEN** a new daemon registration causes an old daemon's token to be revoked
- **THEN** an audit log entry is created with `action: "daemon_replace"`, `user_id`, `ip`, and `details: { "old_daemon_id": "...", "new_daemon_id": "...", "grace_period": 300 }`

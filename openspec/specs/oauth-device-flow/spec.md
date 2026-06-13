## ADDED Requirements

### Requirement: Device Authorization Endpoint
The Relay server SHALL provide a Device Authorization endpoint at `POST /api/auth/device/authorize` conforming to RFC 8628 §3.1.

#### Scenario: Successful authorization request
- **WHEN** client sends `POST /api/auth/device/authorize` with `{ "client_id": "pocketctl-cli", "scope": "daemon:control session:read session:write", "code_challenge": "<S256-challenge>", "code_challenge_method": "S256", "machine_id": "daemon-a1b2c3d4" }`
- **THEN** Relay generates a `device_code` (40-char random string) and `user_code` (8-char human-readable string)
- **AND** Relay stores the authorization session with status `pending`, expiry of 600 seconds, and the provided `code_challenge`
- **AND** Relay returns `{ "device_code": "...", "user_code": "ABCD-1234", "verification_uri": "http://<relay-host>/login/cli", "verification_uri_complete": "http://<relay-host>/login/cli?code=ABCD-1234", "expires_in": 600, "interval": 5 }`

#### Scenario: Authorization request with unknown client_id
- **WHEN** client sends `POST /api/auth/device/authorize` with `{ "client_id": "unknown-app" }`
- **THEN** Relay responds with HTTP 400 and `{ "error": "invalid_client", "error_description": "Unknown client_id" }`

#### Scenario: Authorization request missing required fields
- **WHEN** client sends `POST /api/auth/device/authorize` without a `client_id` field
- **THEN** Relay responds with HTTP 400 and `{ "error": "invalid_request", "error_description": "client_id is required" }`

#### Scenario: PKCE required for public clients
- **WHEN** client sends `POST /api/auth/device/authorize` without `code_challenge` for a public client
- **THEN** Relay responds with HTTP 400 and `{ "error": "invalid_request", "error_description": "code_challenge is required for public clients" }`

### Requirement: Device Token Endpoint
The Relay server SHALL provide a Device Token endpoint at `POST /api/auth/device/token` conforming to RFC 8628 §3.4.

#### Scenario: Successful token request after authorization
- **WHEN** client sends `POST /api/auth/device/token` with `{ "grant_type": "urn:ietf:params:oauth:grant-type:device_code", "device_code": "<valid-code>", "client_id": "pocketctl-cli", "code_verifier": "<verifier>" }`
- **AND** the corresponding `user_code` has been confirmed by the user in the browser
- **AND** the `code_verifier` matches the stored `code_challenge` via S256
- **THEN** Relay verifies PKCE and the authorization status
- **AND** Relay signs a JWT with claims `{ userId, email, type: "access", jti, machine_id, iat, exp: iat + 86400 }`
- **AND** Relay returns `{ "access_token": "...", "refresh_token": "...", "token_type": "Bearer", "expires_in": 86400 }`

#### Scenario: Token request before user authorization
- **WHEN** client sends a token request with a valid `device_code`
- **AND** the user has not yet confirmed authorization in the browser
- **THEN** Relay responds with HTTP 400 and `{ "error": "authorization_pending" }`

#### Scenario: Token request with expired device_code
- **WHEN** client sends a token request with a `device_code` that is past its 600-second expiry
- **THEN** Relay responds with HTTP 400 and `{ "error": "expired_token", "error_description": "device_code has expired" }`

#### Scenario: Token request with rate limiting (slow_down)
- **WHEN** client polls the token endpoint more frequently than the specified `interval`
- **THEN** Relay responds with HTTP 400 and `{ "error": "slow_down" }`

#### Scenario: Token request with invalid code_verifier
- **WHEN** client sends a token request with a `code_verifier` whose S256 hash does not match the stored `code_challenge`
- **THEN** Relay responds with HTTP 400 and `{ "error": "invalid_grant", "error_description": "code_verifier does not match code_challenge" }`

### Requirement: User Code Confirmation Endpoint
The Relay server SHALL provide an endpoint for the browser to confirm user authorization of a device.

#### Scenario: Authenticated user confirms device authorization
- **WHEN** browser sends `POST /api/auth/device/confirm` with `{ "user_code": "ABCD-1234" }`
- **AND** the request includes a valid `Authorization: Bearer <token>` header (user is logged into Web)
- **THEN** Relay marks the corresponding authorization session as `status: "authorized"`
- **AND** Relay stores the authenticated `user_id` on the authorization session
- **AND** Relay returns `{ "success": true }`

#### Scenario: Confirm without authentication
- **WHEN** browser sends `POST /api/auth/device/confirm` without a valid Authorization header
- **THEN** Relay responds with HTTP 401 and `{ "error": "authentication_required" }`

#### Scenario: Confirm with invalid user_code
- **WHEN** browser sends `POST /api/auth/device/confirm` with a `user_code` that does not exist or has expired
- **THEN** Relay responds with HTTP 400 and `{ "error": "invalid_user_code" }`

### Requirement: Token Revocation Endpoint
The Relay server SHALL provide a Token Revocation endpoint at `POST /api/auth/revoke` following RFC 7009 semantics.

#### Scenario: Revoke access token
- **WHEN** client sends `POST /api/auth/revoke` with `{ "token": "<access-token>", "token_type_hint": "access_token" }`
- **AND** the request includes a valid Authorization header belonging to the same user
- **THEN** Relay extracts the `jti` from the token (without verifying expiry)
- **AND** Relay inserts the `jti` into the `revoked_tokens` table with `reason: "user_revoke"`
- **AND** Relay returns HTTP 200

#### Scenario: Revoke another user's token
- **WHEN** client sends a revocation request for a token belonging to a different user
- **THEN** Relay responds with HTTP 403 and `{ "error": "forbidden" }`

### Requirement: OAuth Discovery Endpoint
The Relay server SHALL provide an OAuth 2.0 Authorization Server Metadata endpoint at `GET /.well-known/oauth-authorization-server` per RFC 8414.

#### Scenario: Discovery endpoint returns metadata
- **WHEN** client sends `GET /.well-known/oauth-authorization-server`
- **THEN** Relay returns JSON metadata including: `issuer`, `device_authorization_endpoint`, `token_endpoint`, `revocation_endpoint`, `code_challenge_methods_supported: ["S256"]`, `grant_types_supported: ["urn:ietf:params:oauth:grant-type:device_code"]`

### Requirement: CLI Device Authorization Page
The Web client SHALL provide a device authorization confirmation page at `/login/cli`.

#### Scenario: User visits device authorization page with valid user_code
- **WHEN** browser navigates to `/login/cli?code=ABCD-1234`
- **AND** the user_code is valid and not expired
- **THEN** the page displays: "pocketctl CLI 正在请求访问权限" with the user_code displayed prominently
- **AND** the page shows a login form if user is not already authenticated
- **AND** the page shows a "授权此设备" (Authorize this device) button if user is authenticated

#### Scenario: User confirms authorization on the page
- **WHEN** authenticated user clicks "授权此设备"
- **THEN** the page calls `POST /api/auth/device/confirm` with the user_code
- **AND** on success, displays "授权成功！你可以关闭此页面" with a checkmark icon
- **AND** on failure, displays the error message

#### Scenario: User visits page with expired user_code
- **WHEN** browser navigates to `/login/cli?code=ABCD-1234` with an expired user_code
- **THEN** the page displays "此授权码已过期，请在命令行重新运行 pocketctl login"

### Requirement: CLI PKCE and Device Flow Implementation
The Go Daemon CLI SHALL implement the OAuth 2.0 Device Authorization Grant client flow with PKCE.

#### Scenario: CLI initiates device flow
- **WHEN** user runs `pocketctl login` on a machine with browser capability
- **THEN** CLI generates a PKCE `code_verifier` (32 random bytes, base64url-encoded) and `code_challenge` (SHA256 of verifier)
- **AND** CLI calls `POST /api/auth/device/authorize` with `client_id: "pocketctl-cli"`, `code_challenge`, `code_challenge_method: "S256"`, and `machine_id`
- **AND** CLI opens the browser with `verification_uri_complete`
- **AND** CLI prints the URL for manual entry: "请在浏览器中打开: http://..."

#### Scenario: CLI polls for token
- **WHEN** CLI has a valid `device_code` and the user has not yet authorized
- **THEN** CLI polls `POST /api/auth/device/token` every `interval` seconds (minimum 5s)
- **AND** CLI displays a spinner with elapsed time: "等待授权... (已等待 15s)"
- **AND** on `authorization_pending`, CLI continues polling
- **AND** on success, CLI saves the tokens to `~/.pocketctl/auth.json`

#### Scenario: CLI handles device_code expiry
- **WHEN** the `device_code` expires (600 seconds) without user authorization
- **THEN** CLI displays "授权超时，请重新运行 pocketctl login"
- **AND** CLI exits with code 1

#### Scenario: CLI browser open failure fallback
- **WHEN** `open` or `xdg-open` command fails or is unavailable
- **THEN** CLI prints the complete URL prominently and prompts the user to manually open it
- **AND** CLI continues polling as normal

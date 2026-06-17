# QR Scan-Login

Cross-device login flow: the **Web client** displays a QR code, the **iOS App**
(an already-authenticated device) scans it and confirms, and the Web client polls
until it receives tokens. This is distinct from the OAuth Device Flow
(`oauth-device-flow`), which is designed for CLI clients typing a `user_code`.
QR scan-login reuses the same in-memory session pattern but with a dedicated,
shorter-lived session store.

## ADDED Requirements

### Requirement: QR Session Creation Endpoint
The Relay server SHALL provide an endpoint `POST /api/auth/qr/create` that
starts a QR scan-login session. It requires no authentication (the web client is
not yet logged in).

#### Scenario: Web creates a QR session
- **WHEN** client sends `POST /api/auth/qr/create` (empty body)
- **THEN** Relay generates an opaque `qr_token` (32-char string)
- **AND** Relay stores a QR session with status `pending` and a 120-second expiry
- **AND** Relay returns `{ "qr_token": "...", "qr_payload": "<WEB_APP_URL>/login/qr?token=<qr_token>", "expires_in": 120, "interval": 2 }`

### Requirement: QR Status Polling Endpoint
The Relay server SHALL provide an endpoint `GET /api/auth/qr/status` for the
Web client to poll the state of a QR login session.

#### Scenario: Polling a pending session
- **WHEN** client sends `GET /api/auth/qr/status?qr_token=<token>` for a session not yet confirmed
- **THEN** Relay returns `{ "status": "pending" }` (or `"scanned"` if the iOS client marked it scanned)

#### Scenario: Polling a confirmed session issues tokens
- **WHEN** client sends `GET /api/auth/qr/status?qr_token=<token>` for a session whose status is `confirmed`
- **THEN** Relay looks up the bound `user_id`, issues a JWT access token (`machine_id: "web-qr"`) and refresh token
- **AND** Relay deletes the session (single-use)
- **AND** Relay returns `{ "status": "confirmed", "access_token": "...", "refresh_token": "...", "user": { id, email, phone, display_name } }`

#### Scenario: Polling an unknown or expired token
- **WHEN** client sends `GET /api/auth/qr/status?qr_token=<token>` for a session that does not exist or has expired
- **THEN** Relay returns `{ "status": "expired" }`

#### Scenario: Polling without a token
- **WHEN** client sends `GET /api/auth/qr/status` without the `qr_token` query parameter
- **THEN** Relay responds with HTTP 400 and `{ "error": "qr_token is required" }`

### Requirement: QR Confirmation Endpoint
The Relay server SHALL provide an endpoint `POST /api/auth/qr/confirm` for the
iOS App to confirm a QR login session. It requires a valid Bearer access token
(the iOS user is already authenticated).

#### Scenario: Authenticated iOS user confirms a QR session
- **WHEN** iOS sends `POST /api/auth/qr/confirm` with `{ "qr_token": "<token>" }` and a valid `Authorization: Bearer <token>` header
- **THEN** Relay marks the session `status: "confirmed"` and stores the authenticated `user_id`
- **AND** Relay records an `qr_login_confirm` audit log entry
- **AND** Relay returns `{ "success": true }`

#### Scenario: Confirm without authentication
- **WHEN** iOS sends `POST /api/auth/qr/confirm` without a Bearer header
- **THEN** Relay responds with HTTP 401 and `{ "error": "authentication_required" }`

#### Scenario: Confirm with an invalid or expired token
- **WHEN** iOS sends `POST /api/auth/qr/confirm` with a `qr_token` that does not match a live session
- **THEN** Relay responds with HTTP 400 and `{ "error": "invalid_or_expired_qr_token" }`

### Requirement: QR Session Lifecycle
QR sessions SHALL be held in memory with a 120-second TTL and cleaned up every
30 seconds by a background timer that does not block process exit (`unref`).

#### Scenario: Session expiry
- **WHEN** a QR session is older than 120 seconds
- **THEN** the next `getQrSession`/`confirmQrSession` call removes it and treats it as non-existent

#### Scenario: Single-use consumption
- **WHEN** a confirmed session is read by `/api/auth/qr/status` and tokens are issued
- **THEN** the session is deleted and cannot be polled again

## Why

The current authentication system relies on SMS verification codes (Tencent Cloud SMS) as the primary login method for both CLI and Web. SMS was adopted as a temporary workaround because the project's domain has not yet passed ICP filing, blocking the use of email verification services. This approach has real costs (≈¥0.045 per SMS), a cumbersome user experience (wait for code, manually type it), and is not a credible authentication story for an open-source project. Now is the right time to replace this temporary solution with the target architecture — OAuth 2.0 Device Authorization Grant (RFC 8628) as the primary CLI auth method, with email verification codes retained as the headless-server fallback. This sets the project up for ecosystem growth, third-party client integration, and App Store compliance.

## What Changes

- **Add OAuth 2.0 Device Authorization Grant (RFC 8628)** — CLI login opens a browser for user authorization via a minimal OAuth Device Flow implementation with 3 hardcoded first-party clients (CLI, Web, iOS)
- **Add `/api/auth/device/*` endpoints** — `/authorize`, `/token` per RFC 8628 §3, plus a `/revoke` endpoint per RFC 7009 semantics
- **Add `GET /.well-known/oauth-authorization-server`** — RFC 8414 discovery metadata for client auto-configuration
- **Add Web-based CLI authorization page** — A new page where the user confirms granting access to a CLI device after browser-based login
- **Remove SMS verification code login entirely** — Drop `/api/auth/sms/send` and `/api/auth/sms/verify` endpoints, remove SMS config (`config/sms.ts`), remove SMS UI from Web login and CLI
- **Retain email verification code login** — Kept as the fallback for headless servers (SSH/VPS without a browser) and as the Web/iOS login method
- **Add PKCE (S256) to all public-client flows** — Both Device Flow and browser-based authorization use code_challenge / code_verifier for security
- **Add soft eviction for daemon switching** — When a user logs in on a new machine, the old daemon receives a takeover notification with a 5-minute grace period before token revocation
- **Add Web-based force-kick for daemons** — Users can forcibly disconnect a remote daemon from the Web settings page, requiring email re-verification for authorization
- **Add token revocation table** — `revoked_tokens` table with JWT ID (jti) tracking to support token invalidation
- **Add audit logging for auth actions** — `audit_log` table recording login, kick, and token revocation events
- **Enhance daemon limit** — Upgrade from hard-reject to soft-eviction with Web fallback; bind daemon to `machine_id` in JWT claims
- **Environment-adaptive login** — CLI auto-detects GUI vs headless environment and presents the appropriate login method

## Capabilities

### New Capabilities

- `oauth-device-flow`: OAuth 2.0 Device Authorization Grant (RFC 8628) — minimal implementation with hardcoded first-party clients, PKCE, and browser-based authorization for CLI login
- `token-management`: JWT token lifecycle management including jti-based revocation, refresh token rotation, and the `revoked_tokens` table
- `web-daemon-force-kick`: Web settings page capability for users to forcibly disconnect a remote daemon, requiring email re-verification

### Modified Capabilities

- `daemon-limit`: Upgraded from hard-reject to soft-eviction model — new machine login triggers takeover notification with grace period instead of immediate rejection; Web force-kick adds an authorized override path
- `email-verification-auth`: SMS auth endpoints removed; email verification code login retained as the sole verification-code fallback for headless CLI, Web, and iOS
- `web-settings`: Host management tab extended to support force-kick action with email re-verification flow
- `web-login-redesign`: SMS tab removed; login page simplified to email-only verification code flow

## Impact

- **CLI (`cmd/pocketctl/main.go`)**: `cmdLogin` rewritten for device flow + email fallback; new `open` browser logic; PKCE implementation; SMS code removed
- **API client (`internal/api/client.go`)**: New device auth API calls added; SMS/email send removed; refresh token call retained
- **Config (`internal/config/config.go`)**: Token storage extended to include `refresh_token` rotation and `machine_id` binding
- **Relay server (`relay/src/server.ts`)**: SMS endpoints removed; 4 new OAuth endpoints added; `/api/auth/email/send` and `/verify` retained; audit logging added
- **Relay router (`relay/src/router.ts`)**: Daemon registration enhanced with soft eviction; old token invalidation on new registration
- **Relay auth (`relay/src/auth.ts`)**: JWT signing extended to include `jti` and `machine_id` claims; revocation check added
- **Relay DB (`relay/src/db.ts`)**: `revoked_tokens` table; `audit_log` table; `daemons.active_token_jti` column; SMS-related user creation removed
- **Relay config**: `config/sms.ts` deleted; `config/verification.ts` retained for email codes only
- **Web (`web/src/`)**: New CLI authorization confirmation page; SMS tab removed from login; force-kick added to settings
- **UI Design (`ui-design/`)**: SMS login UI removed from design system
- **Documentation (`README.md`)**: Auth section updated to reflect OAuth 2.0 + email fallback
- **Dependencies**: New Go dependency `golang.org/x/oauth2` (minimal use); no new Node.js dependencies (standard crypto for PKCE)

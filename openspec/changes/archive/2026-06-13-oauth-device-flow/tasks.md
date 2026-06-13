## 1. Database Migrations

- [x] 1.1 Add `revoked_tokens` table with `jti` (PK), `user_id` (FK), `revoked_at`, `reason` columns and indexes
- [x] 1.2 Add `audit_log` table
- [x] 1.3 Add `active_token_jti`, `machine_id`, `last_login_at` columns
- [x] 1.4 Add `max_daemons` column to `users` table
- [x] 1.5 Add token cleanup function
- [x] 1.6 Add audit log insertion helper

## 2. Relay Server — OAuth Device Flow Endpoints

- [x] 2.1 Define hardcoded `CLIENTS` registry in new `relay/src/config/clients.ts` with 3 first-party clients (pocketctl-cli, pocketctl-web, pocketctl-ios)
- [x] 2.2 Implement `POST /api/auth/device/authorize` endpoint in `server.ts` (RFC 8628 §3.1) — validate client_id, require PKCE code_challenge for public clients, generate device_code/user_code, store authorization session in memory
- [x] 2.3 Implement `POST /api/auth/device/confirm` endpoint in `server.ts` — verify user JWT from Authorization header, validate user_code, mark authorization session as authorized, log audit event
- [x] 2.4 Implement `POST /api/auth/device/token` endpoint in `server.ts` (RFC 8628 §3.4) — verify device_code, check authorization status, verify PKCE code_verifier, handle `authorization_pending`/`slow_down`/`expired_token` errors, issue JWT with jti and machine_id claims
- [x] 2.5 Implement `GET /.well-known/oauth-authorization-server` endpoint in `server.ts` (RFC 8414) — return discovery metadata JSON
- [x] 2.6 Add in-memory authorization session store with expiry (600s TTL) and automatic cleanup

## 3. Relay Server — Token Management

- [x] 3.1 Extend `signAccessToken` in `auth.ts` to include `jti` (128-bit random) and `machine_id` claims
- [x] 3.2 Extend `signRefreshToken` in `auth.ts` to include `jti` claim
- [x] 3.3 Extend `verifyAccessToken` in `auth.ts` to check `jti` against `revoked_tokens` table (reject if revoked)
- [x] 3.4 Implement `POST /api/auth/revoke` endpoint in `server.ts` — extract jti from token, verify ownership, insert into revoked_tokens, log audit event
- [x] 3.5 Update `POST /api/auth/refresh` in `server.ts` to implement refresh token rotation — revoke old refresh token jti, issue new refresh token
- [x] 3.6 Add breach detection to refresh — if a revoked refresh token is reused, revoke ALL refresh tokens for that user
- [x] 3.7 Add periodic cleanup job for `revoked_tokens` (every 6 hours, purge expired entries)

## 4. Relay Server — Daemon Switching (Soft Eviction + Force Kick)

- [x] 4.1 Update `registerDaemon` in `router.ts` — implement soft eviction: on second daemon registration for free users, send `kicked` message to old daemon with `reason: "new_login"` and 300s grace period; send `takeover_warning` to new daemon
- [x] 4.2 Add `cancel_takeover` handler in `router.ts` — if old daemon sends cancellation (user manually stopped), accept new daemon immediately
- [x] 4.3 Implement grace period timer — after 300s automatically revoke old token and accept new daemon
- [x] 4.4 Add `handleForceKick` method — for Web-initiated force-kick, send kicked message with 0s grace period, revoke token
- [x] 4.5 Add `takeover_warning` handler in Go daemon to display the notification to user via stderr
- [x] 4.6 Update daemon registration to store `active_token_jti` on daemon row and bind `machine_id`

## 5. Relay Server — SMS Removal

- [x] 5.1 Remove `POST /api/auth/sms/send` and `POST /api/auth/sms/verify` endpoints from `server.ts`
- [x] 5.2 Delete `relay/src/config/sms.ts`
- [x] 5.3 Remove SMS-related imports and dev mode variables (`DEV_SMS_CODE`, `DEV_SMS_PHONE`) from `server.ts`
- [x] 5.4 Remove `createUserByPhone` and `getUserByPhone` from `db.ts` (phone column in users table kept for future use)
- [x] 5.5 Remove unused SMS-related environment variable references

## 6. Go CLI — OAuth Device Flow + PKCE

- [x] 6.1 Add PKCE utilities to `internal/api/client.go` — `generateCodeVerifier()` using `crypto/rand`, `computeCodeChallenge()` using `crypto/sha256`
- [x] 6.2 Add `DeviceAuthorize` function to `internal/api/client.go` — `POST /api/auth/device/authorize` with client_id, code_challenge, code_challenge_method, machine_id
- [x] 6.3 Add `DeviceToken` polling function to `internal/api/client.go` — `POST /api/auth/device/token` with grant_type, device_code, code_verifier
- [x] 6.4 Add `RevokeToken` function to `internal/api/client.go` — `POST /api/auth/revoke`
- [x] 6.5 Rewrite `cmdLogin` in `cmd/pocketctl/main.go` — add environment detection (`canOpenBrowser()`), OAuth Device Flow path with spinner, PKCE generation, browser open via `os/exec` (`open` on macOS, `xdg-open` on Linux)
- [x] 6.6 Add `--email` flag to `cmdLogin` to force email verification code flow
- [x] 6.7 Handle daemon switching flow in CLI — display takeover options [1] self-service [2] force-kick [3] cancel, with hostname and time info

## 7. Go CLI — Headless Fallback + Daemon Takeover

- [x] 7.1 Implement `canOpenBrowser()` detection in `cmd/pocketctl/main.go` — check DISPLAY, WAYLAND_DISPLAY, SSH_TTY, `open`/`xdg-open` availability
- [x] 7.2 Keep `loginViaEmail` function in `cmd/pocketctl/main.go` (retained from current code, SMS parts removed)
- [x] 7.3 Remove `loginViaPhone` function and SMS-related code from `cmd/pocketctl/main.go`
- [x] 7.4 Add daemon takeover notification display — when daemon receives `takeover_warning` WS message, format and print to stderr
- [x] 7.5 Add `kicked` message handler in daemon start flow — log reason, set timer for grace period, graceful shutdown after timer
- [x] 7.6 Remove SMS-related imports from `internal/api/client.go`

## 8. Web — Device Authorization Page

- [x] 8.1 Create `/login/cli` route in Vue Router (new `DeviceAuthView.vue`)
- [x] 8.2 Implement device authorization page UI — display "pocketctl CLI 正在请求访问权限" with user_code, matching the login page design system
- [x] 8.3 Implement login flow on device auth page — if user not authenticated, show email verification code login; if authenticated, show "授权此设备" button
- [x] 8.4 Implement authorization confirmation — call `POST /api/auth/device/confirm` on button click, handle success (checkmark) and error states
- [x] 8.5 Add expired/invalid user_code handling — display appropriate error messages
- [x] 8.6 Add theme support to device authorization page (matches login page theme toggle)

## 9. Web — Login Page Simplification (SMS Removal)

- [x] 9.1 Remove phone tab and SMS login form from login page
- [x] 9.2 Remove tab switching UI — email login form becomes the direct login card content
- [x] 9.3 Remove domain suffix selector — replace with full email input field
- [x] 9.4 Remove `sendSmsCode` and `loginViaPhone` from `web/src/composables/useAuth.ts`
- [x] 9.5 Update login page UI to match the simplified single-mode design

## 10. Web — Settings Force-Kick Integration

- [x] 10.1 Add "强制下线" button to each online daemon row in settings host management tab
- [x] 10.2 Implement force-kick confirmation dialog with email verification code input
- [x] 10.3 Implement send-code button in dialog — call `POST /api/auth/email/send`
- [x] 10.4 Implement confirm button — verify code via `POST /api/auth/email/verify`, then invoke `POST /api/auth/revoke`
- [x] 10.5 Add rate limit handling — disable "强制下线" button after 3 operations per hour with tooltip
- [x] 10.6 Add force-kick API functions to `web/src/composables/useAuth.ts` — `forceKickDaemon(daemonId, code)`

## 11. Web — UI Design System Cleanup

- [x] 11.1 Update `ui-design/pocketctl-design-system/web/login.html` — remove SMS tab, simplify to email-only layout
- [x] 11.2 Create `ui-design/pocketctl-design-system/web/device-auth.html` — CLI device authorization page design reference

## 12. Documentation & Scripts

- [x] 12.1 Update `README.md` authentication section — replace "phone SMS and email verification codes" with "OAuth 2.0 Device Authorization Grant (RFC 8628)"
- [x] 12.2 Update `README.zh-CN.md` with same changes
- [x] 12.3 Update `pocketctl help` output in `main.go` to reflect new login command options
- [x] 12.4 Update `scripts/install-daemon.sh` if it references SMS or auth setup
- [x] 12.5 Add `openspec/specs/oauth-device-flow/` directory with spec.md (archive the change specs)

## 13. Testing & Verification

- [ ] 13.1 Test OAuth Device Flow end-to-end — CLI → browser authorization → token poll → daemon start
- [ ] 13.2 Test headless email code login flow — `pocketctl login --email` on SSH session
- [ ] 13.3 Test soft eviction — daemon A online → login on daemon B → verify kicked message + grace period
- [ ] 13.4 Test Web force-kick — login to Web → settings → force-kick daemon → verify kicked + token revocation
- [ ] 13.5 Test token revocation — verify revoked token fails on WebSocket connect
- [ ] 13.6 Test refresh token rotation — verify old refresh token invalidated after rotation
- [ ] 13.7 Test all SMS endpoints return 404 after removal
- [ ] 13.8 Test IP-based access — verify Device Flow works with `ws://1.2.3.4:8080/ws` (no domain, no HTTPS)
- [ ] 13.9 Verify `relay-url-config` spec compliance — no hardcoded IPs in compiled binary

## Context

pocketctl currently uses SMS verification codes (Tencent Cloud SMS) as the primary authentication method for CLI login (`pocketctl login`), Web login, and (planned) iOS login. SMS was adopted because the project's domain has not yet passed ICP filing, which blocks the use of email verification services. This is a temporary workaround with real costs and a poor user experience.

The project is open-source (MIT, `github.com/pocketctl/pocketctl`) and aims to grow an ecosystem of self-deploying users and potentially third-party clients. The authentication system is the trust entry point for anyone evaluating the project.

### Current State

```
CLI (pocketctl login)          Web (Vue 3 SPA)           iOS (planned)
      │                              │                        │
      ├─ Phone SMS ───────────┐      ├─ Phone SMS ───┐       (not built)
      ├─ Email Code ──────┐   │      ├─ Email Code ──┤
      │                    │   │      │               │
      ▼                    ▼   ▼      ▼               ▼
┌──────────────────────────────────────────────────────────┐
│  Relay Server (Fastify + WebSocket)                       │
│                                                          │
│  /api/auth/sms/send      → Tencent Cloud SMS (¥0.045/条) │
│  /api/auth/sms/verify    → JWT sign                      │
│  /api/auth/email/send    → Tencent Cloud SES             │
│  /api/auth/email/verify  → JWT sign                      │
│  /api/auth/refresh       → JWT refresh                   │
│                                                          │
│  Token: JWT (24h access + 7d refresh)                    │
│  Storage: ~/.pocketctl/auth.json (CLI)                   │
│           localStorage (Web)                             │
└──────────────────────────────────────────────────────────┘
```

### Constraints

- **Domain not ICP-filed**: Cannot use HTTPS with a domain name yet. Must support IP-based access.
- **Open-source project**: Authentication design must be credible for security researchers and potential contributors.
- **Headless servers**: Many users deploy the daemon on headless VPS/SSH servers without a browser.
- **Desktop users**: macOS/Linux desktop users can use a browser for authorization.
- **Future iOS App Store submission**: Authentication must pass Apple's review standards.

## Goals / Non-Goals

**Goals:**

1. Replace SMS verification code login with OAuth 2.0 Device Authorization Grant (RFC 8628) as the primary CLI auth method
2. Retain email verification code as the fallback for headless servers
3. Remove all SMS-related code, endpoints, and dependencies
4. Implement one-account-one-daemon with soft eviction (grace period) and Web force-kick (with email re-verification)
5. Support IP-based access without requiring a domain or HTTPS
6. Lay the foundation for third-party client integration via standard OAuth
7. Maintain backward compatibility for token storage format (`auth.json`)

**Non-Goals:**

- Full OAuth 2.0 Authorization Server with dynamic client registration (not needed for first-party clients only)
- OAuth scopes with fine-grained permissions (all clients get full access for now; scopes can be added later)
- Social login providers (GitHub, Apple, etc.) — out of scope for this change
- TOTP/2FA — out of scope for this change but the architecture supports adding it later
- HTTPS enforcement — will come after ICP filing

## Decisions

### Decision 1: Minimal OAuth 2.0 Device Flow with Hardcoded Clients

**Choice**: Implement a minimal subset of OAuth 2.0 Device Authorization Grant (RFC 8628) with 3 hardcoded first-party `client_id` values.

**Alternatives considered**:
- *Full OAuth AS with dynamic client registration*: Too heavy for 3 first-party clients. Over-engineering at this stage.
- *Custom CLI PAT protocol*: Faster to build but no ecosystem benefits, hurts open-source credibility, requires migration later.
- *GitHub OAuth Device Flow (gh auth login model)*: Requires users to have GitHub accounts. Unnecessary dependency.

**Rationale**: We get the standardization benefits of OAuth without the operational complexity of a full authorization server. The 3 hardcoded clients are:

```typescript
const CLIENTS: Record<string, ClientConfig> = {
  'pocketctl-cli': {
    name: 'pocketctl CLI',
    grant_types: ['urn:ietf:params:oauth:grant-type:device_code'],
    scope: 'daemon:control session:read session:write',
    token_endpoint_auth_method: 'none', // public client
  },
  'pocketctl-web': {
    name: 'pocketctl Web',
    grant_types: ['authorization_code'],
    redirect_uris: [], // SPA, no redirect needed for first-party
    scope: 'daemon:control session:read session:write',
    token_endpoint_auth_method: 'none',
  },
  'pocketctl-ios': {
    name: 'pocketctl iOS',
    grant_types: ['authorization_code'],
    redirect_uris: ['pocketctl://oauth/callback'],
    scope: 'daemon:control session:read session:write',
    token_endpoint_auth_method: 'none',
  },
};
```

### Decision 2: Device Flow Endpoints

**Choice**: Implement exactly the endpoints required by RFC 8628 §3, plus a revocation endpoint.

```
POST /api/auth/device/authorize     RFC 8628 §3.1
POST /api/auth/device/token          RFC 8628 §3.4
POST /api/auth/revoke               RFC 7009 semantics
GET  /.well-known/oauth-authorization-server  RFC 8414
```

**Flow**:

```
CLI (Desktop)              Relay Server                Browser (User)
────────────               ────────────                ──────────────

① POST /api/auth/device/authorize
   { client_id, scope }
   ─────────────────────▶
                          生成 device_code (crypto/rand, 40 chars)
                          生成 user_code (8 chars, human-readable)
                          生成 verification_uri
                          存储 { device_code, user_code, client_id,
                                 code_challenge?, expires_at, status }
                          status = 'pending'
   ◀────────────────────
   { device_code, user_code,
     verification_uri,
     verification_uri_complete,
     expires_in: 600,
     interval: 5 }

② open(verification_uri_complete)
                          ③ ──────────────────────▶ GET /login/cli?code=ABCD-1234
                                                     User sees: "pocketctl CLI 请求访问"
                                                     用户登录（邮箱验证码）
                                                     确认授权
                          ④ ◀────────────────────── POST /api/auth/device/confirm
                                                     { user_code }
                                                     验证用户已登录 (JWT)
                                                     更新: status = 'authorized'

⑤ POST /api/auth/device/token (轮询, 每 interval 秒)
   { grant_type,
     device_code,
     client_id,
     code_verifier? }
   ─────────────────────▶
                          验证 device_code
                          检查 status == 'authorized'
                          签发 JWT (含 jti, machine_id)
                          存储 revoked_tokens 旧 token (如替换)
                          更新 daemons.active_token_jti
   ◀────────────────────
   { access_token, refresh_token,
     token_type: 'Bearer',
     expires_in: 86400 }

⑥ 保存 ~/.pocketctl/auth.json
   pocketctl daemon start
```

**Key design points**:

- `verification_uri` is the base URL of the relay (works with IP)
- `verification_uri_complete` includes the user_code as a query param for one-click flow
- Device code expires in 600 seconds (10 minutes)
- Polling interval is 5 seconds
- PKCE (S256) is enforced for `pocketctl-cli` — the CLI generates `code_verifier` and sends `code_challenge` in the authorize request

### Decision 3: PKCE for Public Clients

**Choice**: Require PKCE (Proof Key for Code Exchange) with S256 challenge method for all public clients.

**Rationale**: Since all our clients are public clients (no client secret), PKCE is the standard defense against authorization code interception. It's required by OAuth 2.1 and is simple to implement — just SHA256 hashing.

```
CLI generates:
  code_verifier = base64url(crypto/rand 32 bytes)     // 43 chars
  code_challenge = base64url(sha256(code_verifier))    // 43 chars

Authorize request includes:  code_challenge, code_challenge_method: 'S256'
Token request includes:      code_verifier
Server verifies:             sha256(code_verifier) === stored code_challenge
```

### Decision 4: Token Structure and Revocation

**Choice**: Extend JWT claims to include `jti` (JWT ID) and `machine_id`. Implement a `revoked_tokens` table for token invalidation.

**JWT Claims**:
```json
{
  "userId": 42,
  "email": "user@example.com",
  "type": "access",
  "jti": "random-128bit-base64url",
  "machine_id": "daemon-a1b2c3d4",
  "iat": 1680000000,
  "exp": 1680086400
}
```

**revoked_tokens table**:
```sql
CREATE TABLE revoked_tokens (
  jti         VARCHAR(64) PRIMARY KEY,
  user_id     INT NOT NULL REFERENCES users(id),
  revoked_at  TIMESTAMPTZ DEFAULT NOW(),
  reason      VARCHAR(32) NOT NULL  -- 'user_kick', 'new_login', 'logout', 'admin'
);
CREATE INDEX idx_revoked_tokens_user ON revoked_tokens(user_id);
```

**Token verification flow**:
```
verifyAccessToken(token):
  ① JWT signature verification
  ② Check exp claim (not expired)
  ③ Check jti NOT IN revoked_tokens
  ④ Return { userId, email, jti, machine_id }
```

**Token refresh**: Refresh token rotation — each refresh issues a new refresh token and revokes the old one. This limits the window of a stolen refresh token.

### Decision 5: Headless Server Fallback

**Choice**: CLI auto-detects environment and offers the appropriate login method.

**Detection logic** (Go):
```go
func canOpenBrowser() bool {
    // Check for display server (GUI indicator)
    if os.Getenv("DISPLAY") != "" || os.Getenv("WAYLAND_DISPLAY") != "" {
        return true
    }
    // macOS always has a GUI (check for SSH session)
    if runtime.GOOS == "darwin" && os.Getenv("SSH_TTY") == "" {
        return true
    }
    // Check if open/xdg-open command exists
    if _, err := exec.LookPath("open"); err == nil {
        return true
    }
    if _, err := exec.LookPath("xdg-open"); err == nil {
        return true
    }
    return false
}
```

**CLI login flow**:
```
pocketctl login
  ├─ canOpenBrowser() == true
  │   └─ "使用浏览器授权登录"
  │       ① POST /api/auth/device/authorize
  │       ② open(verification_uri_complete)
  │       ③ 轮询 /api/auth/device/token
  │       ④ 保存 token
  │
  └─ canOpenBrowser() == false
      └─ "使用邮箱验证码登录 (headless 模式)"
          ① 输入邮箱
          ② POST /api/auth/email/send
          ③ 输入验证码
          ④ POST /api/auth/email/verify
          ⑤ 保存 token
```

### Decision 6: Daemon Switching — Soft Eviction + Web Force-Kick

**Choice**: Three-tier daemon switching model.

```
Tier 1: Self-service (软驱逐)
──────────────────────────────
用户在机器B执行 pocketctl login:
  → 检测到已有 daemon 在线 (旧机器A)
  → CLI 显示:
    "⚠️ 检测到已在线设备: office-mac (上线于 2026-06-13 09:23)"
    ""
    "请选择:"
    "  [1] 我知道了，先去旧机器停止 (推荐)"
    "  [2] 我无法操作旧机器，申请强制切换"
  → 用户选 [1]:
    • 旧 daemon 收到 takeover_request 通知
    • 5 分钟冷却期，旧 daemon 可正常完成当前任务
    • 5 分钟后旧 token 自动 revoke
    • 新机器可完成登录

Tier 2: Web force-kick (需邮箱验证)
────────────────────────────────────
用户选 [2] 或在 Web 端操作:
  → CLI 提示打开 Web 设置
  → Web: 设置 → 主机管理 → 点击 [强制下线]
  → 弹窗要求输入邮箱验证码 (二次验证)
  → 验证通过 → revoke 旧 token
  → 旧 daemon: 收到 kicked 消息 → 优雅关闭
  → 新机器: 可继续登录流程

Tier 3: Grace period auto-resolve
──────────────────────────────────
如果用户在机器B登录后没有选择 [1] 或 [2]:
  → 旧 daemon 继续运行
  → 10 分钟后 device_code 过期
  → 用户需要重新执行 pocketctl login
```

**WebSocket kicked message**:
```json
{
  "type": "kicked",
  "reason": "new_login",
  "message": "账号已在 host-B 上登录，当前连接将在 5 分钟后断开。如需立即断开，请在 Web 端强制下线。",
  "grace_period_seconds": 300,
  "new_hostname": "host-B"
}
```

**Security measures**:
- Web force-kick requires email re-verification (even if already logged into Web)
- Force-kick rate limit: 3 per user per hour
- All kick actions logged to `audit_log`
- Old daemon receives `kicked` message before token revocation, allowing graceful cleanup

### Decision 7: Database Schema Changes

```sql
-- Token revocation
CREATE TABLE revoked_tokens (
  jti         VARCHAR(64) PRIMARY KEY,
  user_id     INT NOT NULL REFERENCES users(id),
  revoked_at  TIMESTAMPTZ DEFAULT NOW(),
  reason      VARCHAR(32) NOT NULL
);
CREATE INDEX idx_revoked_tokens_user ON revoked_tokens(user_id);

-- Audit logging
CREATE TABLE audit_log (
  id          BIGSERIAL PRIMARY KEY,
  user_id     INT REFERENCES users(id),
  action      VARCHAR(32) NOT NULL,
  details     JSONB DEFAULT '{}',
  ip          VARCHAR(45),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_audit_log_user ON audit_log(user_id);
CREATE INDEX idx_audit_log_action ON audit_log(action);

-- Daemon enhancements
ALTER TABLE daemons ADD COLUMN IF NOT EXISTS active_token_jti VARCHAR(64);
ALTER TABLE daemons ADD COLUMN IF NOT EXISTS machine_id VARCHAR(64);
ALTER TABLE daemons ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;

-- User enhancements
ALTER TABLE users ADD COLUMN IF NOT EXISTS max_daemons INT DEFAULT 1;

-- Remove SMS-specific columns from users
-- (phone column kept for future use, but sms auth endpoints removed)
```

### Decision 8: Client Registration Method

**Choice**: Hardcoded constant object in the relay server code. No database table, no registration API, no management UI.

**Rationale**:
- All 3 clients are first-party (we build them)
- No third-party developers need to register clients yet
- Adding a `oauth_clients` table later is trivial and non-breaking
- This keeps the implementation minimal while preserving the standard OAuth protocol shape

**Future path**: When third-party client support is needed, add `oauth_clients` table and a management API. The hardcoded clients become seed data. The `/authorize` and `/token` endpoints already validate `client_id` against a lookup — changing the lookup from a constant to a database query requires no protocol changes.

### Decision 9: PKCE Implementation Details

**Choice**: Go standard library `crypto/sha256` + `crypto/rand` for CLI; Web Crypto API (`SubtleCrypto`) for browser.

**Go code sketch**:
```go
func generateCodeVerifier() (string, error) {
    b := make([]byte, 32)
    if _, err := rand.Read(b); err != nil {
        return "", err
    }
    return base64.RawURLEncoding.EncodeToString(b), nil
}

func computeCodeChallenge(verifier string) string {
    h := sha256.Sum256([]byte(verifier))
    return base64.RawURLEncoding.EncodeToString(h[:])
}
```

## Risks / Trade-offs

### Risk 1: Browser open fails silently
[Risk]: `open` or `xdg-open` command exists but fails to launch a browser (e.g., in a minimal window manager).

→ **Mitigation**: CLI prints the full URL prominently. User can manually copy-paste it into a browser. The URL is short enough for manual entry (includes user_code as query param).

### Risk 2: Polling race condition
[Risk]: User authorizes in browser, but the next poll interval hasn't elapsed yet — user waits up to 5 seconds.

→ **Mitigation**: Accepted trade-off. 5-second polling is the standard in RFC 8628 (Google uses 5s). The CLI shows a spinner with elapsed time so the user knows it's working.

### Risk 3: IP-based access without HTTPS
[Risk]: Token transmission over plain HTTP during polling and WebSocket connection. Man-in-the-middle could intercept tokens on compromised networks.

→ **Mitigation**: This is an accepted risk for the pre-ICP-filing phase. After ICP filing, HTTPS will be enforced. The short-lived access token (24h) limits the blast radius. Refresh token rotation further limits exposure.

### Risk 4: Revoked tokens table grows unbounded
[Risk]: The `revoked_tokens` table grows indefinitely as users log in and out.

→ **Mitigation**: Access tokens expire in 24h — entries older than 24h + 1h can be safely deleted (the token would be expired anyway). A periodic cleanup job (every 6 hours) purges stale entries. Refresh token entries are kept for 7 days. Total rows per user ≈ number of login/logout cycles in 7 days, which is negligible.

### Risk 5: Soft eviction grace period abuse
[Risk]: An attacker who gained access to the user's account could use the 5-minute grace period to keep the old daemon running while also running their own malicious daemon.

→ **Mitigation**: This is why Tier 2 (Web force-kick) requires email re-verification — a higher bar than initial login. The grace period is a UX convenience for the legitimate user, not a security gap for the attacker. An attacker who already has account access could cause damage regardless.

## Open Questions

1. **Should `machine_id` be sent during the authorize request or the token request?**
   Current thinking: Send during authorize request, stored with the device_code in memory. This binds the authorization session to the machine early. Alternative: Send during token request only, keeping the authorize step simpler.

2. **Should headless login (email code) also issue a refresh token?**
   Current thinking: Yes, same token structure regardless of login method. The email code flow returns the same `{ access_token, refresh_token }` response.

3. **Should we add a "remember this device" option for headless servers?**
   Headless servers can't re-authorize via browser, so they rely on refresh tokens. The 7-day refresh token means the user needs to re-login weekly on headless servers. A longer-lived refresh token (30 days?) or a "device token" could help. Out of scope for this change but worth tracking.

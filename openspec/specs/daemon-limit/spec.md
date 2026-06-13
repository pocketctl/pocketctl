## ADDED Requirements

### Requirement: Free user daemon limit
The relay SHALL limit free users to 1 online daemon. When a free user attempts to register a second daemon while one is already online, the relay SHALL reject the registration with a `DAEMON_LIMIT_REACHED` error.

#### Scenario: Free user registers first daemon
- **WHEN** a free user (plan = 'free') sends a `register` message and has 0 online daemons
- **THEN** the relay accepts the registration
- **AND** stores the daemon in the in-memory Map and database

#### Scenario: Free user registers second daemon
- **WHEN** a free user sends a `register` message and already has 1 online daemon (Mac1)
- **THEN** the relay rejects the registration
- **AND** sends an error event: `{ type: "error", error: "免费版仅支持1台主机。当前在线: Mac1。请先在 Mac1 上运行 pocketctl daemon stop", code: "DAEMON_LIMIT_REACHED", limit: 1, plan: "free", current_host: "Mac1" }`
- **AND** closes the WebSocket connection

#### Scenario: Same daemon reconnects
- **WHEN** a free user's daemon disconnects and reconnects with the same `daemon_id`
- **THEN** the relay accepts the reconnection (upsert, not new registration)
- **AND** does not count against the limit

#### Scenario: Pro user has no limit
- **WHEN** a pro user (plan = 'pro') registers multiple daemons
- **THEN** the relay accepts all registrations without limit

### Requirement: User plan storage
The `users` table SHALL have a `plan` column with default value `'free'` and a `whitelist` boolean column defaulting to `false`. The relay SHALL query these columns to determine the user's daemon limit.

#### Scenario: Default plan is free
- **WHEN** a new user registers via SMS or email
- **THEN** their plan is set to `'free'` and whitelist is `false` by default

#### Scenario: Plan query returns user plan
- **WHEN** the relay calls `getUserPlan(pool, userId)`
- **THEN** it returns the user's plan string (e.g., 'free' or 'pro') and whitelist boolean

### Requirement: Whitelist bypasses daemon limit
Users with `whitelist = true` SHALL bypass all plan-based daemon limits. Whitelist users can register unlimited daemons regardless of their plan.

#### Scenario: Whitelist user registers multiple daemons
- **WHEN** a whitelist user (whitelist = true, plan = 'free') registers multiple daemons
- **THEN** the relay accepts all registrations without limit
- **AND** no `DAEMON_LIMIT_REACHED` error is sent

#### Scenario: Non-whitelist free user is still limited
- **WHEN** a non-whitelist free user (whitelist = false, plan = 'free') registers a second daemon
- **THEN** the relay rejects the registration with `DAEMON_LIMIT_REACHED` error

### Requirement: Daemon error handling on limit reached
The Go daemon SHALL handle `DAEMON_LIMIT_REACHED` error by printing a friendly message to stderr and exiting with code 1.

#### Scenario: Daemon receives limit error
- **WHEN** the Go daemon receives an error event with `code: "DAEMON_LIMIT_REACHED"`
- **THEN** it prints the error message to stderr
- **AND** exits with code 1
- **AND** does NOT attempt to reconnect
## REMOVED Requirements

### Requirement: Free user daemon limit
**Reason**: Replaced by soft-eviction model (see ADDED).
**Migration**: The old hard-reject behavior (immediate `DAEMON_LIMIT_REACHED` error on second daemon registration) is replaced by the soft-eviction flow. Relay still enforces a per-user daemon limit, but the enforcement model uses takeover notification with grace period instead of hard rejection. Free users are still limited to 1 daemon.

## MODIFIED Requirements

### Requirement: Daemon error handling on limit reached
The Go daemon SHALL handle daemon limit scenarios by presenting the user with a choice between self-service (grace period) and force-kick via Web.

#### Scenario: Daemon receives takeover notification
- **WHEN** the Go daemon receives a kicked event with `reason: "new_login"` and `grace_period_seconds: 300`
- **THEN** it logs the event with the new hostname
- **AND** it sets a timer for the grace period
- **AND** it continues normal operation during the grace period
- **AND** after the grace period expires, it performs graceful shutdown and exits

#### Scenario: Daemon receives force kick
- **WHEN** the Go daemon receives a kicked event with `reason: "force_kick"` and `grace_period_seconds: 0`
- **THEN** it prints the kick reason to stderr
- **AND** it performs immediate graceful shutdown
- **AND** exits with code 0

## ADDED Requirements

### Requirement: Soft eviction daemon limit
The relay SHALL limit free users to 1 online daemon using soft eviction. When a user initiates login from a new machine, the relay SHALL send a takeover notification to the existing daemon with a 5-minute grace period rather than immediately rejecting the new registration.

#### Scenario: First daemon always accepted
- **WHEN** any authenticated user registers their first daemon (no existing online daemon for that user)
- **THEN** the relay accepts the registration immediately

#### Scenario: Second daemon on free plan triggers takeover
- **WHEN** a free user (plan = 'free', whitelist = false) registers a new daemon (different `daemon_id`) while one is already online
- **THEN** the relay sends a `kicked` message to the old daemon with `reason: "new_login"`, `grace_period_seconds: 300`, and the new hostname
- **AND** the relay sends a `takeover_warning` message to the new daemon with the old daemon's hostname and the grace period info
- **AND** after the 5-minute grace period, the relay revokes the old daemon's token and accepts the new daemon's registration

#### Scenario: User cancels takeover
- **WHEN** a takeover is in progress (grace period active)
- **AND** the old daemon sends a `cancel_takeover` message (user ran `pocketctl daemon stop` manually)
- **THEN** the relay accepts the new daemon immediately without waiting for the grace period

#### Scenario: Same daemon reconnects
- **WHEN** a user's daemon disconnects and reconnects with the same `daemon_id`
- **THEN** the relay accepts the reconnection (upsert, not new registration)
- **AND** does not trigger any takeover flow

#### Scenario: Pro or whitelist user has no limit
- **WHEN** a pro user (plan = 'pro') or whitelist user registers multiple daemons
- **THEN** the relay accepts all registrations without triggering takeover

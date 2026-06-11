## ADDED Requirements

### Requirement: Doctor command performs sequential health checks
The `pocketctl doctor` command SHALL perform 8 sequential health checks and report the status of each. Each check SHALL be independent — a failure in one check SHALL NOT prevent subsequent checks from running. Each check SHALL have a 5-second timeout.

#### Scenario: All checks pass
- **WHEN** the user runs `pocketctl doctor` with valid config, network, and auth
- **THEN** all 8 checks show ✅ and the command exits with code 0

#### Scenario: Config file missing
- **WHEN** `~/.pocketctl/auth.json` does not exist
- **THEN** check 1 shows ❌ with message "未登录，请运行 pocketctl login"
- **AND** subsequent checks are still attempted

#### Scenario: Token expired
- **WHEN** the JWT token in auth.json has passed its `exp` claim
- **THEN** check 2 shows ❌ with message "Token 已过期，请重新登录"
- **AND** the command continues with remaining checks

### Requirement: Doctor checks DNS resolution
The command SHALL resolve the relay hostname using the system DNS resolver.

#### Scenario: DNS resolves successfully
- **WHEN** the relay URL hostname resolves to one or more IP addresses
- **THEN** check 3 shows ✅ with the resolved IP address

#### Scenario: DNS resolution fails
- **WHEN** the relay URL hostname cannot be resolved
- **THEN** check 3 shows ❌ with message "无法解析域名: {hostname}"

### Requirement: Doctor checks HTTP health endpoint
The command SHALL send a GET request to the relay's `/health` endpoint and verify the response.

#### Scenario: Health endpoint returns ok
- **WHEN** `GET /health` returns HTTP 200 with `{ "status": "ok" }`
- **THEN** check 4 shows ✅ with response time in milliseconds

#### Scenario: Health endpoint unreachable
- **WHEN** the HTTP request fails (timeout, connection refused, etc.)
- **THEN** check 4 shows ❌ with the error message

### Requirement: Doctor checks WebSocket connectivity
The command SHALL attempt to establish a WebSocket connection to the relay and send a register message.

#### Scenario: WebSocket connects and receives ack
- **WHEN** the WebSocket connection succeeds and a `register_ack` is received
- **THEN** check 5 shows ✅
- **AND** the connection is immediately closed

#### Scenario: WebSocket connection refused
- **WHEN** the WebSocket connection is refused or times out
- **THEN** check 5 shows ❌ with the error message

### Requirement: Doctor checks daemon limit
The command SHALL check if the user's daemon limit would prevent a new connection.

#### Scenario: Daemon limit reached
- **WHEN** the relay responds with `DAEMON_LIMIT_REACHED` error
- **THEN** check 6 shows ❌ with the error message from the relay
- **AND** the current online daemon hostname is displayed

#### Scenario: Daemon limit not reached
- **WHEN** the relay accepts the registration (register_ack received)
- **THEN** check 6 shows ✅

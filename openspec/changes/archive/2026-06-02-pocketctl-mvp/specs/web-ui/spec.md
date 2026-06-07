## ADDED Requirements

### Requirement: Session list view
The web UI SHALL display a list of all agent sessions with their status (running, completed, error, killed), agent type, and last activity time.

#### Scenario: Active sessions displayed
- **WHEN** user opens the web UI
- **THEN** the session list shows all sessions with status, agent type, cwd, and relative time of last activity
- **AND** running sessions show a live indicator

#### Scenario: Session list updates in real-time
- **WHEN** a new session is created on the daemon
- **THEN** the session list updates automatically without page refresh

### Requirement: Session detail view with streaming output
The web UI SHALL display a chat-like interface for each session showing real-time streaming output from the agent. Messages SHALL appear as they are received over WebSocket.

#### Scenario: Streaming text appears incrementally
- **WHEN** agent sends `agent_text` events with `streaming: true`
- **THEN** the UI appends text to the current message bubble in real-time
- **AND** shows a typing/cursor indicator while streaming

#### Scenario: Tool calls displayed distinctly
- **WHEN** agent sends `tool_call` event for `Read` or `Bash`
- **THEN** UI renders a collapsible card showing tool name, input parameters, and output
- **AND** tool cards are visually distinct from text messages

### Requirement: Message input for follow-up
The web UI SHALL provide a text input at the bottom of the session detail view for sending follow-up messages to the agent.

#### Scenario: Send follow-up message
- **WHEN** user types a message and presses Enter
- **THEN** UI sends `user_message` over WebSocket
- **AND** displays the user's message in the chat
- **AND** shows a loading state until the agent begins responding

### Requirement: New session creation
The web UI SHALL provide a "New Session" button that opens a form to select the agent type, working directory, and initial prompt.

#### Scenario: Create new session
- **WHEN** user fills in agent type "claude-code", cwd "/path/to/project", prompt "fix the auth bug" and submits
- **THEN** UI sends `session_create` over WebSocket
- **AND** navigates to the new session's detail view
- **AND** streaming output begins appearing

### Requirement: WebSocket reconnection
The web UI SHALL automatically reconnect to the relay when the WebSocket connection drops. The UI SHALL show a connection status indicator (connected/disconnected).

#### Scenario: Connection lost
- **WHEN** WebSocket connection drops
- **THEN** UI shows a "Reconnecting..." banner
- **AND** existing session output remains visible (read-only)
- **AND** UI automatically reconnects and resumes streaming when connection is restored

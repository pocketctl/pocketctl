## ADDED Requirements

### Requirement: Frontend reports locale to relay
The Web client SHALL send a `set_locale` message to relay upon WebSocket connection, and re-send it whenever the user switches locale in the UI.

#### Scenario: Locale reported on connect
- **WHEN** the Web client establishes a WebSocket connection and locale is "zh"
- **THEN** the client sends `{ type: "set_locale", locale: "zh" }` to the relay

#### Scenario: Locale re-reported on switch
- **WHEN** user switches locale from "zh" to "en" in the UI
- **THEN** the client sends `{ type: "set_locale", locale: "en" }` to the relay

### Requirement: Relay stores user locale
The relay SHALL store the locale value in the ClientConnection structure for each authenticated user. The default locale SHALL be "zh" when no `set_locale` message has been received.

#### Scenario: Locale stored on receipt
- **WHEN** relay receives `{ type: "set_locale", locale: "en" }` from a client
- **THEN** the client's `locale` field is updated to "en"

#### Scenario: Default locale
- **WHEN** a client has not sent `set_locale`
- **THEN** the client's locale defaults to "zh"

### Requirement: Title generation uses session owner locale
When relay processes a `generate_title_request`, it SHALL resolve the session owner's locale and pass it to the title generation service. If the owner locale cannot be determined, the service SHALL fall back to current behavior (language detection from user message).

#### Scenario: English locale generates English title
- **WHEN** relay receives `generate_title_request` for a session whose owner has locale "en"
- **AND** the user message is "帮我重构认证模块"
- **THEN** the title generation prompt instructs GLM to output in English
- **AND** the generated title is in English (e.g., "Refactor auth module")

#### Scenario: Chinese locale preserves Chinese title
- **WHEN** relay receives `generate_title_request` for a session whose owner has locale "zh"
- **AND** the user message is in Chinese
- **THEN** the generated title is in Chinese (current behavior preserved)

#### Scenario: Owner locale unknown — fallback
- **WHEN** relay receives `generate_title_request` but cannot determine the session owner's locale
- **THEN** the title generation falls back to language detection from the user message

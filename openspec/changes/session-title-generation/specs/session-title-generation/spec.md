## ADDED Requirements

### Requirement: GLM-4.6 title generation service
The Relay Server SHALL provide a title generation service that calls the 智谱 GLM-4.6 API to generate concise session titles. The service SHALL accept a user message and an assistant message, and return a title of no more than 15 characters.

#### Scenario: Successful title generation
- **WHEN** the title generation service receives a user message "帮我写一个React组件，需要支持暗色模式" and an assistant message "好的，我来帮你创建一个支持暗色模式的React组件..."
- **THEN** the service calls GLM-4.6 with a system prompt instructing it to generate a concise title
- **AND** the service returns a title like "React暗色模式组件"
- **AND** the title is no more than 15 characters

#### Scenario: Chinese user message generates Chinese title
- **WHEN** the user message is in Chinese
- **THEN** the generated title SHALL be in Chinese

#### Scenario: English user message generates English title
- **WHEN** the user message is in English
- **THEN** the generated title SHALL be in English

### Requirement: GLM API call configuration
The title generation service SHALL call GLM-4.6 with the following parameters: `model: "glm-4.6"`, `max_tokens: 32`, `temperature: 0.3`, `stream: false`. The API endpoint SHALL be `https://open.bigmodel.cn/api/paas/v4/chat/completions`. The API key SHALL be read from the `ZHIPU_API_KEY` environment variable.

#### Scenario: API call with correct parameters
- **WHEN** the title generation service makes an API call
- **THEN** the request uses model `glm-4.6`, max_tokens 32, temperature 0.3, and non-streaming mode
- **AND** the Authorization header contains `Bearer {ZHIPU_API_KEY}`

#### Scenario: API key not configured
- **WHEN** the `ZHIPU_API_KEY` environment variable is not set or is empty
- **THEN** the title generation service SHALL skip the API call
- **AND** the session title remains as the default "Terminal Session-{suffix}"

### Requirement: Title generation timeout and fallback
The title generation service SHALL enforce a 3-second timeout on GLM API calls. If the call fails (timeout, network error, API error, or returns empty/invalid content), the service SHALL fallback to truncating the user message to the first 15 characters.

#### Scenario: GLM API timeout
- **WHEN** the GLM API call does not respond within 3 seconds
- **THEN** the service cancels the request
- **AND** returns the first 15 characters of the user message as the title

#### Scenario: GLM API returns error
- **WHEN** the GLM API returns a non-200 status or error response
- **THEN** the service returns the first 15 characters of the user message as the title

#### Scenario: GLM API returns empty content
- **WHEN** the GLM API returns a 200 response but the content is empty or whitespace-only
- **THEN** the service returns the first 15 characters of the user message as the title

### Requirement: One-time title update guarantee
The system SHALL guarantee that a session's title is updated from the default value to the generated value exactly once. After the title has been set to a generated value, it SHALL never be overwritten.

#### Scenario: Title updated once from default
- **WHEN** the title generation service produces a title for session "abc123"
- **AND** the session's current title in the database is "Terminal Session-abc12345"
- **THEN** the database title is updated to the generated title
- **AND** subsequent title generation requests for this session are ignored

#### Scenario: Title already generated — no overwrite
- **WHEN** a `generate_title_request` event arrives for a session whose title is already "React暗色模式组件" (not matching "Terminal Session-%")
- **THEN** the relay SHALL skip the GLM API call entirely
- **AND** the database title is NOT modified

### Requirement: Title update broadcast
After a title is successfully generated and stored, the relay SHALL broadcast a `session_title_update` event to all subscribed clients with the new title.

#### Scenario: Title update broadcast to iOS clients
- **WHEN** the relay generates and stores a new title for session "abc123"
- **THEN** the relay broadcasts `session_title_update` with `session_id: "abc123"` and `title: "React暗色模式组件"` to all clients subscribed to this session

### Requirement: GLM prompt engineering
The title generation prompt SHALL instruct GLM-4.6 to: generate a concise session title of no more than 15 characters, capture the core task or intent, not use quotes or ending punctuation, respond in the same language as the user message, and return only the title text without explanation.

#### Scenario: Prompt contains both messages
- **WHEN** the title generation service constructs the API call
- **THEN** the prompt includes both the user message and the assistant message
- **AND** the system prompt specifies the formatting constraints (≤15 chars, no quotes, same language)

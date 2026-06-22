## MODIFIED Requirements

### Requirement: GLM prompt engineering
The title generation prompt SHALL instruct GLM-4.6 to: generate a concise session title of no more than 15 characters, capture the core task or intent, not use quotes or ending punctuation, prefer the user's UI language (provided via locale parameter) when it differs from the user message language, and return only the title text without explanation.

#### Scenario: Prompt contains both messages
- **WHEN** the title generation service constructs the API call
- **THEN** the prompt includes both the user message and the assistant message
- **AND** the system prompt specifies the formatting constraints (≤15 chars, no quotes)
- **AND** the system prompt includes locale preference when available

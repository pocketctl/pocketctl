## 1. Relay: title.ts — locale parameter + prompt update

- [x] 1.1 Add optional `locale` parameter to `generateTitle(userMessage, assistantMessage, locale?)` signature
- [x] 1.2 Update SYSTEM_PROMPT: when locale is provided, instruct GLM to prefer that language
- [x] 1.3 Build prompt dynamically: include locale constraint only when locale param is present

## 2. Relay: router.ts — locale storage + title generation linkage

- [x] 2.1 Add `locale: string` field to `ClientConnection` interface, default to "zh"
- [x] 2.2 Handle `set_locale` message type — update client.locale
- [x] 2.3 In `generate_title_request` handler: query session owner userId, find owner locale, pass to `generateTitle()`
- [x] 2.4 If owner locale not found, call `generateTitle()` without locale (fallback to current behavior)

## 3. Frontend: locale reporting

- [x] 3.1 In `useWebSocket.ts`: after connection, send `{ type: "set_locale", locale }` using current locale
- [x] 3.2 Watch locale changes and re-send `set_locale` when user switches language

## 4. Build & Verify

- [x] 4.1 Build relay and rebuild Docker relay container
- [x] 4.2 Build web and rebuild Docker web container
- [ ] 4.3 Verify: new session with English UI → GLM generates English title
- [ ] 4.4 Verify: new session with Chinese UI → GLM generates Chinese title (no regression)

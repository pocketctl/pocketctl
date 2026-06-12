## 1. Fix tool-card CSS

- [x] 1.1 Remove `overflow: hidden` from `.tool-card` in `web/src/views/SessionDetail.vue`
- [x] 1.2 Verify no duplicate/conflicting CSS rules remain for `.tool-card` and `.tool-body`

## 2. Verify

- [x] 2.1 Rebuild web container (`docker compose up -d --build web`)
- [ ] 2.2 Open session detail page, verify tool-card body content (input/output) is visible
- [ ] 2.3 Verify card border-radius still renders correctly
- [ ] 2.4 Test in both dark and light themes

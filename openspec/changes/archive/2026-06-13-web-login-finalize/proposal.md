## Why

The Web login page was redesigned during the `oauth-device-flow` change but left with a few unfinished details: the footer still referenced account registration and the Help Center link was a dead link.

## What Changes

- Remove phone SMS login tab from Web login page (completed in `oauth-device-flow`, finalized here)
- Replace email local-part + `@gmail.com` suffix with full email address input
- Simplify login page footer — remove "还没有账户？注册" reference, keep "登录即自动注册"
- Wire up Help Center link to `HelpModal` component (install daemon guide + feedback email)

## Capabilities

### Modified Capabilities

- `web-login-redesign`: Footer simplified, HelpModal integration added. SMS tab permanently removed.

## Impact

- **Web (`web/src/views/LoginView.vue`)**: Import HelpModal, add showHelp ref, replace footer HTML
- **Web (`web/src/components/HelpModal.vue`)**: Already exists, no changes needed

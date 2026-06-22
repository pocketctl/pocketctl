## Why

HostsView 页面存在大量硬编码中文文本（20+ 处），未使用 `t()` 国际化函数，导致切换到英文时页面显示中文，用户体验不一致。部分 i18n key 已在 `zh.json`/`en.json` 中定义但未使用，补齐成本低。

## What Changes

- 将 HostsView.vue template 和 script 中的硬编码中文替换为 `t()` 翻译调用
- 在 `zh.json` 和 `en.json` 中新增约 20 个翻译 key，覆盖状态标签、Toast 消息、确认对话框、Token 消耗区、Agent 版本提示
- 复用已定义但未使用的 3 个现有 key（`settings.version_pending`、`common.cancel`、`dashboard.token_usage`）

## Capabilities

### New Capabilities
- `hosts-i18n`: HostsView 页面的完整国际化覆盖——状态标签、确认对话框、Toast 消息、Token 消耗统计、Agent 版本提示

### Modified Capabilities
- `web-ui`: HostsView 组件内的文本全面改用 i18n key，英文切换后页面全部显示英文

## Impact

- `web/src/views/HostsView.vue` — 替换硬编码中文为 `t()` 调用（template + script 约 30 行改动）
- `web/src/i18n/zh.json` — 新增 ~20 个 hosts.* 和 dashboard.* key
- `web/src/i18n/en.json` — 对应的英文翻译

## Why

会话详情页的 tool-card 组件无法正常展示工具调用的输入和输出内容。根因是 `.tool-card` 设置了 `overflow: hidden`，在移除 tool-body 的 `display: none` 切换逻辑后，body 内容被 `overflow: hidden` 裁剪，用户只能看到 header 区域和一条横线（border-top），无法看到实际的命令内容和执行结果。

## What Changes

- **修复 tool-card CSS**: 移除 `overflow: hidden`，改为 `overflow: visible`，使 tool-body 内容完整可见
- **保持圆角边界**: 使用内嵌 border-radius 或改为 header/footer 独立圆角，确保 card 视觉完整性
- **移除残留旧 CSS 规则**: 清理重复的 `.tool-body .tool-output` 规则

## Capabilities

### New Capabilities

### Modified Capabilities

## Impact

- `web/src/views/SessionDetail.vue`: CSS 样式修改（约 3 行）

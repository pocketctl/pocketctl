## Context

会话详情页的 tool-card 组件用于展示 AI agent 的工具调用记录（Bash 命令、文件读写等）。当前 CSS 中 `.tool-card` 设置了 `overflow: hidden`，配合之前的 `display: none` 切换逻辑（点击展开/收起 tool-body）时工作正常。但在对齐 APP 设计稿、移除 `display: none` 后，tool-body 内容始终可见但被 `overflow: hidden` 裁剪，用户只能看到 header 区域。

## Goals / Non-Goals

**Goals:**
- 使 tool-body 的输入和输出内容完整可见
- 保持 card 视觉完整性（圆角边界不被破坏）

**Non-Goals:**
- 不改变 tool-card 的 HTML 结构
- 不改变 tool-card 的交互逻辑

## Decisions

**Decision 1: 移除 `overflow: hidden`**

将 `.tool-card` 的 `overflow: hidden` 删除。当前 card 没有需要裁剪的子元素（tool-body 内容是可见的），唯一用到 `overflow: hidden` 的地方是配合圆角裁剪边界，但 tool-body 没有需要溢出 card 边界的内容。

替代方案：
- **保持 `overflow: hidden`，在 `.expanded` 时改为 `visible`** — 复杂且无明显收益
- **迁移到 header/footer 独立圆角** — 过度工程，设计稿中也使用统一的 card 圆角

## Risks / Trade-offs

- 移除 `overflow: hidden` 后，如果未来添加动画可能需要重新引入 → 届时可视需要添加

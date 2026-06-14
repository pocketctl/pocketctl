## Why

hosts-page 的 HostsView.vue 实现与设计稿 `hosts.html` 存在 57 处细节差异——主要集中在三方面：actions 浮窗菜单位置错误（列在详情面板底部而非列表项浮窗）、字体大小体系偏差（15 处字号/字重值与设计稿不一致）、图标不规范（emoji 替换设计稿的 SVG 路径）。需要逐像素对齐设计稿，零新接口、零新组件、零 DB 改动。

## What Changes

- **结构修正**：每个 .host-item 加 `.ss-more-btn`（三圆点 SVG）→ 全局 `.ss-menu` 浮窗（7 项操作）。从详情面板移除 `.more-actions` 区域
- **字体大小体系对齐**：.page-title 24px、.hi-sessions 14px/600、.hd-sub 13px 等 15 处精确修正
- **图标替换**：emoji → 设计稿 SVG 路径（I_COPY/I_EXPORT/I_EDIT/I_RESTART/I_POWER/I_TRASH，14×14 viewBox）
- **图标容器修正**：.hi-icon 32→36px + 背景、NAS 类型图标补充、三圆点 ⋯ 按钮
- **间距和颜色修正**：host-item padding/gap、hd-section 样式、搜索框 relative+absolute 图标定位
- **CSS 细节**：过渡动画曲线 cubic-bezier(0.2,0,0,1)、status-pill/.pulse 类声明、响应式 520px 断点

## Capabilities

### Modified Capabilities

- `hosts-page`: 逐像素对齐设计稿——字体体系 / 图标 / 浮窗菜单 / 间距 / 颜色 / 动画

## Impact

- **Web (`web/src/views/HostsView.vue`)**: 唯唯一改动文件——template 结构（加 ⋯ 按钮+浮窗、移除 .more-actions、修正图标 SVG）、CSS 全部重写（15 处字体+间距+颜色精确对齐）、script 加浮窗逻辑（openMenu/closeMenu/onMenuClick）

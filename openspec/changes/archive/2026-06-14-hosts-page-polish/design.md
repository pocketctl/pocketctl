## Context

hosts.html 设计稿的 HTML 结构采用数据驱动渲染（JS renderList/renderDetail），当前 HostsView.vue 用 Vue 响应式模板。两者 DOM 层次不同，但 CSS 视觉效果必须一致。核心差异在 actions 菜单位置、字体大小体系、SVG 图标。

## Decisions

### Decision 1: 列表项 ⋯ 浮窗用 Vue 条件渲染（非 body append）

设计稿用 `document.body.appendChild(menuEl)` 创建全局浮窗。Vue 版用 `v-if="menuOpen"` 在 HostsView 组件内渲染浮窗（position:fixed），通过 `getBoundingClientRect()` 计算定位。行为一致，代码更清晰。

### Decision 2: 菜单项图标用内联 SVG（非 icon font）

设计稿 7 个菜单项各用不同的 SVG path。直接用 `<svg>` 内联（和 SessionActions.vue 模式一致），不引入 icon font。

### Decision 3: CSS 变量体系对齐 web-shared.css

HostsView 的 scoped CSS 不再覆盖共享 `.btn` / `.status-dot` 等类的核心属性，用 `:deep()` 或移除 scoped 覆盖。字体/颜色/间距严格使用设计稿 px 值。

## Risks / Trade-offs

- 改动范围仅 HostsView.vue 一个文件，风险低
- 浮窗菜单位置依赖 getBoundingClientRect，视口内正确，极端超宽屏幕需贴边处理

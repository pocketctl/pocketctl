## 1. 结构修正 — actions 浮窗菜单

- [x] 1.1 每个 .host-item 末尾加 `.ss-more-btn`（三圆点 SVG 16×16，fill:currentColor，cx:12 cy:5/12/19 r:1.8）
- [x] 1.2 实现浮窗菜单 `openMenu` / `closeMenu` / `onMenuClick`（v-if + getBoundingClientRect 定位，position:fixed z-index:200）
- [x] 1.3 菜单项：复制连接信息 / 导出主机报告 / 编辑别名 / 分隔线 / 重启 daemon（仅在线）/ 强制踢下线（仅在线）/ 分隔线 / 注销主机（.danger）
- [x] 1.4 菜单项图标：内联 SVG（I_COPY/I_EXPORT/I_EDIT/I_RESTART/I_POWER/I_TRASH，14×14 viewBox 0 0 24 24 stroke-width:2）
- [x] 1.5 从详情面板移除 `.more-actions` 区域及其所有样式

## 2. 字体大小体系对齐（15 处）

- [x] 2.1 `.page-title` 22px→24px + font-family:var(--font-display)
- [x] 2.2 `.page-subtitle` 13px→14px + color:var(--fg-tertiary)→var(--fg-secondary)
- [x] 2.3 `.hi-name` font-weight:500→600 + display:flex + gap:6px
- [x] 2.4 `.hi-meta` 11px→12px + margin-top:2px + overflow ellipsis
- [x] 2.5 `.hi-sessions` 18px/700/accent/block → 14px/600/var(--fg)/tabular-nums/inline
- [x] 2.6 `.hi-sess-label` 10px→11px + 文案 '活跃'→'活跃会话'
- [x] 2.7 `.hd-title` + letter-spacing:-0.01em + flex-wrap:wrap
- [x] 2.8 `.hd-sub` 12px→13px + margin-top:2px→4px
- [x] 2.9 `.r-val` 12px/normal/fg-secondary → 13px/600/fg + 44px width
- [x] 2.10 `.c-label` 10px→11px + letter-spacing:0.06em + margin-bottom:4px
- [x] 2.11 `.c-val` 13px→14px
- [x] 2.12 `.ss-num` + tabular-nums + line-height:1 + letter-spacing:-0.01em
- [x] 2.13 `.host-list-empty` 14px→13px + 48px→48px 16px
- [x] 2.14 `.section-label` → `.hd-section-title` + letter-spacing:0.08em
- [x] 2.15 `.btn` scoped 600→500 + padding:10px 16px→8px 16px

## 3. 图标修正

- [x] 3.1 `.hi-icon` 32×32→36×36 + border-radius:var(--radius-md) + background:var(--surface-active)
- [x] 3.2 新增 NAS 主机类型图标（rect rx2 + 三条横线 path）+ isNas 判断逻辑
- [x] 3.3 `.hd-icon` 容器 OK（48×48），确认 SVG 正确
- [x] 3.4 搜索图标 SVG r:8→7 + path l-4.35-4.35→l-4.3-4.3 + pointer-events:none
- [x] 3.5 空详情面板 icon 48px→40px + margin 8px→12px

## 4. 间距和颜色修正

- [x] 4.1 `.host-item` padding:10px 12px→12px 16px + gap:10px→12px + border-left + transition
- [x] 4.2 `.host-item.selected` background:var(--surface-hover)→var(--sidebar-active)
- [x] 4.3 `.host-item:last-child` + border-bottom:none
- [x] 4.4 `.host-search` 重构为 relative+absolute 图标定位（left:10px + pointer-events:none + input padding-left:34px）
- [x] 4.5 `.host-filter` + pill 容器样式（bg, border, radius, padding:3px）
- [x] 4.6 `.host-filter .host-tab` padding:8px→5px 11px + border-radius:5px + 移除 flex:1
- [x] 4.7 `.hd-section` 移除 background/border/border-radius/padding（纯内容区）
- [x] 4.8 `.r-fill` 过渡动画曲线 cubic-bezier(0.4,0,0.2,1)→cubic-bezier(0.2,0,0,1)
- [x] 4.9 `.conn-grid` gap:12px→16px 24px
- [x] 4.10 `.sess-summary` + card 外观（padding:16px + bg + border + radius）
- [x] 4.11 `.ss-divider` height:32px→align-self:stretch
- [x] 4.12 离线主机资源行始终渲染（.offline class + '—' 值 + section 标题文案）
- [x] 4.13 `.btn-danger` solid→outline style（transparent bg + error border + hover bg）
- [x] 4.14 `.btn-secondary:hover` + border-color:var(--border-light)

## 5. CSV/States/响应式修正

- [x] 5.1 `.status-dot` scoped 覆盖补充 animation（pulse-green/pulse-amber，来自 web-shared.css）
- [x] 5.2 `.status-pill` + `.pulse` 类在 HostsView scoped 中显式声明（设计稿依赖共享 CSS）
- [x] 5.3 `:focus-visible` + `:active` 明确作用域（非全局）
- [x] 5.4 `@media (max-width: 520px)` .host-filter justify-content
- [x] 5.5 `@media (prefers-reduced-motion: reduce)` animation/transition duration 0.01ms

## 6. 部署验证

- [x] 6.1 构建 vue-tsc 无错误
- [x] 6.2 Docker 本地部署验证（hosts 页面视觉效果）

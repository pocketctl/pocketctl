## MODIFIED Requirements

### Requirement: 主机列表项 hover 浮窗操作菜单
每个主机列表项 SHALL 在 hover 时显示 ⋯ 按钮（三圆点 SVG），点击弹出全局浮窗菜单（含复制连接信息/导出报告/编辑别名/重启daemon/强制踢下线/注销主机），菜单精确匹配设计稿定位（按钮右下 6px，position:fixed z-index:200）。

### Requirement: 字体/间距/颜色精确匹配设计稿
hosts 页面所有文本元素的字号、字重、颜色 SHALL 精确匹配 hosts.html 设计稿。.page-title 24px var(--font-display)、.hi-sessions 14px/600/fg、.hd-sub 13px 等至少 15 处修正。

### Requirement: 图标替换为设计稿 SVG 路径
所有 emoji 图标 SHALL 替换为设计稿指定的 SVG 路径（I_COPY/I_EXPORT/I_EDIT/I_RESTART/I_POWER/I_TRASH，14×14 viewBox 0 0 24 24 stroke-width:2 fill:none）。补充 NAS 主机类型图标（rect rx2 + 三条横线）。.hi-icon 容器 36×36 带 background:var(--surface-active)。

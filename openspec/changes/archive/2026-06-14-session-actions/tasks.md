## 1. DB Migration 与函数

- [x] 1.1 sessions 表加 `pinned BOOLEAN DEFAULT false` + `pinned_at TIMESTAMPTZ` 列 + 索引（幂等）
- [x] 1.2 新增 `setSessionPin(pool, userId, sessionId, pinned)` — 带归属校验
- [x] 1.3 新增 `updateSessionTitle(pool, userId, sessionId, title)` — 无条件改名 + 归属校验
- [x] 1.4 新增 `getSessionAllEvents(pool, sessionId)` — 全量 events（导出用）
- [x] 1.5 新增 `isSessionOwnedByUser(pool, userId, sessionId)` — 归属校验
- [x] 1.6 `listSessions`/`listSessionsByUser` SELECT 加 `s.pinned`，ORDER BY 加置顶权重
- [x] 1.7 修 `listSessionsByUser` 的 daemon_alias bug（SELECT 加 `d.alias AS daemon_alias`）

## 2. Relay Router

- [x] 2.1 handleClientMessage 加 `session_pin` 分支 → setSessionPin + 广播 session_pinned
- [x] 2.2 session_delete 补 isSessionOwnedByUser 校验（越权拒绝）
- [x] 2.3 daemon 被动 session_title_update 的 UPDATE 加 `AND title LIKE 'Terminal Session-%'` 保护

## 3. Relay Server (REST)

- [x] 3.1 新增 `PUT /api/sessions/:sessionId/title`（Bearer + ownership + 广播 session_title_update）
- [x] 3.2 新增 `GET /api/sessions/:sessionId/export?format=md|json|txt`（Bearer + ownership + 流式响应 + Content-Disposition）
- [x] 3.3 导出格式拼装：md（标题+user/agent/tool 折叠）/ json（payload 原样）/ txt（纯文本时间线）

## 4. Web 浮窗组件

- [x] 4.1 新增 `SessionActions.vue` 浮窗菜单组件（复用设计稿 ss- CSS：菜单/按钮/toast/确认框/导出框/重命名输入框/pin 标记）
- [x] 4.2 hover ⋯ 按钮 + 点击弹出菜单 + 菜单外/Esc/scroll 关闭
- [x] 4.3 复制 ID（clipboard + fallback + hint 反馈）
- [x] 4.4 置顶（session_pin WS + DOM 重排 + pin 标记 + 取消固定）
- [x] 4.5 重命名（inline input + PUT /title + Enter/Esc/blur + toast 撤销）
- [x] 4.6 导出（格式选择框 + GET /export + Blob 下载）
- [x] 4.7 删除（二次确认 + 延迟 5s 发送 session_delete + 行淡出 + toast 撤销）

## 5. Web 视图接入

- [x] 5.1 `SessionList.vue` 接入 SessionActions 组件；补 `session_deleted`/`session_pinned` 监听；sortedSessions 加 pinned
- [x] 5.2 `DashboardView.vue` 接入 SessionActions；补 `session_pinned` 监听；sortedSessions 加 pinned
- [x] 5.3 两页面 session 字段映射加 `pinned: s.pinned || false`

## 6. 测试验证

- [x] 6.1 复制 ID：剪贴板含正确 session_id
- [x] 6.2 置顶：列表重排，刷新后仍置顶（持久化）
- [x] 6.3 重命名：标题更新，多端同步，daemon 不覆盖
- [x] 6.4 导出：md/json/txt 三格式文件正确下载
- [x] 6.5 删除：5s 撤销可用，倒计时结束真正删除，列表移除
- [x] 6.6 ownership：越权 pin/重命名/导出/删除被拒绝
- [x] 6.7 daemon_alias bug 修复：列表正确显示别名

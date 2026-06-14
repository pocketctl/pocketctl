## 1. SessionDetail 接入 SessionActions

- [x] 1.1 import SessionActions 组件
- [x] 1.2 session-list-item 模板加 `<SessionActions :session="s" @renamed @deleted @pinned>` + 📌 pin 标记
- [x] 1.3 补 onEvent 监听：session_deleted（移除 + 切换当前会话）、session_pinned（更新 pinned）、session_title_update（更新 title）
- [x] 1.4 新增 onRenamed/onDeleted/onPinned 处理函数（乐观更新 allSessions）
- [x] 1.5 删除当前会话时自动切换到列表第一个（router.push）
- [x] 1.6 style 加 .session-list-item.pending-delete 淡出
- [x] 1.7 构建 + 验证编译

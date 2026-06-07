## Tasks

### Phase 1: 连接稳定性 & Session 恢复

- [x] **T1: 修复 WebSocket 直连 relay 连接**
  - 前端通过 `window.__RELAY_WS__` 直连 relay:8080
  - 已完成：index.html 注入变量、SessionList 和 SessionDetail 读取变量
  - 验证：浏览器打开页面 ConnectionBanner 显示 Connected

- [x] **T2: Session 列表从数据库恢复**
  - Relay `list_sessions` 命令返回 PG 中所有 session
  - 前端 `onMounted` 发送 `list_sessions`，渲染返回的 session 列表
  - 已完成：relay router + db 层，前端 SessionList.vue
  - 验证：刷新页面能看到之前的 session

- [x] **T3: 错误事件路由与展示**
  - Relay 将 daemon error 事件（无 session_id）路由到 pending client
  - 前端显示红色错误提示条，5 秒自动消失
  - 已完成：relay router + SessionList.vue
  - 验证：创建 session 时用错误路径，页面显示错误提示

- [x] **T4: Session ID 变更通知全链路**
  - Daemon `readOutput` 检测到 ID 变更时发送 `session_id_changed` 事件
  - Relay 更新 DB session_id + 客户端订阅映射
  - 前端更新列表中的 session ID
  - 已完成：daemon manager.go + protocol types + relay router + 前端 SessionList
  - 需验证：go build 编译通过，创建 session 后列表显示真实 UUID

### Phase 2: 对话历史回放

- [x] **T5: SessionDetail 加载历史 via replay**
  - SessionDetail `onMounted` 发送 `{ type: "replay", session_id, last_seq: 0 }`
  - 收到的事件渲染到消息列表
  - 之后继续接收实时事件
  - 涉及文件：`web/src/views/SessionDetail.vue`

- [x] **T6: 工具调用结构化展示**
  - `tool_call` 事件显示工具名称 + 格式化 input
  - `tool_result` 事件折叠展示 output，可展开
  - 优化工具消息气泡样式
  - 涉及文件：`web/src/views/SessionDetail.vue`

### Phase 3: 移动端适配

- [x] **T7: 全局移动端样式**
  - 添加 viewport meta（已有）
  - SessionList 响应式布局：session 行自适应
  - SessionDetail 响应式：消息气泡宽度、固定输入框
  - NewSessionDialog 全屏模式（小屏幕）
  - 涉及文件：所有 `.vue` 组件的 `<style scoped>`

- [x] **T8: 触摸交互优化**
  - 可点击元素最小 44px 高度
  - session 行点击区域增大
  - 按钮间距适配触摸
  - 涉及文件：所有 `.vue` 组件

### Phase 4: 端到端验证

- [x] **T9: 重新构建 Docker 镜像并部署**
  - `go build` 编译新 daemon
  - `docker compose up --build` 重建 relay 和 web
  - 重启 daemon
  - 验证所有服务正常

- [ ] **T10: 移动端端到端测试**
  - Mac 上创建 session（用 Claude Code）
  - 手机浏览器打开 pocketctl
  - 验证：看到 session 列表 → 点进 session → 看到历史 → 发消息 → 看到实时响应

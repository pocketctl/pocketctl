## ADDED Requirements

### Requirement: 会话浮窗操作菜单
会话列表项 SHALL 在 hover 时显示 ⋯ 按钮，点击弹出含 5 项操作的浮窗菜单（复制ID/置顶/重命名/导出/删除）。

#### Scenario: hover 显示 ⋯ 按钮
- **WHEN** 鼠标 hover 到会话行
- **THEN** 右上角 ⋯ 按钮从透明淡入显示
- **AND** 移动端（≤768px）⋯ 永久显示

#### Scenario: 点击 ⋯ 弹出菜单
- **WHEN** 点击 ⋯ 按钮
- **THEN** 弹出浮窗菜单（复制ID | 置顶/重命名/导出 | 删除），两组分隔线分三段
- **AND** 点击菜单外/Esc/scroll 关闭菜单

### Requirement: 复制会话 ID
点击"复制会话 ID" SHALL 调用 `navigator.clipboard.writeText(session_id)`，hint 临时显示"已复制"。

#### Scenario: 复制成功
- **WHEN** 点击复制项
- **THEN** session_id 写入剪贴板
- **AND** hint 文案临时变"已复制"，1.2s 后关闭菜单

### Requirement: 固定到顶部
点击"固定到顶部" SHALL 发送 `session_pin` 消息，relay 广播 `session_pinned`，列表重排置顶项到顶部。

#### Scenario: 置顶
- **WHEN** 点击"固定到顶部"
- **THEN** 发送 `{type:'session_pin', session_id, pinned:true}`
- **AND** relay 广播 `session_pinned`，所有客户端重排
- **AND** 标题前显示 📌 图标，行背景 accent-subtle
- **AND** 菜单项文案变"取消固定"

#### Scenario: 取消置顶
- **WHEN** 点击"取消固定"
- **THEN** 发送 `{type:'session_pin', session_id, pinned:false}`
- **AND** 该行移到置顶区之后

### Requirement: 重命名会话
点击"重命名会话" SHALL 进入 inline 编辑，Enter 提交 `PUT /api/sessions/:id/title`，Esc 取消。

#### Scenario: inline 编辑提交
- **WHEN** 点击重命名 → 输入新标题 → Enter
- **THEN** 调用 `PUT /api/sessions/:id/title` `{title}`
- **AND** relay 广播 `session_title_update` 同步其他客户端
- **AND** 显示 toast"已重命名为「xxx」"

#### Scenario: 空标题回退
- **WHEN** 输入空值提交
- **THEN** 回退原标题，不调用接口

### Requirement: 导出记录
点击"导出记录" SHALL 弹格式选择框（md/json/txt），确认后下载文件。

#### Scenario: 导出 Markdown
- **WHEN** 选择 md 格式 → 点"导出下载"
- **THEN** 调用 `GET /api/sessions/:id/export?format=md`
- **AND** 浏览器下载 `<title>.md` 文件（含 user/agent/tool 消息）

#### Scenario: 导出 JSON
- **WHEN** 选择 json 格式
- **THEN** 下载 `{session_id, title, exported_at, events:[...]}` 结构文件

### Requirement: 删除会话（延迟发送撤销）
点击"删除会话" SHALL 弹二次确认，确认后延迟 5s 发送 `session_delete`，5s 内可撤销。

#### Scenario: 删除 + 撤销
- **WHEN** 确认删除 → 行淡出 + 5s toast 倒计时
- **AND** 5s 内点撤销
- **THEN** 取消发送，行恢复

#### Scenario: 删除最终执行
- **WHEN** 5s 倒计时结束
- **THEN** 发送 `session_delete`，relay 删除 events+sessions+墓碑，广播 session_deleted

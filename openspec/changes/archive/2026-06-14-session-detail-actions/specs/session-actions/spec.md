## MODIFIED Requirements

### Requirement: 会话详情页会话列表接入浮窗操作
SessionDetail 左侧会话列表的每个会话项 SHALL 接入 SessionActions 浮窗组件，支持复制ID/置顶/重命名/导出/删除，行为与 Dashboard 一致。

#### Scenario: hover 显示操作菜单
- **WHEN** hover 会话详情页左侧会话列表项
- **THEN** 显示 ⋯ 按钮，点击弹出 5 项操作菜单

#### Scenario: 删除当前查看的会话
- **WHEN** 删除的会话是当前正在查看的会话（session_id === 当前路由）
- **THEN** 自动切换到列表第一个会话
- **AND** 如果列表为空，显示空态

#### Scenario: 会话列表实时同步
- **WHEN** 其他客户端置顶/重命名/删除会话
- **THEN** SessionDetail 会话列表实时更新（监听 session_pinned/session_title_update/session_deleted）

## ADDED Requirements

### Requirement: SessionDetail 会话列表置顶排序
SessionDetail 会话列表 SHALL 置顶项排在顶部，与 Dashboard 行为一致。

#### Scenario: 置顶项排前
- **WHEN** 会话被置顶
- **THEN** 该会话在 SessionDetail 左侧列表中排到顶部，显示 📌 标记

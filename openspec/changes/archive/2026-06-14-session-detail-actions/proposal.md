## Why

会话详情页（SessionDetail.vue）左侧会话列表缺少操作入口。复制ID/置顶/重命名/导出/删除 5 功能已在 Dashboard 和 SessionList 通过 SessionActions 组件实现，但 SessionDetail 的会话列表未接入。接口和组件均已存在，本次纯粹是复用接入。

## What Changes

- SessionDetail 会话列表项接入已有的 `SessionActions.vue` 组件（零新接口、零新组件）
- 补全 SessionDetail 缺失的 3 个事件监听：`session_deleted`、`session_pinned`、`session_title_update`
- 会话列表加 pinned 字段排序（置顶项排前）+ 📌 视觉标记
- 删除当前查看的会话时，自动切换到列表第一个会话（SessionDetail 特有边界）

## Capabilities

### Modified Capabilities

- `session-actions`: SessionDetail 会话列表也接入浮窗操作菜单，与 Dashboard/SessionList 行为一致

## Impact

- **Web (`web/src/views/SessionDetail.vue`)**: template 加 SessionActions + pin 标记；script import 组件 + 补 3 个事件监听 + onRenamed/onDeleted/onPinned 处理 + 删除当前会话切换；style 加 pending-delete 淡出

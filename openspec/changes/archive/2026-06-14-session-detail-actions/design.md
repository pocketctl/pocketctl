## Context

SessionActions.vue 组件（props: session, emit: renamed/deleted/pinned）已在 Dashboard/SessionList 使用。5 功能的接口（session_pin WS、PUT /title REST、GET /export REST、session_delete WS、clipboard）均已实现。SessionDetail 的会话列表（allSessions，来自 session_list WS）只需接入组件 + 补事件监听。

## Goals / Non-Goals

**Goals:**
- SessionDetail 会话列表接入 SessionActions，行为与 Dashboard 一致
- 补全 session_deleted/session_pinned/session_title_update 监听
- 删除当前会话时自动切换

**Non-Goals:**
- 不新增接口或组件
- 不改 SessionActions 组件本身

## Decisions

### Decision 1: 直接复用 SessionActions 组件

SessionActions 的 props/emit 接口通用。SessionDetail 的 allSessions session 对象含 session_id/title（relay 返回 pinned）。直接 `<SessionActions :session="s" @renamed=... @deleted=... @pinned=... />`。

### Decision 2: 删除当前会话切换逻辑

SessionDetail 删除当前查看的会话后（session_deleted 监听移除），如果删的就是 sessionId.value，切换到 allSessions 第一个。Dashboard/SessionList 无此问题（它们不显示会话内容）。

## Risks / Trade-offs

- SessionDetail 点击会话是 router.push（切换），SessionActions ⋯ 按钮 `.stop.prevent` 不影响 ✅
- 弹层 `.stop` 防冒泡（已在 SessionActions 修复）✅

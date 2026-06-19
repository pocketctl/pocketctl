## ADDED Requirements

### Requirement: Session 明细展开内容与分页
单主机视图的 session 明细 SHALL 还原设计稿展开内容（会话详情 + 6 项指标 + 30 天趋势），第一列用会话名称，并支持前端分页。by-daemon 返回 `model / agent_type / status / created_at` 供展开标题使用。

#### Scenario: 展开显示完整内容
- **WHEN** 用户展开一个 session
- **THEN** 显示会话详情标题（model · agent · 状态 · 创建时间）
- **AND** se-grid 6 项（输入量 / 输出量 / 输入输出比 / Cache 命中 / 总 Token / 日均消耗）
- **AND** 30 天每日趋势 mini bars（trend API `slice(-30)`）

#### Scenario: 第一列用会话名称
- **WHEN** 渲染 session 明细行
- **THEN** 第一列显示会话 title（无 title 时回退 session_id 前 8 位）

#### Scenario: 分页
- **WHEN** session 数超过 pageSize
- **THEN** 显示翻页控件（首页 / 上页 / 当前 / 总 / 下页 / 末页 + 每页条数选择）
- **AND** 切页或切 host 时重置展开状态

#### Scenario: by-daemon 返回扩展字段
- **WHEN** 客户端请求 by-daemon sessions
- **THEN** 每个 session 含 `model / agent_type / status / created_at`（供展开标题）

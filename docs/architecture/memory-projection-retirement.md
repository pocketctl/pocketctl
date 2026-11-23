# Memory 投影表退役

Memory API 和 Worker 使用 Relay 同库的 `memory` 命名空间。个人回合以 `public.events` 为原始来源，按安装授权、会话、回合和终态读取 Prompt 与最终回复。编译结果保留原生事件定位符及成员哈希。工具、推理和操作类回合沿用回合过滤规则。独立数据库的 feed/snapshot 输入以及共享库的 shadow 双跑退出生产配置。

## 来源和调用方

| 业务 | 新数据源和行为 |
| --- | --- |
| 个人回合与归并 | Relay 终态及后续相关变更写入 `shared.memory_dialogue_pending`。Worker 合并同一回合的通知，领取带会话和回合标识的编译任务。归并通过 `dialogue_members` 和原生回合重读校验成员及摘要。 |
| Team | 原生协作、交付和 roster 提供正文、身份、版本与参与者范围。注册保留见证和哈希。发布引用语义组。历史关联与模型费用审计保留原 UUID、关联边和证明。发布、撤权、费用归属沿用原有审核条件，有未归属历史支出的组继续受限。 |
| 独立归档 | `shared.memory_archive_records` 接管经验证的独立原件、清单哈希、所有者和原 UUID。已回收记录保留拒读状态。会话墓碑和安装清理传播到归档资料及依赖的证据。 |
| 证据、上下文、Skill、Git | 回合证据核对事件和回合清单。历史证据按类型解析至独立归档、Team 原始记录或已发布语义组。工件保留定位和哈希，会话绑定用于撤回依赖项。证据及 Skill 删除继续遵循原安装边界。 |
| 健康、保留、隐私清除 | 个人处理进度按回合任务统计，Team 按原生分发进度统计。新回合回收核验原生终态、抽取、证据及未完成任务，归并收据仍保护在用数据。会话或安装清除使用墓碑与原生会话权限。 |
| 治理变更日志 | `memory.memory_governance_migration_changes` 保留。已有维护逻辑按批删除满 14 天且没有被活动迁移水位保护的记录。 |

## 13 张候选表

| 阶段 | 表 |
| --- | --- |
| 更新共享合约后删除 4 张 | `shared.memory_projection_policies`、`shared.memory_projection_windows`、`shared.memory_source_shadow_progress`、`memory.memory_canonical_projection_progress` |
| 核对来源与外部依赖后删除 5 张 | `memory.source_events`、`memory.source_artifacts`、`memory.source_sessions`、`memory.source_turns`、`memory.memory_task_bundle_sources` |
| 保存传输回执后删除 4 张 | `memory.memory_feed_inbox`、`memory.memory_inbox_checkpoints`、`memory.memory_snapshot_events`、`memory.memory_snapshot_runs` |

`memory_source_delivery_facts` 和 `memory_source_snapshot_facts` 保留原视图、字段与权限，底层转为无正文回执。仍需保留回合编译、Team 语义组和发布、知识及审计结果、共享授权、原生任务、墓碑。代码仓库的 Git 快照与上述会话 snapshot 传输属于不同数据源。

## 切换与验收

1. 在目标环境先执行 `scripts/audit-memory-projection-dependencies.sql`。清单显示物理表、外键、视图、存储函数、队列、编译清单和证据引用。表名匹配也会报告升级期间使用的旧库清理代码。
2. 更新 Relay 的原生捕获合约，再更新 Memory 合约和角色权限。保持安装原有的输入起点、授权和暂停状态。有原生授权及有效输入起点的已启用个人安装会登记回合处理。旧模式中的活动安装须先按原范围完成原生切换。旧版 Worker 退出后再进行物理退役。完成物理退役后，新安装在授权、输入起点和部署允许范围都通过校验后登记；已暂停的安装保持暂停。
3. 对输出旧任务、旧 episode、归档证据不匹配、未回收的传输正文或混合来源的安装先核对归属。个人试用结果可以定向清理。独立原件、Team 审计、已接受证据和未结算的工作需要保留。删除事务遇到这些未解决的依赖会报具体原因并回滚。
4. 在维护窗口用独立迁移角色执行下列演练。演练会获取排他锁并实际执行 DDL，然后回滚。日常在线盘点使用第一步的只读脚本。第二条命令才会提交删除。

```sh
psql "$MEMORY_MIGRATION_DATABASE_URL" -X -v expected_database="$EXPECTED_DATABASE" -f scripts/retire-memory-projection-storage.sql
psql "$MEMORY_MIGRATION_DATABASE_URL" -X -v expected_database="$EXPECTED_DATABASE" -v apply=true -f scripts/retire-memory-projection-storage.sql
```

事务使用原表写入栅栏，检查来源身份、保留哈希、任务成员、旧收据、外部证据和 Skill 引用，并使用 `DROP ... RESTRICT`。任一检查失败时整次回滚，包括传输视图与回执切换。提交前检查 13 个表名均已消失。数据库迁移和服务启动验证可重复运行。执行前的数据库备份用于恢复已经提交的物理删除。

限于退役操作的旧库核验、历史编号迁移和测试夹具仍会出现旧表名。仍有旧 episode 无法核对其原生来源时，物理删表脚本会报告 `historical_episode_dependencies_require_review` 并回滚。个人试用产物可按安装定向清理；Team 与独立归档产物须能追溯到保留的来源。

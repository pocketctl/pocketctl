# 显式有界预填原 Session 标识

`logical-preparation.ts` 只供首次 native Session 合同迁移前的维护操作，不从 Relay 启动调用。先以专用物理 superuser 连接调用 `planNativeLogicalPreparation` 得到精确 database/OID、cluster system identifier摘要、events OID/结构摘要和 batchRows 的计划。默认每批100000行，上限相同；计划不含正文、配置或凭据。

停止并隔离 events 所有可写 LOGIN 角色（含 NOINHERIT 的 SET ROLE 路径）、排空其他可写/管理员连接后，显式调用 `prepareNativeLogicalSessions(client, plan, {signal,afterBatch})`。每批仅给尚空的 `logical_source_session_id` 写原 `session_id`，独立提交后执行普通 VACUUM 复用死页和索引空间；不用 FULL、不删正文、不创建备份或改变权威。`afterBatch` 提供累计行数、表/索引字节和 WAL LSN，可结合操作机的实时空间/WAL上限主动中断。不能仅凭 max_wal_size 推断硬峰值。

中断后保留已提交原标识，仍在停写状态前向续作；不得复原或覆盖矛盾标识。工具每批复核身份/结构/隔离，拒绝已有 native authority/alias、非 nullable varchar(128) 列、默认值、未审通用 UPDATE 触发器和任何不同于原 Session 的预填。完成后仍需正常 native 迁移安装 NOT NULL、authority及保护触发器，并重新冻结目录/核验。PG13/17 的专用测试还验证了正文、大整数及空间复用；这不是生产空间准入或迁移完成证明。

已有派生列的续作先执行普通 VACUUM，再提交下一批，避免上次已提交而 VACUUM 失败时继续扩大占用。UPDATE 维持60秒语句上限，普通 VACUUM 单独使用300秒语句/60秒锁等待上限（允许与现有维护锁有界协调），其余操作锁等待仍为1秒，退出恢复原连接设置。`afterStage` 区分 `resume-vacuum-started/complete`、`update-committed`、`batch-vacuum-started/complete`，包含本次调用累计行数与批次数；不能把 VACUUM 前没有 `afterBatch` 回调误读成没有已提交数据。阶段回调或进程中断后，已提交的标识继续保留。

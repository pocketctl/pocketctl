# 流式证据修复后的历史数据重建

`memory-episode-packet-v4` 在证据条数限制前按消息 Part（缺失时按
Stream）归并文本，优先选择最终事件的 Snapshot。证据仍指向该原始事件；
不拼接无法验证完整性的 delta。未结束的 streaming 消息不作为证据。
usage-only、空正文、未知事件不占证据额度；工具输出仍不进入允许字段。

代码更新只影响新编译的 Episode，不会自动修改历史候选或已接受的知识。
下面是**需要运维明确执行的维护步骤**，不要作为启动迁移自动运行。

1. 备份 Memory 数据库，部署新版代码。暂停 Memory worker，并暂停候选审核操作，
   等待正在执行的提取、审核事务结束。
2. 在 psql 中设置唯一目标安装 ID（`\set installation_id '实际 UUID'`）。
   先只读检查受影响范围：

```sql
SELECT e.episode_id, e.turn_id, e.document_compiler_version,
       count(c.candidate_id) FILTER (WHERE c.status IN ('validated', 'conflict', 'shadow')) AS pending_candidates
FROM work_episodes e
LEFT JOIN memory_candidates c USING (installation_id, episode_id)
WHERE e.installation_id = :'installation_id'::uuid
  AND e.document_compiler_version IS DISTINCT FROM 'memory-episode-packet-v4'
GROUP BY e.episode_id, e.turn_id, e.document_compiler_version;

SELECT extraction_mode FROM memory_feature_settings
WHERE installation_id = :'installation_id'::uuid;
```

3. 确认范围后执行以下事务。旧待审候选标记为校验失败并保留审计记录；
   不修改 accepted/rejected 候选、知识版本或原始事件。若 extraction_mode 为 off，
   编译器不会调用模型；重新提取前需通过正常设置流程启用提取。

```sql
BEGIN;

UPDATE memory_candidates c
SET status = 'rejected_by_validator', revision = revision + 1,
    validation = validation || '{"codes":["obsolete_stream_evidence"]}'::jsonb
FROM work_episodes e
WHERE c.installation_id = :'installation_id'::uuid
  AND e.installation_id = c.installation_id AND e.episode_id = c.episode_id
  AND e.document_compiler_version IS DISTINCT FROM 'memory-episode-packet-v4'
  AND c.status IN ('validated', 'conflict', 'shadow', 'duplicate');

INSERT INTO memory_jobs
  (job_id, installation_id, job_type, idempotency_key, priority, payload, available_at)
SELECT gen_random_uuid(), e.installation_id, 'compile_episode',
       'compile_episode:' || e.turn_id, 80, '{}'::jsonb, NOW()
FROM work_episodes e
WHERE e.installation_id = :'installation_id'::uuid
  AND e.document_compiler_version IS DISTINCT FROM 'memory-episode-packet-v4'
ON CONFLICT (installation_id, job_type, idempotency_key) DO UPDATE SET
  state = 'pending', attempts = 0, available_at = NOW(),
  claimed_by = NULL, claim_expires_at = NULL, last_error_code = NULL, completed_at = NULL;

COMMIT;
```

4. 恢复 worker。编译器版本与 source digest 变化会触发现有提取队列；
   提取次数上限按当前 source digest 计算，已成功提取过的旧 Episode 可在重编译后
   越过首次安装时间门槛。生产模型预算仍是独立限制，额度不足时需先按既定变更流程
   配置新预算，再对目标安装的旧 Episode 定向重排 `extract_candidates` 任务。
   等待新提取 run 和候选生成后，再恢复审核操作。
   检查目标 Episode 的 document_compiler_version、任务失败状态，以及新候选
   evidence excerpt 是否为完整消息（超长消息仍受脱敏、截断策略约束）。
   已接受的旧知识需单独人工复核，本流程不会自动撤销它们。

# PocketCtl Memory Golden Set

版本化 JSONL 评估集。每行一个 case（`memory/src/eval/schema.ts` 的冻结格式）：
`id`（≤64 字符不透明标识）、`query`、`installation_id`、允许的 scope
（repository/snapshot/branch 白名单）、期望的 claim/evidence、人工审核结果。

- **只提交合成 fixture**（`fixtures/synthetic.jsonl`）。
- 真实历史任务属于私有集：放入 `memory/eval/private/**`（已 gitignore），
  绝不提交原始 Session 文本、token、路径或机密。
- 运行：`npm run eval -- --dataset "$MEMORY_GOLDEN_SET_PATH" --output report.json`
  （确定性：同一数据库快照 + 同一 dataset 版本 → 同一聚合结果）。
- 报告只含聚合指标与不透明 case id；不含查询或证据原文。

# 私有 Golden Set（gitignore，绝不提交）

## 当前文件

- `golden-v0-draft.jsonl` — **草稿**（2026-08-27 由 ZCode 从 canary 账本 4 条 active Claim 起草，待任务所有者确认）

## 定稿步骤

1. 逐条检查每个 case 的 `query`：改成你真实会问的表述（现在是我按 Claim 陈述代拟的）。
2. 确认 `expected.claim_ids` 映射正确：这个问题你期望命中哪条 Claim。
3. gs-005 是负向 case（期望空结果），确认该 installation 下确实没有相关 Claim。
4. 给每条加 `review_outcome` 字段：`accepted_as_is` / `light_edit` / `major_edit` / `rejected`（候选接受率指标的输入）。
5. 运行：
   ```bash
   MEMORY_DATABASE_URL=postgres://pocketctl_memory:pocketctl_memory@127.0.0.1:5432/pocketctl_memory \
   MEMORY_HMAC_KEY=<≥32字节> \
   MEMORY_GOLDEN_SET_VERSION=golden-v0 \
   npm run eval -- --dataset eval/private/golden-v0-draft.jsonl --output /tmp/golden-report.json
   ```

## 当前 Claim 映射（2026-08-27 canary 账本）

| case | installation | claim 类型 | claim_id |
|---|---|---|---|
| gs-001 | e8655778… | architecture_decision | f5cbb32f…（Web 先从 Relay 拿短时 grant 再直连 Memory） |
| gs-002 | e8655778… | implementation_map | f6ff1f5c…（daemon v0.4.3-126-gcc3ed0f-dirty 构建部署） |
| gs-003 | 12751184… | test_invariant | ff566fdc…（cobalt-sparrow-27 须标 test-only） |
| gs-004 | fec67b12… | work_method | ac47474f…（播种合成标记的正确做法） |
| gs-005 | e8655778… | （空预期） | — |

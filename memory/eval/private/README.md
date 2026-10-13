# 私有 Golden Set（gitignore，绝不提交）

## 当前文件

- `golden-v0.jsonl` — **用户定稿**（2026-08-27：query 为任务所有者自然口吻 + review_outcome 标注）
- `reports/golden-v0-hybrid-2026-08-27.json` — 混合检索（生产路径）结果
- `reports/golden-v0-lexical-only-2026-08-27.json` — 纯词法（退化路径）结果

## 已测指标（2026-08-27，canary 真实数据）

| 指标 | 混合（生产路径） | 纯词法（embedding 退化） | Gate 门槛 |
|---|---|---|---|
| Top-5 命中率 | **100%**（4/4 全部 rank 1） | **0%**（全部空结果） | ≥70% |
| Evidence 覆盖 | 100% | 100% | 100% |
| Scope 泄漏 | 0 | 0 | 0 |
| 延迟 | median 123ms / p95 241ms | median 2ms / p95 26ms | hybrid <1.5s |

**关键结论**：中文自然问法 ↔ 英文 Claim 陈述的匹配完全依赖向量通道；词法退化路径跨语言召回为零（`degraded_components=['embedding']` 时检索对中文用户实质不可用）。此发现须记入 gate 报告；产品侧值得评估让提取按用户语言产出陈述。

**负向 case 观察**：hybrid 下 gs-005（iOS 无关问题）不再返回空——向量相似度 0.05 阈值会放行弱相关项。n=4 时无法判定精度问题，数据集扩大后复核。

## 复跑命令

```bash
# 混合路径（需 worker 同款 MEMORY_EMBEDDING_* env + canary DB 密码）
MEMORY_DATABASE_URL="postgres://pocketctl_memory:<密码>@127.0.0.1:5432/pocketctl_memory" \
MEMORY_HMAC_KEY=<≥32字节> MEMORY_GOLDEN_SET_VERSION=golden-v0 \
MEMORY_EMBEDDING_PROVIDER=openai-compatible MEMORY_EMBEDDING_BASE_URL=<dashscope> \
MEMORY_EMBEDDING_MODEL=qwen3.7-text-embedding MEMORY_EMBEDDING_DIMENSIONS=1024 \
MEMORY_EMBEDDING_API_KEY=<key> \
npm run eval -- --dataset eval/private/golden-v0.jsonl --output <path>
```

注意 zsh 下 `export $MULTILINE_ENV` 不分词，必须逐行 export。

## Claim 映射（2026-08-27 canary 账本）

| case | installation | 类型 | claim_id 尾号 |
|---|---|---|---|
| gs-001 | e8655778… | architecture_decision | f5cbb32f… |
| gs-002 | e8655778… | implementation_map | f6ff1f5c… |
| gs-003 | 12751184… | test_invariant | ff566fdc… |
| gs-004 | fec67b12… | work_method | ac47474f… |
| gs-005 | e8655778… | （空预期/负向） | — |

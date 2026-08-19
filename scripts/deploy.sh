#!/bin/bash
# ============================================
# ⚠️  此脚本已退役（H-9 安全整改）
#
# 历史问题：本脚本以 root 服务运行 Relay、把 PostgreSQL pg_hba.conf 的
# ident/peer 全局替换为弱摘要认证、且只配置明文 HTTP。它不再执行任何部署动作。
#
# 请使用仓库内的正式加固部署路径：
#   - deploy/deploy.sh                    （非 root systemd + SCRAM + TLS）
#   - docker-compose.prod.yml             （compose 部署，TLS 必填）
#   - docs/operations/tls-rollout.md      （TLS 上线 runbook）
# ============================================

cat >&2 <<'MSG'
[this script is retired]
scripts/deploy.sh 已退役，不再执行任何部署操作。
请使用 deploy/deploy.sh（非 root systemd 单元 + PostgreSQL SCRAM + TLS），
或 docker-compose.prod.yml（显式证书挂载）。详见 docs/operations/tls-rollout.md。
MSG

exit 1

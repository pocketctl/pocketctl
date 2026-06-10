#!/bin/bash
# Git pre-push hook
# push 到 master 分支前自动运行测试
# 安装: cp scripts/pre-push-hook.sh .git/hooks/pre-push && chmod +x .git/hooks/pre-push

protected_branch='master'
current_branch=$(git rev-parse --abbrev-ref HEAD)

if [ "$current_branch" = "$protected_branch" ]; then
    echo "🔒 push 到 master 前运行测试..."
    bash scripts/ci-test.sh
    if [ $? -ne 0 ]; then
        echo ""
        echo "❌ 测试失败，push 已阻止。修复后重试。"
        echo "   跳过测试: git push --no-verify"
        exit 1
    fi
fi
exit 0

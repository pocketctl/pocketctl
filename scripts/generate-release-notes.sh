#!/bin/bash
# scripts/generate-release-notes.sh - 自动生成 GitHub Release Notes
# 使用方法: ./scripts/generate-release-notes.sh <merge-base> <to-branch> <version>

# 设置错误处理
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# 参数验证
if [[ $# -lt 3 ]]; then
  echo "❌ 错误：需要 3 个参数"
  echo "用法: $0 <merge-base> <to-branch> <version>"
  echo "例如: $0 origin/master develop v0.3.1"
  exit 1
fi

MERGE_BASE="$1"
TO_BRANCH="$2"
VERSION="$3"

# 参数验证
if [[ -z "$MERGE_BASE" || -z "$TO_BRANCH" || -z "$VERSION" ]]; then
  echo "❌ 错误：参数不能为空"
  echo "merge-base=$MERGE_BASE, to-branch=$TO_BRANCH, version=$VERSION"
  exit 1
fi

# 版本格式验证
if [[ ! "$VERSION" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "❌ 错误：版本格式不正确"
  echo "版本必须是 x.y.z 格式，例如: 0.3.1 或 v0.3.1"
  echo "您提供的版本: $VERSION"
  exit 1
fi

# 确保版本以 v 开头
VERSION="v${VERSION#v}"

# 临时文件
TEMP_DIR="/tmp/release-notes-$$"
mkdir -p "$TEMP_DIR"
RELEASE_NOTES_FILE="$TEMP_DIR/release-notes-v${VERSION#v}.md"
CONTENT_ANALYSIS_FILE="$TEMP_DIR/content-analysis.json"

# 初始化
echo "🤖 Release Notes 生成器"
echo "=========================="
echo "📊 生成版本: $VERSION"
echo "📈 对比范围: $MERGE_BASE → $TO_BRANCH"
echo "📝 输出文件: $RELEASE_NOTES_FILE"
echo ""

# 检查 git 是否在仓库根目录
if [[ ! -d "$REPO_ROOT/.git" ]]; then
  echo "❌ 错误：不在 git 仓库根目录"
  echo "请在有效的 git 仓库中运行此脚本"
  exit 1
fi

# 检查 compared 范围是否存在
cd "$REPO_ROOT"

if ! git show "$MERGE_BASE" > /dev/null 2>&1; then
  echo "❌ 错误：比较基线 '$MERGE_BASE' 不存在"
  echo "请提供有效的 git 引用或者分支名"
  echo "当前可用的分支和标签:"
  git branch -a --sort=-committerdate | head -10
  echo "HEAD 指向: $(git rev-parse HEAD)"
  exit 1
fi

if [[ ! -e "$TO_BRANCH" ]] && ! git show "$TO_BRANCH" > /dev/null 2>&1; then
  echo "❌ 错误：目标分支 '$TO_BRANCH' 不存在"
  echo "请提供有效的目标分支名称"
  exit 1
fi

# 获取并分析 commit
echo "🔄 正在获取 '$TO_BRANCH' 的 commit..."
COMMITS=$(git log "$MERGE_BASE".."$TO_BRANCH" --pretty=format:"%H|%s|%ad|%an|%ai" --date=iso --all)

COMMIT_COUNT=$(echo "$COMMITS" | wc -l | tr -d ' ')
echo "📈 总 commit 数量: $COMMIT_COUNT"

# 创建内容分析JSON
echo "$COMMITS" > "$CONTENT_ANALYSIS_FILE"

# 创建 Release Notes 文件
echo "# Release $VERSION" > "$RELEASE_NOTES_FILE"
echo "" >> "$RELEASE_NOTES_FILE"
echo "## What's New" >> "$RELEASE_NOTES_FILE"
echo "" >> "$RELEASE_NOTES_FILE"

# 智能分类和描述 commit
echo "📝 正在智能分类 commit..."

# 获取 features、bugfixes、internal 的 commits
FEATURES=$(echo "$COMMITS" | awk -F'|' '$3 ~ /2025-/) {print $0}')
BUGFIXES=$(echo "$COMMITS" | awk -F'|' '$3 ~ /2025-/) {print $0}')
INTERNAL=$(echo "$COMMITS" | awk -F'|' '!($3 ~ /2025-/)')  # 获取旧日期的 commit

# 辅助函数：智能格式化 commit 消息
format_commit_subject() {
    local subject="$1"
    local date="$2"
    local author="$3"
    
    # 中英文混杂识别
    if [[ "$subject" == *"（"* ]] || [[ "$subject" == *"（"* ]]; then
        # 中文括号处理
        local cn_part="${subject%%（*}"
        local en_part="${subject#*(}"
        en_part="${en_part%）*}"
        echo "Add ${cn_part} (${en_part}) by $author on $date"
    elif [[ "$subject" == *"（"* ]]; then
        local cn_part="${subject%%（*}"
        local en_part="${subject#*（}"
        en_part="${en_part%）*}"
        echo "Add ${cn_part} (${en_part}) by $author on $date"
    else
        echo "Add $subject by $author on $date"
    fi
}

# 生成 Features 部分
if [[ -n "$FEATURES" ]]; then
    local feature_count=$(echo "$FEATURES" | wc -l | tr -d ' ')
    echo "📊 发现 $feature_count 个 features/新增功能 commit:" >> "$RELEASE_NOTES_FILE"
    echo "" >> "$RELEASE_NOTES_FILE"
    
    echo "$FEATURES" | while IFS='|' read -r hash subject date author; do
        local formatted_subject=$(format_commit_subject "$subject" "$date" "$author")
        echo "- $formatted_subject" >> "$RELEASE_NOTES_FILE"
    done
    echo "" >> "$RELEASE_NOTES_FILE"
else
    echo "- Various improvements and new features" >> "$RELEASE_NOTES_FILE"
    echo "" >> "$RELEASE_NOTES_FILE"
fi

# 生成 Bug Fixes 部分
if [[ -n "$BUGFIXES" ]]; then
    local bugfix_count=$(echo "$BUGFIXES" | wc -l | tr -d ' ')
    echo "## Bug Fixes" >> "$RELEASE_NOTES_FILE"
    echo "" >> "$RELEASE_NOTES_FILE"
    echo "📊 发现 $bugfix_count 个 bug fix/commit:" >> "$RELEASE_NOTES_FILE"
    
    echo "$BUGFIXES" | while IFS='|' read -r hash subject date author; do
        local formatted_subject=$(format_commit_subject "$subject" "$date" "$author")
        echo "- $formatted_subject" >> "$RELEASE_NOTES_FILE"
    done
    echo "" >> "$RELEASE_NOTES_FILE"
fi

# 生成 Internal 部分
if [[ -n "$INTERNAL" ]]; then
    local internal_count=$(echo "$INTERNAL" | wc -l | tr -d ' ')
    echo "## Internal Improvements" >> "$RELEASE_NOTES_FILE"
    echo "" >> "$RELEASE_NOTES_FILE"
    echo "📊 发现 $internal_count 个内部改进 commit:" >> "$RELEASE_NOTES_FILE"
    
    echo "$INTERNAL" | while IFS='|' read -r hash subject date author; do
        local formatted_subject=$(format_commit_subject "$subject" "$date" "$author")
        echo "- $formatted_subject" >> "$RELEASE_NOTES_FILE"
    done
    echo "" >> "$RELEASE_NOTES_FILE"
fi

# 添加生成说明
echo "---" >> "$RELEASE_NOTES_FILE"
echo "*Generated from $COMMIT_COUNT commits between $MERGE_BASE and $TO_BRANCH*" >> "$RELEASE_NOTES_FILE"
echo "*Generated by scripts/generate-release-notes.sh on $(date +'%Y-%m-%d %H:%M:%S')*" >> "$RELEASE_NOTES_FILE"

# 显示最终结果
echo ""
echo "✅ Release Notes 生成完成！"
echo "📋 版本: $VERSION"
echo "📝 文件: $RELEASE_NOTES_FILE"
echo "📊 包含 $COMMIT_COUNT 个 commit"
echo ""

# 显示预览
echo "📋 Release Notes 预览:"
echo "======================="
echo "$(head -50 "$RELEASE_NOTES_FILE")"
if [[ $(wc -l < "$RELEASE_NOTES_FILE") -gt 50 ]]; then
    echo "... (省略 ...)"
fi

echo ""
echo "🎉 成功生成 Release Notes！"

# 返回临时文件路径
echo "$RELEASE_NOTES_FILE"

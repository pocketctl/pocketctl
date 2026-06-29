#!/bin/bash
# scripts/check-daemon-update.sh - 智能检测 merge 后是否有 daemon 二进制更新

# daemon 代码主要目录
DAEMON_DIRS=(
  "cmd/pocketctl"
  "internal/adapter"
  "internal/commands" 
  "internal/config"
  "internal/daemon"
)

# 需要排除的文件/目录
EXCLUDE_PATTERNS=(
  "test.*\.go$"
  "_test\.go$"
  "*_test\.go$"
  "_mock\.go$"
  "third.*party$"
  "vendor$"
  ".git$"
  "node_modules$"
  "dist$"
  "__pycache__$"
)

# 获取合并基线
if [[ $# -lt 2 ]]; then
  echo "用法: $0 <merge-base> <to-branch>"
  echo "例如: $0 origin/master develop"
  exit 1
fi

MERGE_BASE="$1"
TO_BRANCH="$2"

echo "🔍 开始 daemon 更新检测..."
echo "📊 比较范围: $MERGE_BASE → $TO_BRANCH"

# 初始化结果
HAS_DAEMON_UPDATE=false
DAEMON_CHANGED_FILES=()

# 检查每个 daemon 目录
for dir in "${DAEMON_DIRS[@]}"; do
  if [[ ! -d "$dir" ]]; then
    continue
  fi

  echo "🔍 检查目录: $dir"
  
  # 使用 git diff 检查是否有修改
  local_changes=$(git diff --name-only "$MERGE_BASE" "$TO_BRANCH" "$dir" 2>/dev/null || echo "")
  
  if [[ -n "$local_changes" ]]; then
    echo "✅ 发现 $dir 的改动:"
    echo "$local_changes" | while read -r file; do
      local file_name="$(basename "$file")"
      local is_excluded=false
      
      # 检查是否被排除
      for pattern in "${EXCLUDE_PATTERNS[@]}"; do
        if [[ "$file_name" =~ $pattern ]]; then
          is_excluded=true
          break
        fi
      done
      
      if [[ "$is_excluded" == false ]]; then
        HAS_DAEMON_UPDATE=true
        DAEMON_CHANGED_FILES+=("$file")
        echo "   📝 $file"
      else
        echo "   ⏭️  跳过 (排除): $file"
      fi
    done
  fi
done

# 检查 gomod 文件
if [[ -f "go.mod" ]]; then
  if ! git diff --quiet "$MERGE_BASE" "$TO_BRANCH" -- go.mod go.sum 2>/dev/null; then
    HAS_DAEMON_UPDATE=true
    echo "✅ go.mod 或 go.sum 有改动:"
    echo "   📝 go.mod"
    echo "   📝 go.sum"
    DAEMON_CHANGED_FILES+=("go.mod")
    DAEMON_CHANGED_FILES+=("go.sum")
  fi
fi

# 显示最终结果
echo ""
echo "📋 检测结果总结:"
if [[ "$HAS_DAEMON_UPDATE" == true ]]; then
  echo "✅ 检测到 daemon 二进制更新"
  echo "📝 已更新的 daemon 文件:"
  for file in "${DAEMON_CHANGED_FILES[@]}"; do
    echo "   $file"
  done
else
  echo "❌ 未检测到 daemon 二进制更新"
  echo "   （仅有 test 文件、内部文档或非核心 daemon 代码改动）"
fi

echo ""
return 0

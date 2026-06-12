#!/bin/bash
# ================================================
# pocketctl 发布脚本
# 流程: develop → master → gitee push → github sync → tag
# ================================================
set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn()  { echo -e "${YELLOW}[!]${NC} $1"; }
step()  { echo -e "\n${CYAN}━━━ $1 ━━━${NC}"; }
error() { echo -e "${RED}[✗]${NC} $1"; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

# ─── 解析参数 ───
VERSION="${1:-}"
DRY_RUN=false
if [[ "$VERSION" == "--dry-run" ]]; then
  DRY_RUN=true
  VERSION=""
fi

# ─── 1. 检查状态 ───
step "1/7 检查仓库状态"

CURRENT_BRANCH=$(git branch --show-current)
if [[ "$CURRENT_BRANCH" != "develop" ]]; then
  warn "当前在 $CURRENT_BRANCH，切换到 develop..."
  git checkout develop
fi

# 确保 develop 是最新的
git fetch origin develop
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/develop)
if [[ "$LOCAL" != "$REMOTE" ]]; then
  warn "本地 develop 落后于 origin/develop，正在拉取..."
  git pull origin develop
fi

# 检查工作区
if ! git diff --quiet; then
  error "工作区有未提交的更改，请先提交或暂存"
fi

# ─── 2. 展示待发布内容 ───
step "2/7 待发布内容"

LAST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "none")
echo "  上一个 tag: ${LAST_TAG}"
echo ""
echo "  自 ${LAST_TAG} 以来的提交:"
echo "  ────────────────────────────────────────────"
git log ${LAST_TAG}..HEAD --oneline --no-merges 2>/dev/null || git log --oneline -10
echo "  ────────────────────────────────────────────"
echo ""
echo "  变更文件统计:"
git diff ${LAST_TAG}..HEAD --stat 2>/dev/null | tail -1 || echo "  (新仓库，无历史 tag)"

# ─── 3. 确定版本号 ───
step "3/7 版本号"

if [[ -z "$VERSION" ]]; then
  # 从 commit 推断版本号
  SUGGESTED=""
  LAST_VER=$(git tag -l 'v*' --sort=-v:refname | head -1 | sed 's/v//')
  if [[ -n "$LAST_VER" ]]; then
    IFS='.' read -ra PARTS <<< "$LAST_VER"
    MAJOR=${PARTS[0]}
    MINOR=${PARTS[1]}
    PATCH=${PARTS[2]}
    PATCH_NEXT=$((PATCH + 1))
    MINOR_NEXT=$((MINOR + 1))
    echo "  当前版本: v$LAST_VER"
    echo ""
    echo "  选择新版本号:"
    echo "    1) v$MAJOR.$MINOR.$PATCH_NEXT  (patch)"
    echo "    2) v$MAJOR.$MINOR_NEXT.0       (minor)"
    echo "    3) 手动输入"
    echo ""
    read -p "  请选择 [1]: " CHOICE
    CHOICE=${CHOICE:-1}
    case $CHOICE in
      1) VERSION="v$MAJOR.$MINOR.$PATCH_NEXT" ;;
      2) VERSION="v$MAJOR.$MINOR_NEXT.0" ;;
      3) read -p "  输入版本号 (如 v0.1.4): " VERSION ;;
      *) VERSION="v$MAJOR.$MINOR.$PATCH_NEXT" ;;
    esac
  else
    read -p "  输入版本号 (如 v0.1.0): " VERSION
  fi
fi

# 校验版本号格式
if ! echo "$VERSION" | grep -qE '^v[0-9]+\.[0-9]+\.[0-9]+$'; then
  error "版本号格式错误，应为 vX.Y.Z (如 v0.1.4)"
fi

# 检查 tag 是否已存在
if git tag -l "$VERSION" | grep -q "$VERSION"; then
  error "Tag $VERSION 已存在"
fi

# ─── 4. 确认 ───
step "4/7 确认发布"

echo "  分支:   develop → master"
echo "  版本:   $VERSION"
echo "  推送:   origin (gitee) + github"
echo ""

if [[ "$DRY_RUN" != true ]]; then
  read -p "  确认发布? [y/N]: " CONFIRM
  if [[ "$CONFIRM" != "y" && "$CONFIRM" != "Y" ]]; then
    error "已取消"
  fi
fi

# ─── 5. 合并到 master 并推送 ───
step "5/7 合并 develop → master"

git checkout master
git merge develop --no-edit
info "已合并到 master"

# 推送到 gitee
git push origin master
info "已推送 origin/master (gitee)"

# ─── 6. 同步到 GitHub ───
step "6/7 同步到 GitHub"

if [[ -f scripts/sync-github.sh ]]; then
  bash scripts/sync-github.sh
  info "GitHub 同步完成"
else
  warn "scripts/sync-github.sh 不存在，跳过"
fi

# ─── 7. 创建 Tag ───
step "7/7 创建 Tag ${VERSION}"

TAG_MSG="pocketctl ${VERSION}

$(git log ${LAST_TAG}..HEAD --oneline --no-merges 2>/dev/null | sed 's/^/  - /')"

git tag -a "$VERSION" -m "${TAG_MSG}"

# 推送到两个 remote
git push origin "$VERSION"
info "tag ${VERSION} → gitee"

git push github "$VERSION" 2>/dev/null && info "tag ${VERSION} → github" || warn "github tag 推送失败（可能已在 sync 中包含）"

# ─── 完成 ───
echo ""
echo -e "${GREEN}╔══════════════════════════════════════╗${NC}"
echo -e "${GREEN}║         发 布 完 成                  ║${NC}"
echo -e "${GREEN}╠══════════════════════════════════════╣${NC}"
echo -e "${GREEN}║${NC}  版本:  ${VERSION}"
echo -e "${GREEN}║${NC}  分支:  master"
echo -e "${GREEN}║${NC}  Gitee: ✓ origin/master"
echo -e "${GREEN}║${NC}  GitHub: ✓ github/master"
echo -e "${GREEN}║${NC}  Tag:   ✓ ${VERSION}"
echo -e "${GREEN}╚══════════════════════════════════════╝${NC}"
echo ""
echo "  线上部署: ssh root@39.106.218.47"
echo "    cd /opt/pocketctl && git pull && systemctl restart pocketctl-relay"
echo "    # 或等待 webhook 自动部署"

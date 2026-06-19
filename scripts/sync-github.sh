#!/bin/bash
set -euo pipefail

# ============================================
# sync-github.sh — 增量同步代码到 GitHub（白名单 + 持久化 git 历史）
#
# 优化点（vs 旧版全量重建）:
# 1. .github-sync 持久化（保留 .git 历史），git add -A 只 commit **改动文件**（非每次全量重建）
# 2. commit message 标明实际更新内容（改动文件清单 + gitee commit subjects），
#    不再用固定的 "sync: <date> from gitee"
#
# 用法: bash scripts/sync-github.sh [--dry-run]
# ============================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SYNC_DIR="${REPO_ROOT}/.github-sync"

GITHUB_REMOTE="github"
GITHUB_BRANCH="master"

# Colors
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()  { echo -e "${GREEN}[INFO]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && { DRY_RUN=true; info "Dry run mode — no push"; }

# Whitelist
SYNC_DIRS=(cmd/ internal/ relay/ web/ .github/ scripts/install-daemon.sh)
SYNC_FILES=(go.mod go.sum Makefile LICENSE README.md README.zh-CN.md .gitignore .github/workflows/release.yml)
EXCLUDE_PATTERNS=(node_modules dist .vite '*.log')

GITHUB_URL=$(cd "$REPO_ROOT" && git remote get-url "$GITHUB_REMOTE" 2>/dev/null || true)
[[ -z "$GITHUB_URL" ]] && error "GitHub remote '$GITHUB_REMOTE' not found. Run: git remote add github <url>"

# ---------- 1. Prepare persistent sync dir (keep .git history) ----------
if [[ ! -d "$SYNC_DIR/.git" ]]; then
  info "First-time init of .github-sync"
  rm -rf "$SYNC_DIR"
  mkdir -p "$SYNC_DIR"
  cd "$SYNC_DIR"
  git init -q
  CRED_HELPER=$("$REPO_ROOT/.git" config --get credential.helper 2>/dev/null || true)
  [[ -n "$CRED_HELPER" ]] && git config credential.helper "$CRED_HELPER"
  for helper in osxkeychain store cache; do
    if git config --global --get credential.helper 2>/dev/null | grep -q "$helper"; then
      git config credential.helper "$helper"; break
    fi
  done
  git config user.email "muwb@users.noreply.github.com"
  git config user.name "muwb"
  git checkout -b "$GITHUB_BRANCH" 2>/dev/null || git checkout "$GITHUB_BRANCH" 2>/dev/null || true
  git remote add origin "$GITHUB_URL"
  # Adopt existing GitHub history if present (keeps commit chain continuous)
  if git fetch origin "$GITHUB_BRANCH" 2>/dev/null; then
    git reset --hard "origin/$GITHUB_BRANCH" 2>/dev/null && info "  adopted existing GitHub history" || info "  fresh history"
  fi
else
  info ".github-sync exists — reusing persistent git history"
  cd "$SYNC_DIR"
  # Pull remote latest so local mirrors GitHub (avoids divergence)
  git fetch origin "$GITHUB_BRANCH" 2>/dev/null && git reset --hard "origin/$GITHUB_BRANCH" 2>/dev/null && info "  synced with remote" || info "  using local state"
fi

# ---------- 2. Clear whitelist content (keep .git), then re-copy ----------
cd "$SYNC_DIR"
# Remove everything except .git (persistent history stays)
find . -maxdepth 1 ! -name '.git' ! -name '.' -exec rm -rf {} + 2>/dev/null || true

cd "$REPO_ROOT"
for dir in "${SYNC_DIRS[@]}"; do
  if [[ -e "${REPO_ROOT}/${dir}" ]]; then
    mkdir -p "${SYNC_DIR}/$(dirname "$dir")"
    cp -a "${REPO_ROOT}/${dir}" "${SYNC_DIR}/${dir}"
    info "  copied: ${dir}"
  else
    warn "  skipped (not found): ${dir}"
  fi
done
for file in "${SYNC_FILES[@]}"; do
  if [[ -f "${REPO_ROOT}/${file}" ]]; then
    mkdir -p "${SYNC_DIR}/$(dirname "$file")"
    cp "${REPO_ROOT}/${file}" "${SYNC_DIR}/${file}"
    info "  copied: ${file}"
  else
    warn "  skipped (not found): ${file}"
  fi
done

# Remove build artifacts
cd "$SYNC_DIR"
for pattern in "${EXCLUDE_PATTERNS[@]}"; do
  find . -type d -name "$pattern" -exec rm -rf {} + 2>/dev/null || true
  find . -type f -name "$pattern" -delete 2>/dev/null || true
done

# Strip landing page content from README (landing is not open-source)
if [[ -f "README.md" ]]; then
  sed -i '' '/🏠 \*\*Landing Page\*\*/d' README.md 2>/dev/null || sed -i '/🏠 \*\*Landing Page\*\*/d' README.md
  sed -i '' '/\*\*Landing\*\*/d' README.md 2>/dev/null || sed -i '/\*\*Landing\*\*/d' README.md
  sed -i '' '/├── landing\//,/nginx-docker\.conf/d' README.md 2>/dev/null || sed -i '/├── landing\//,/nginx-docker\.conf/d' README.md
  sed -i '' '/landing\//d' README.md 2>/dev/null || sed -i '/landing\//d' README.md
  info "  stripped landing page content from README.md"
fi

# ---------- 3. Sensitive information scan ----------
info "Scanning for sensitive information..."
SENSITIVE_PATTERNS=(
  '39\.106\.218\.47'
  'd2a111[0-9a-f]{30,}'
  'pocketctl_prod_2026'
  '2661504'
  '北京乐呵乐呵'
  'dev-secret-change-in-production'
)
for pattern in "${SENSITIVE_PATTERNS[@]}"; do
  matches=$(grep -rlE "$pattern" . 2>/dev/null || true)
  if [[ -n "$matches" ]]; then
    error "Sensitive data found! Pattern: ${pattern}\n${matches}"
  fi
done
info "Security scan passed ✓"

# ---------- 4. Stage changes (add + modify + delete) ----------
git add -A

if git diff --cached --quiet; then
  info "No changes to sync — GitHub already up to date."
  cd "$REPO_ROOT"
  exit 0
fi

# ---------- 5. Build meaningful commit message ----------
CHANGED_FILES=$(git diff --cached --name-only)
CHANGED_COUNT=$(echo "$CHANGED_FILES" | wc -l | tr -d ' ')
CHANGED_DIRS=$(echo "$CHANGED_FILES" | awk -F/ '{print $1}' | sort -u | tr '\n' ' ' | sed 's/ $//')

# Gitee commits since last sync (last .github-sync commit timestamp).
# Use `git log -20` (max-count) instead of `| head -20` — head closes the pipe early,
# git log gets SIGPIPE, and `set -o pipefail` kills the script (was EXIT 141).
LAST_SYNC_TIME=$(git log -1 --format=%ci 2>/dev/null | awk '{print $1" "$2}' || echo "1 week ago")
GITEE_COMMITS=$(cd "$REPO_ROOT" && git log --since="$LAST_SYNC_TIME" -20 --pretty=format:"- %s" --no-merges 2>/dev/null || true)
[[ -z "$GITEE_COMMITS" ]] && GITEE_COMMITS="- (whitelist/content drift, no new gitee commits matched)"

# File list (cap at 30 lines)
FILES_LIST=$(echo "$CHANGED_FILES" | head -30 || true)
if [[ $CHANGED_COUNT -gt 30 ]]; then
  FILES_LIST="${FILES_LIST}
... ($(($CHANGED_COUNT - 30)) more)"
fi

COMMIT_MSG="sync: ${CHANGED_COUNT} files (${CHANGED_DIRS}) from gitee

Changed files:
${FILES_LIST}

Gitee commits since last sync:
${GITEE_COMMITS}"

info "Commit message preview:"
echo "$COMMIT_MSG" | sed 's/^/  | /'

if $DRY_RUN; then
  info "Dry run complete — ${CHANGED_COUNT} files would be pushed"
  cd "$REPO_ROOT"
  exit 0
fi

# ---------- 6. Commit + push ----------
git commit -q -m "$COMMIT_MSG"
info "Committed ${CHANGED_COUNT} changed files"

info "Pushing to GitHub (${GITHUB_BRANCH})..."
git push -f origin "$GITHUB_BRANCH"
info "Sync complete ✓"

cd "$REPO_ROOT"

#!/bin/bash
set -euo pipefail

# ============================================
# sync-github.sh — 白名单同步代码到 GitHub
#
# 从 Gitee 仓库同步指定文件/目录到 GitHub 仓库。
# 推送前自动扫描敏感信息。
#
# 用法: bash scripts/sync-github.sh [--dry-run]
# ============================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SYNC_DIR="${REPO_ROOT}/.github-sync"

# GitHub remote name
GITHUB_REMOTE="github"
GITHUB_BRANCH="master"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# ---------- Parse args ----------
DRY_RUN=false
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
  info "Dry run mode — no changes will be pushed"
fi

# ---------- Whitelist: directories to sync ----------
SYNC_DIRS=(
  cmd/
  internal/
  relay/
  web/
  .github/
  scripts/install-daemon.sh
)

# ---------- Whitelist: individual files to sync ----------
SYNC_FILES=(
  go.mod
  go.sum
  Makefile
  LICENSE
  README.md
  README.zh-CN.md
  .gitignore
  .github/workflows/release.yml
)

# ---------- Exclude patterns (applied after copy) ----------
EXCLUDE_PATTERNS=(
  node_modules
  dist
  .vite
  '*.log'
)

# ---------- 1. Prepare sync directory ----------
info "Preparing sync directory: ${SYNC_DIR}"

if [[ -d "$SYNC_DIR" ]]; then
  rm -rf "$SYNC_DIR"
fi

mkdir -p "$SYNC_DIR"

# Copy whitelisted directories
for dir in "${SYNC_DIRS[@]}"; do
  if [[ -e "${REPO_ROOT}/${dir}" ]]; then
    mkdir -p "${SYNC_DIR}/$(dirname "$dir")"
    cp -a "${REPO_ROOT}/${dir}" "${SYNC_DIR}/${dir}"
    info "  copied: ${dir}"
  else
    warn "  skipped (not found): ${dir}"
  fi
done

# Copy whitelisted files
for file in "${SYNC_FILES[@]}"; do
  if [[ -f "${REPO_ROOT}/${file}" ]]; then
    mkdir -p "${SYNC_DIR}/$(dirname "$file")"
    cp "${REPO_ROOT}/${file}" "${SYNC_DIR}/${file}"
    info "  copied: ${file}"
  else
    warn "  skipped (not found): ${file}"
  fi
done

# Remove build artifacts and dependencies
for pattern in "${EXCLUDE_PATTERNS[@]}"; do
  find "$SYNC_DIR" -type d -name "$pattern" -exec rm -rf {} + 2>/dev/null || true
  find "$SYNC_DIR" -type f -name "$pattern" -delete 2>/dev/null || true
done

# Strip landing page content from README (landing is not open-source)
if [[ -f "${SYNC_DIR}/README.md" ]]; then
  sed -i '' '/🏠 \*\*Landing Page\*\*/d' "${SYNC_DIR}/README.md" 2>/dev/null || sed -i '/🏠 \*\*Landing Page\*\*/d' "${SYNC_DIR}/README.md"
  sed -i '' '/\*\*Landing\*\*/d' "${SYNC_DIR}/README.md" 2>/dev/null || sed -i '/\*\*Landing\*\*/d' "${SYNC_DIR}/README.md"
  sed -i '' '/├── landing\//,/nginx-docker\.conf/d' "${SYNC_DIR}/README.md" 2>/dev/null || sed -i '/├── landing\//,/nginx-docker\.conf/d' "${SYNC_DIR}/README.md"
  sed -i '' '/landing\//d' "${SYNC_DIR}/README.md" 2>/dev/null || sed -i '/landing\//d' "${SYNC_DIR}/README.md"
  info "  stripped landing page content from README.md"
fi

# ---------- 2. Sensitive information scan ----------
info "Scanning for sensitive information..."

SENSITIVE_PATTERNS=(
  '39\.106\.218\.47'
  'd2a111[0-9a-f]{30,}'
  'pocketctl_prod_2026'
  '2661504'
  '北京乐呵乐呵'
  'dev-secret-change-in-production'
)

FOUND_SECRETS=false
for pattern in "${SENSITIVE_PATTERNS[@]}"; do
  matches=$(grep -rlE "$pattern" "$SYNC_DIR" 2>/dev/null || true)
  if [[ -n "$matches" ]]; then
    error "Sensitive data found! Pattern: ${pattern}"
    echo "$matches"
    FOUND_SECRETS=true
  fi
done

if $FOUND_SECRETS; then
  error "Aborting: sensitive information detected. Fix before pushing."
fi

info "Security scan passed ✓"

# ---------- 3. Dry run exit ----------
if $DRY_RUN; then
  info "Dry run complete. Files prepared in ${SYNC_DIR}"
  info "Run without --dry-run to push to GitHub."
  exit 0
fi

# ---------- 4. Initialize git in sync dir ----------
info "Initializing git repo in sync directory..."

cd "$SYNC_DIR"
git init

# Copy credential helper from main repo so GitHub auth works
CRED_HELPER=$("$REPO_ROOT/.git" config --get credential.helper 2>/dev/null || true)
if [[ -n "$CRED_HELPER" ]]; then
  git config credential.helper "$CRED_HELPER"
fi
# Also try copying osxkeychain or store if available
for helper in osxkeychain store cache; do
  if git config --global --get credential.helper | grep -q "$helper" 2>/dev/null; then
    git config credential.helper "$helper"
    break
  fi
done

git config user.email "pocketctl-bot@users.noreply.github.com"
git config user.name "pocketctl-bot"
git checkout -b "$GITHUB_BRANCH"

# Add all files
git add -A

# Check if there are changes to commit
if git diff --cached --quiet; then
  info "No changes to sync."
  rm -rf "$SYNC_DIR"
  exit 0
fi

# Commit
COMMIT_MSG="sync: $(date '+%Y-%m-%d %H:%M:%S') from gitee"
git commit -m "$COMMIT_MSG"

# ---------- 5. Push to GitHub ----------
info "Pushing to GitHub (${GITHUB_REMOTE} ${GITHUB_BRANCH})..."

# Add GitHub remote
GITHUB_URL=$(cd "$REPO_ROOT" && git remote get-url "$GITHUB_REMOTE" 2>/dev/null || true)
if [[ -z "$GITHUB_URL" ]]; then
  error "GitHub remote '${GITHUB_REMOTE}' not found. Run: git remote add github https://github.com/pocketctl/pocketctl.git"
fi

git remote add origin "$GITHUB_URL"

# Force push to keep GitHub in sync (this is the only consumer)
git push -f origin "$GITHUB_BRANCH"

info "Sync complete ✓"

# Cleanup
cd "$REPO_ROOT"
rm -rf "$SYNC_DIR"

#!/bin/bash
set -euo pipefail

# ============================================
# pocketctl Daemon 一键安装脚本
# 用法: curl -fsSL https://pocketctl.me/install.sh | bash
#
# 支持参数:
#   --prod      安装生产版本（写入 prod_relay_url 到配置，需设置 POCKETCTL_PROD_RELAY_URL）
#   --version   指定版本号（默认最新）
# ============================================

GITHUB_REPO="pocketctl/pocketctl"
GITEE_REPO="muwb123/pocketctl"
INSTALL_DIR="/usr/local/bin"
BINARY_NAME="pocketctl"
PROD_RELAY="${POCKETCTL_PROD_RELAY_URL:-}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# ---------- 参数解析 ----------
IS_PRODUCTION=false
CUSTOM_VERSION=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --prod) IS_PRODUCTION=true; shift ;;
    --version) CUSTOM_VERSION="$2"; shift 2 ;;
    --help|-h)
      echo "用法: curl -fsSL https://pocketctl.me/install.sh | bash [--prod] [--version v0.1.0]"
      exit 0
      ;;
    *) error "未知参数: $1 (支持: --prod, --version)" ;;
  esac
done

# ---------- 1. 系统检查 ----------
info "检测系统环境..."

OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Darwin) OS="darwin" ;;
  Linux)  OS="linux"  ;;
  *)      error "不支持的操作系统: $OS (仅支持 macOS 和 Linux)" ;;
esac

case "$ARCH" in
  x86_64|amd64) ARCH="amd64" ;;
  arm64|aarch64) ARCH="arm64" ;;
  *)            error "不支持的架构: $ARCH (仅支持 x86_64 和 arm64)" ;;
esac

info "系统: ${OS}/${ARCH}"

if $IS_PRODUCTION; then
  if [[ -z "$PROD_RELAY" ]]; then
    error "--prod requires POCKETCTL_PROD_RELAY_URL env var. Example: POCKETCTL_PROD_RELAY_URL=ws://pocketctl.me/ws bash install-daemon.sh --prod"
  fi
  info "模式: 生产环境 (relay: ${PROD_RELAY})"
else
  info "模式: 测试环境 (本地开发)"
fi

# ---------- 2. 获取最新版本 ----------
LATEST_VERSION="$CUSTOM_VERSION"

if [[ -z "$LATEST_VERSION" ]]; then
  info "获取最新版本..."

  if command -v curl &>/dev/null; then
    # Try GitHub API first
    LATEST_VERSION=$(curl -fsSL "https://api.github.com/repos/${GITHUB_REPO}/releases/latest" 2>/dev/null \
      | grep -oE '"tag_name"\s*:\s*"[^"]+"' | head -1 | grep -oE '"[^"]+"\s*$' | tr -d '"' | tr -d ' ' || true)
    # Fallback: try Gitee API
    if [[ -z "$LATEST_VERSION" ]]; then
      LATEST_VERSION=$(curl -fsSL "https://gitee.com/api/v5/repos/muwb123/pocketctl/releases/latest" 2>/dev/null \
        | grep -oE '"tag_name"\s*:\s*"[^"]+"' | head -1 | grep -oE '"[^"]+"\s*$' | tr -d '"' | tr -d ' ' || true)
    fi
  fi

  if [[ -z "$LATEST_VERSION" ]]; then
    LATEST_VERSION="v0.1.0"
    warn "无法获取最新版本，使用默认: ${LATEST_VERSION}"
  else
    info "最新版本: ${LATEST_VERSION}"
  fi
fi

# ---------- 3. 下载二进制 ----------
BINARY_FILENAME="pocketctl_${OS}_${ARCH}"
TEMP_FILE=$(mktemp)
EXPECTED_SHA=""

info "下载 ${BINARY_FILENAME}..."

download_binary() {
  local url="$1"
  # Show a live percentage progress bar when stderr is a terminal; otherwise
  # (e.g. `curl ... | bash`, or output redirected to a log) stay silent so we
  # don't fill logs with hundreds of progress frames. curl writes its # bar to
  # stderr and falls back to a plain meter automatically when not on a TTY.
  local show_progress=""
  if [[ -t 2 ]]; then
    show_progress=1
  fi
  if command -v curl &>/dev/null; then
    if [[ -n "$show_progress" ]]; then
      curl -fL --progress-bar -o "$TEMP_FILE" "$url"
    else
      curl -fsSL -o "$TEMP_FILE" "$url" 2>/dev/null
    fi
  elif command -v wget &>/dev/null; then
    if [[ -n "$show_progress" ]]; then
      # bar:force keeps the bar even when wget thinks it's not on a TTY
      wget --show-progress --progress=bar:force -O "$TEMP_FILE" "$url"
    else
      wget -q -O "$TEMP_FILE" "$url" 2>/dev/null
    fi
  else
    error "需要 curl 或 wget"
  fi
}

# Try GitHub releases first, then Gitee
GITHUB_URL="https://github.com/${GITHUB_REPO}/releases/download/${LATEST_VERSION}/${BINARY_FILENAME}"
GITEE_URL="https://gitee.com/${GITEE_REPO}/releases/download/${LATEST_VERSION}/${BINARY_FILENAME}"

if download_binary "$GITHUB_URL"; then
  info "从 GitHub 下载成功"
elif download_binary "$GITEE_URL"; then
  info "从 Gitee 下载成功"
else
  rm -f "$TEMP_FILE"
  error "下载失败: 尝试了 GitHub 和 Gitee 源"
fi

# ---------- 4. 校验（如果存在 SHA256 文件） ----------
if [[ -n "$EXPECTED_SHA" ]]; then
  ACTUAL_SHA=""
  if command -v shasum &>/dev/null; then
    ACTUAL_SHA=$(shasum -a 256 "$TEMP_FILE" | awk '{print $1}')
  elif command -v sha256sum &>/dev/null; then
    ACTUAL_SHA=$(sha256sum "$TEMP_FILE" | awk '{print $1}')
  fi

  if [[ -n "$ACTUAL_SHA" && "$ACTUAL_SHA" != "$EXPECTED_SHA" ]]; then
    rm -f "$TEMP_FILE"
    error "文件校验失败！SHA256 不匹配\n  期望: ${EXPECTED_SHA}\n  实际: ${ACTUAL_SHA}"
  elif [[ -n "$ACTUAL_SHA" ]]; then
    info "文件校验通过 ✓"
  fi
fi

# ---------- 5. 安装 ----------
info "安装到 ${INSTALL_DIR}/${BINARY_NAME}..."

if [[ "$OS" == "darwin" ]]; then
  # macOS
  if [[ -w "$INSTALL_DIR" ]]; then
    mv "$TEMP_FILE" "${INSTALL_DIR}/${BINARY_NAME}"
  else
    sudo mv "$TEMP_FILE" "${INSTALL_DIR}/${BINARY_NAME}"
    sudo chown root:wheel "${INSTALL_DIR}/${BINARY_NAME}"
  fi
else
  # Linux
  sudo mv "$TEMP_FILE" "${INSTALL_DIR}/${BINARY_NAME}"
  sudo chown root:root "${INSTALL_DIR}/${BINARY_NAME}"
fi

chmod +x "${INSTALL_DIR}/${BINARY_NAME}"

# ---------- 5.5 写入生产配置（--prod 模式） ----------
if $IS_PRODUCTION; then
  CONFIG_DIR="${HOME}/.pocketctl"
  AUTH_FILE="${CONFIG_DIR}/auth.json"
  mkdir -p "$CONFIG_DIR"

  # Read existing auth.json or start fresh
  if [[ -f "$AUTH_FILE" ]]; then
    # Use python to update prod_relay_url while preserving other fields
    if command -v python3 &>/dev/null; then
      python3 -c "
import json, sys
with open('${AUTH_FILE}', 'r') as f:
    data = json.load(f)
data['prod_relay_url'] = '${PROD_RELAY}'
with open('${AUTH_FILE}', 'w') as f:
    json.dump(data, f, indent=2)
"
    elif command -v node &>/dev/null; then
      node -e "
const fs = require('fs');
const path = '${AUTH_FILE}';
let data = {};
try { data = JSON.parse(fs.readFileSync(path, 'utf8')); } catch {}
data.prod_relay_url = '${PROD_RELAY}';
fs.writeFileSync(path, JSON.stringify(data, null, 2));
"
    else
      # Fallback: write minimal JSON
      echo "{\"prod_relay_url\":\"${PROD_RELAY}\"}" > "$AUTH_FILE"
    fi
  else
    echo "{\"prod_relay_url\":\"${PROD_RELAY}\"}" > "$AUTH_FILE"
  fi
  chmod 600 "$AUTH_FILE"
  info "生产配置已写入 ${AUTH_FILE}"
fi

# ---------- 6. 验证 ----------
INSTALLED_VERSION=$(${INSTALL_DIR}/${BINARY_NAME} version 2>/dev/null || echo "unknown")

echo ""
echo -e "${GREEN}============================================${NC}"
echo -e "${GREEN}  pocketctl 安装成功！${NC}"
echo -e "${GREEN}============================================${NC}"
echo ""
echo -e "  📦 版本: ${BLUE}${INSTALLED_VERSION}${NC}"
echo -e "  📍 路径: ${INSTALL_DIR}/${BINARY_NAME}"
echo -e "  🔗 环境: $($IS_PRODUCTION && echo '生产' || echo '测试')"
echo ""

# ---------- 7. 引导说明 ----------
echo -e "  ${YELLOW}快速开始:${NC}"
echo ""
if $IS_PRODUCTION; then
  echo "  # 1. 登录（使用 App 注册的手机号）"
  echo "  pocketctl login --prod"
  echo ""
  echo "  # 2. 启动守护进程"
  echo "  pocketctl daemon start --prod"
else
  echo "  # 1. 登录（使用 App 注册的手机号）"
  echo "  pocketctl login"
  echo ""
  echo "  # 2. 启动守护进程（先确保 Relay 已在本地启动）"
  echo "  pocketctl daemon start"
fi
echo ""
echo "  # 3. 查看状态"
echo "  pocketctl daemon status"
echo ""
echo "  # 4. 查看日志"
echo "  pocketctl daemon logs"
echo ""
echo -e "  ${BLUE}Homebrew 安装方式:${NC}"
echo "  brew tap pocketctl/tap"
echo "  brew install pocketctl"
echo ""

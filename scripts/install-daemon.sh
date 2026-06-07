#!/bin/bash
set -euo pipefail

# ============================================
# pocketctl Daemon 一键安装脚本
# 用法: curl -fsSL https://pocketctl.com/install.sh | bash
# ============================================

GITHUB_REPO="pocketctl/pocketctl"
INSTALL_DIR="/usr/local/bin"
BINARY_NAME="pocketctl"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# ---------- 1. 系统检查 ----------
info "检测系统环境..."

OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Darwin) OS="darwin" ;;
  Linux)  OS="linux" ;;
  *)      error "不支持的操作系统: $OS (仅支持 macOS 和 Linux)" ;;
esac

case "$ARCH" in
  x86_64|amd64) ARCH="amd64" ;;
  arm64|aarch64) ARCH="arm64" ;;
  *)            error "不支持的架构: $ARCH" ;;
esac

info "系统: ${OS}/${ARCH}"

# ---------- 2. 获取最新版本 ----------
info "获取最新版本..."

# 尝试从 GitHub API 获取
LATEST_VERSION=""
if command -v curl &>/dev/null; then
  LATEST_VERSION=$(curl -fsSL "https://api.github.com/repos/${GITHUB_REPO}/releases/latest" 2>/dev/null | grep '"tag_name"' | head -1 | sed -E 's/.*"tag_name":\s*"([^"]+)".*/\1/' || true)
fi

if [[ -z "$LATEST_VERSION" ]]; then
  LATEST_VERSION="v0.1.0"
  warn "无法获取最新版本，使用默认: ${LATEST_VERSION}"
else
  info "最新版本: ${LATEST_VERSION}"
fi

# ---------- 3. 下载二进制 ----------
BINARY_URL="https://github.com/${GITHUB_REPO}/releases/download/${LATEST_VERSION}/pocketctl_${OS}_${ARCH}"
TEMP_FILE=$(mktemp)

info "下载 pocketctl ${LATEST_VERSION} (${OS}/${ARCH})..."

if command -v curl &>/dev/null; then
  curl -fsSL -o "$TEMP_FILE" "$BINARY_URL" || error "下载失败: $BINARY_URL"
elif command -v wget &>/dev/null; then
  wget -q -O "$TEMP_FILE" "$BINARY_URL" || error "下载失败: $BINARY_URL"
else
  error "需要 curl 或 wget"
fi

# ---------- 4. 安装 ----------
info "安装到 ${INSTALL_DIR}/${BINARY_NAME}..."

if [[ "$OS" == "darwin" ]]; then
  # macOS: 可能需要 sudo
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

# ---------- 5. 验证 ----------
INSTALLED_VERSION=$(${INSTALL_DIR}/${BINARY_NAME} version 2>/dev/null || echo "unknown")

echo ""
echo -e "${GREEN}============================================${NC}"
echo -e "${GREEN}  pocketctl 安装成功！${NC}"
echo -e "${GREEN}============================================${NC}"
echo ""
echo -e "  📦 版本: ${BLUE}${INSTALLED_VERSION}${NC}"
echo -e "  📍 路径: ${INSTALL_DIR}/${BINARY_NAME}"
echo ""
echo -e "  ${YELLOW}快速开始:${NC}"
echo ""
echo "  # 1. 启动守护进程（连接到你的 Relay）"
echo "  pocketctl daemon start --relay wss://your-domain.com/ws --api-key YOUR_KEY"
echo ""
echo "  # 2. 查看状态"
echo "  pocketctl daemon status"
echo ""
echo "  # 3. 查看日志"
echo "  pocketctl daemon logs"
echo ""
echo -e "  ${BLUE}Homebrew 安装方式:${NC}"
echo "  brew tap pocketctl/tap"
echo "  brew install pocketctl"
echo ""

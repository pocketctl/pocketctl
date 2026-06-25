#!/bin/bash
# pocketctl Daemon 安装脚本
# 用法: curl -fsSL https://www.pocketctl.me/install.sh | bash

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# GitHub 下载地址（国内自动走 gh-proxy.com 加速，不可用时降级直连）
REPO="pocketctl/pocketctl"
GH_DL="https://github.com/${REPO}/releases/latest/download"
GH_PROXY="https://gh-proxy.com/"
RELAY_URL="wss://www.pocketctl.me/ws"

echo -e "${GREEN}╔══════════════════════════════════════╗${NC}"
echo -e "${GREEN}║     pocketctl Daemon 安装程序        ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════╝${NC}"
echo ""

# 检测 OS
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)

case "$OS" in
    darwin) PLATFORM="darwin" ;;
    linux)  PLATFORM="linux" ;;
    *)
        echo -e "${RED}不支持的操作系统: $OS${NC}"
        exit 1
        ;;
esac

case "$ARCH" in
    arm64|aarch64) ARCH="arm64" ;;
    x86_64|amd64)  ARCH="amd64" ;;
    *)
        echo -e "${RED}不支持的架构: $ARCH${NC}"
        exit 1
        ;;
esac

BINARY="pocketctl_${PLATFORM}_${ARCH}"
echo -e "检测到平台: ${GREEN}${PLATFORM}/${ARCH}${NC}"

# 下载到临时文件，再安装到 /usr/local/bin（需要时用 sudo）
INSTALL_DIR="/usr/local/bin"
TMP_FILE=$(mktemp)
trap 'rm -f "$TMP_FILE"' EXIT

# 下载函数：curl 优先，wget 兜底
download() {
    local url="$1"
    if command -v curl &> /dev/null; then
        curl --connect-timeout 10 --max-time 120 -fsSL "$url" -o "$TMP_FILE" 2>/dev/null && return 0
    elif command -v wget &> /dev/null; then
        wget --timeout=10 --tries=1 -q "$url" -O "$TMP_FILE" 2>/dev/null && return 0
    fi
    return 1
}

# 1) 国内加速代理 → 2) GitHub 直连
GH_URL="${GH_DL}/${BINARY}"
echo -e "${YELLOW}正在下载 pocketctl...${NC}"
if ! download "${GH_PROXY}${GH_URL}"; then
    echo -e "${YELLOW}加速代理不可用，尝试 GitHub 直连...${NC}"
    if ! download "${GH_URL}"; then
        echo -e "${RED}下载失败：请检查网络或稍后重试${NC}"
        exit 1
    fi
fi

# 写入 /usr/local/bin（目录不可写时用 sudo）
if [ -w "$INSTALL_DIR" ]; then
    SUDO=""
else
    echo -e "${YELLOW}安装到 ${INSTALL_DIR} 需要 root 权限，将使用 sudo（可能提示密码）${NC}"
    SUDO="sudo"
fi
$SUDO install -m 0755 "$TMP_FILE" "${INSTALL_DIR}/pocketctl"

echo -e "${GREEN}✓ pocketctl 已安装到 ${INSTALL_DIR}/pocketctl${NC}"
echo ""

# 提示登录
echo -e "${YELLOW}下一步:${NC}"
echo -e "  1. 登录: ${GREEN}pocketctl login --relay ${RELAY_URL}${NC}"
echo -e "  2. 启动: ${GREEN}pocketctl daemon start${NC}"
echo ""
echo -e "更多信息: https://github.com/${REPO}"

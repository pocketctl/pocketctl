#!/bin/bash
# pocketctl Daemon 安装脚本
# 用法: curl -fsSL https://www.pocketctl.me/install.sh | bash

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

REPO="muwb123/pocketctl"
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

# 获取最新版本
echo -e "${YELLOW}正在获取最新版本...${NC}"
LATEST_URL="https://github.com/${REPO}/releases/latest/download/${BINARY}"

# 下载
INSTALL_DIR="/usr/local/bin"
echo -e "${YELLOW}正在下载 pocketctl...${NC}"

if command -v curl &> /dev/null; then
    curl -fsSL "$LATEST_URL" -o "${INSTALL_DIR}/pocketctl"
elif command -v wget &> /dev/null; then
    wget -q "$LATEST_URL" -O "${INSTALL_DIR}/pocketctl"
else
    echo -e "${RED}需要 curl 或 wget，请先安装${NC}"
    exit 1
fi

chmod +x "${INSTALL_DIR}/pocketctl"

echo -e "${GREEN}✓ pocketctl 已安装到 ${INSTALL_DIR}/pocketctl${NC}"
echo ""

# 提示登录
echo -e "${YELLOW}下一步:${NC}"
echo -e "  1. 登录: ${GREEN}pocketctl login --relay ${RELAY_URL}${NC}"
echo -e "  2. 启动: ${GREEN}pocketctl daemon start${NC}"
echo ""
echo -e "更多信息: https://github.com/${REPO}"

#!/bin/bash
# pocketctl Daemon 安装脚本
# 用法: curl -fsSL https://www.pocketctl.me/install.sh | bash

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# GitHub 下载地址（国内自动走多个加速代理轮询，全部不可用时降级直连）
REPO="pocketctl/pocketctl"
GH_DL="https://github.com/${REPO}/releases/latest/download"
RELAY_URL="wss://www.pocketctl.me/ws"

# 国内加速代理（公益镜像，按顺序尝试；任一可用即可，避免单点故障）
# 与 internal/update/updater.go 的 ghProxies 保持一致。
GH_PROXIES=(
    "https://gh-proxy.com/"
    "https://ghfast.top/"
    "https://ghproxy.net/"
)

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
# 连接超时 8s，整体 60s —— 快速失败后立即切换下一个源，不让坏代理拖住整个安装。
download() {
    local url="$1"
    if command -v curl &> /dev/null; then
        curl --connect-timeout 8 --max-time 60 -fsSL "$url" -o "$TMP_FILE" 2>/dev/null && return 0
    elif command -v wget &> /dev/null; then
        wget --timeout=8 --tries=1 -q "$url" -O "$TMP_FILE" 2>/dev/null && return 0
    fi
    return 1
}

# 按优先级依次尝试：各公益代理 → GitHub 直连
GH_URL="${GH_DL}/${BINARY}"
SOURCES=()
for p in "${GH_PROXIES[@]}"; do
    SOURCES+=("${p}${GH_URL}")
done
SOURCES+=("${GH_URL}")

echo -e "${YELLOW}正在下载 pocketctl...${NC}"
DOWNLOADED=0
for url in "${SOURCES[@]}"; do
    if download "$url"; then
        DOWNLOADED=1
        break
    fi
    echo -e "${YELLOW}  ✗ 该源不可用，切换下一个...${NC}"
done

if [ "$DOWNLOADED" -ne 1 ]; then
    echo -e "${RED}下载失败：所有源均不可用，请检查网络或稍后重试${NC}"
    exit 1
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

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
INSTALL_DIR="${POCKETCTL_INSTALL_DIR:-/usr/local/bin}"
TMP_FILE=$(mktemp)
SHA_FILE=$(mktemp)
trap 'rm -f "$TMP_FILE" "$SHA_FILE"' EXIT

# 是否在交互式终端（决定是否显示进度条）
# curl/wget 的进度信息写到 stderr，因此检测 fd 2 ——
# 这样即便用户用 `curl | bash` 安装（stdout 是管道），仍能看到下载进度。
is_tty() {
    [ -t 2 ]
}

# 下载函数：curl 优先，wget 兜底
# 连接超时 8s，整体 60s —— 快速失败后立即切换下一个源，不让坏代理拖住整个安装。
# 在交互式终端显示进度条，非交互（如管道）保持静默，避免日志噪音。
download() {
    local url="$1"
    local destination="$2"
    local progress_opts=()
    if is_tty; then
        progress_opts=("--progress-bar")
    else
        progress_opts=("--silent" "--show-error")
    fi
    if command -v curl &> /dev/null; then
        curl --connect-timeout 8 --max-time 60 -fsSL "${progress_opts[@]}" "$url" -o "$destination" && return 0
    elif command -v wget &> /dev/null; then
        local wopts=(--timeout=8 --tries=1)
        if is_tty; then wopts+=(--show-progress); else wopts+=(--quiet); fi
        wget "${wopts[@]}" "$url" -O "$destination" && return 0
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

# H-5: 镜像只承载字节，不承载信任。校验值必须先从 GitHub 官方直连取得；
# 官方校验文件不可达时直接中止，绝不降级到与二进制同源的镜像 checksum。
if ! download "${GH_URL}.sha256" "$SHA_FILE"; then
    echo -e "${RED}无法建立可信校验链：GitHub 官方校验文件不可达，已中止安装${NC}"
    exit 1
fi
EXPECTED_SHA=$(awk 'NR == 1 { print $1 }' "$SHA_FILE")
if [[ ! "$EXPECTED_SHA" =~ ^[0-9a-fA-F]{64}$ ]]; then
    echo -e "${RED}官方校验文件格式无效，已中止安装${NC}"
    exit 1
fi
EXPECTED_SHA_LOWER=$(printf '%s' "$EXPECTED_SHA" | tr '[:upper:]' '[:lower:]')

if command -v shasum &>/dev/null; then
    SHA_TOOL=(shasum -a 256)
elif command -v sha256sum &>/dev/null; then
    SHA_TOOL=(sha256sum)
else
    echo -e "${RED}缺少 shasum 或 sha256sum，无法安全安装${NC}"
    exit 1
fi

verify_against_official() {
    ACTUAL_SHA=$("${SHA_TOOL[@]}" "$TMP_FILE" | awk '{print $1}')
    ACTUAL_SHA_LOWER=$(printf '%s' "$ACTUAL_SHA" | tr '[:upper:]' '[:lower:]')
    [[ "$ACTUAL_SHA_LOWER" == "$EXPECTED_SHA_LOWER" ]]
}

echo -e "${YELLOW}正在下载 pocketctl...${NC}"
DOWNLOADED=0
for url in "${SOURCES[@]}"; do
    if download "$url" "$TMP_FILE" && verify_against_official; then
        DOWNLOADED=1
        break
    fi
    : > "$TMP_FILE"
    echo -e "${YELLOW}  ✗ 该源不可用或未通过官方校验，切换下一个...${NC}"
done

if [ "$DOWNLOADED" -ne 1 ]; then
    echo -e "${RED}下载失败：没有源能提供与官方校验一致的文件，已中止安装${NC}"
    exit 1
fi
echo -e "${GREEN}✓ 官方 SHA256 校验通过${NC}"

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
echo -e "  1. 登录: ${GREEN}pocketctl login${NC}"
echo -e "  2. 启动: ${GREEN}pocketctl daemon start${NC}"
echo ""
echo -e "更多信息: https://github.com/${REPO}"

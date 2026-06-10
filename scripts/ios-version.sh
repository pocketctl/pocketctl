#!/bin/bash
# pocketctl iOS 版本号管理
# 用法:
#   bash scripts/ios-version.sh                # 显示当前版本
#   bash scripts/ios-version.sh patch           # 0.1.0 → 0.1.1
#   bash scripts/ios-version.sh minor           # 0.1.0 → 0.2.0
#   bash scripts/ios-version.sh major           # 0.1.0 → 1.0.0
#   bash scripts/ios-version.sh set 1.2.3      # 设置指定版本
#   bash scripts/ios-version.sh build           # build number +1
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
PBXPROJ="$PROJECT_ROOT/ios/Pocketctl.xcodeproj/project.pbxproj"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# 读取当前版本
get_version() {
    grep "MARKETING_VERSION" "$PBXPROJ" | head -1 | awk '{print $3}' | tr -d ';'
}

get_build() {
    grep "CURRENT_PROJECT_VERSION" "$PBXPROJ" | head -1 | awk '{print $3}' | tr -d ';'
}

# 更新 pbxproj 中的版本号
set_version() {
    local new_ver=$1
    sed -i '' "s/MARKETING_VERSION = .*/MARKETING_VERSION = $new_ver;/g" "$PBXPROJ"
}

set_build() {
    local new_build=$1
    sed -i '' "s/CURRENT_PROJECT_VERSION = .*/CURRENT_PROJECT_VERSION = $new_build;/g" "$PBXPROJ"
}

# 版本号递增
bump_version() {
    local current=$1
    local type=$2
    local major minor patch

    IFS='.' read -r major minor patch <<< "$current"

    case $type in
        major) echo "$((major + 1)).0.0" ;;
        minor) echo "$major.$((minor + 1)).0" ;;
        patch) echo "$major.$minor.$((patch + 1))" ;;
        *) echo "$current" ;;
    esac
}

# 主逻辑
CURRENT_VER=$(get_version)
CURRENT_BUILD=$(get_build)

case ${1:-""} in
    "")
        echo "当前版本: ${GREEN}$CURRENT_VER${NC} (${GREEN}$CURRENT_BUILD${NC})"
        echo ""
        echo "用法:"
        echo "  $0 patch        # 补丁版本 +1 (0.1.0 → 0.1.1)"
        echo "  $0 minor        # 次版本 +1   (0.1.0 → 0.2.0)"
        echo "  $0 major        # 主版本 +1   (0.1.0 → 1.0.0)"
        echo "  $0 set 1.2.3   # 设置指定版本"
        echo "  $0 build        # 构建号 +1"
        echo "  $0 tag          # 创建 git tag 并推送"
        ;;

    patch|minor|major)
        NEW_VER=$(bump_version "$CURRENT_VER" "$1")
        set_version "$NEW_VER"
        echo -e "${GREEN}✓ 版本更新: $CURRENT_VER → $NEW_VER${NC}"
        echo "  构建号保持: $CURRENT_BUILD"
        ;;

    set)
        if [ -z "$2" ]; then
            echo -e "${RED}用法: $0 set <version>${NC}"
            exit 1
        fi
        set_version "$2"
        echo -e "${GREEN}✓ 版本设置: $CURRENT_VER → $2${NC}"
        ;;

    build)
        NEW_BUILD=$((CURRENT_BUILD + 1))
        set_build "$NEW_BUILD"
        echo -e "${GREEN}✓ 构建号: $CURRENT_BUILD → $NEW_BUILD${NC}"
        ;;

    tag)
        TAG_VER="v$CURRENT_VER"
        echo -e "${YELLOW}创建 tag: $TAG_VER${NC}"
        git add "$PBXPROJ"
        git commit -m "release: bump version to $CURRENT_VER ($CURRENT_BUILD)" 2>/dev/null || true
        git tag -a "$TAG_VER" -m "Release $TAG_VER"
        git push origin "$TAG_VER"
        git push origin develop
        echo -e "${GREEN}✓ Tag $TAG_VER 已推送${NC}"
        ;;

    *)
        echo -e "${RED}未知命令: $1${NC}"
        echo "用法: $0 [patch|minor|major|set|build|tag]"
        exit 1
        ;;
esac

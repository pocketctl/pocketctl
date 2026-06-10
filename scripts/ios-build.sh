#!/bin/bash
# pocketctl iOS 自动构建脚本
# 用法:
#   bash scripts/ios-build.sh              # 构建 Debug
#   bash scripts/ios-build.sh release      # 构建 Release + Archive
#   bash scripts/ios-build.sh upload       # 构建 + 上传到 TestFlight
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
IOS_DIR="$PROJECT_ROOT/ios"
SCHEME="Pocketctl"
CONFIG=${1:-"debug"}
BUILD_DIR="$PROJECT_ROOT/build/ios"
ARCHIVE_PATH="$BUILD_DIR/$SCHEME.xcarchive"
EXPORT_PATH="$BUILD_DIR/export"
TIMESTAMP=$(date '+%Y-%m-%d_%H%M')

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo "=========================================="
echo "  pocketctl iOS 构建"
echo "  配置: $CONFIG"
echo "  时间: $(date '+%Y-%m-%d %H:%M:%S')"
echo "=========================================="

# ─── 1. 版本号 ───
VERSION=$(cd "$IOS_DIR" && xcodebuild -showBuildSettings -scheme "$SCHEME" -configuration Release 2>/dev/null | grep MARKETING_VERSION | awk '{print $3}' | tr -d '"')
BUILD=$(cd "$IOS_DIR" && xcodebuild -showBuildSettings -scheme "$SCHEME" -configuration Release 2>/dev/null | grep CURRENT_PROJECT_VERSION | awk '{print $3}' | tr -d '"')
echo -e "版本: ${GREEN}$VERSION ($BUILD)${NC}"

# ─── 2. 自动递增 build number ───
if [ "$CONFIG" != "debug" ]; then
    CURRENT_BUILD=$(grep "CURRENT_PROJECT_VERSION" "$IOS_DIR/Pocketctl.xcodeproj/project.pbxproj" | head -1 | awk '{print $3}' | tr -d ';')
    NEW_BUILD=$((CURRENT_BUILD + 1))
    sed -i '' "s/CURRENT_PROJECT_VERSION = .*/CURRENT_PROJECT_VERSION = $NEW_BUILD;/g" "$IOS_DIR/Pocketctl.xcodeproj/project.pbxproj"
    echo -e "构建号: ${YELLOW}$CURRENT_BUILD → $NEW_BUILD${NC}"
fi

# ─── 3. 清理 ───
echo -e "${YELLOW}[1/4] 清理...${NC}"
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"
xcodebuild clean -project "$IOS_DIR/Pocketctl.xcodeproj" -scheme "$SCHEME" -quiet 2>/dev/null || true
echo -e "  ${GREEN}✓ 清理完成${NC}"

# ─── 3. 构建/Archive ───
if [ "$CONFIG" = "debug" ]; then
    echo -e "${YELLOW}[2/4] 构建 Debug...${NC}"
    xcodebuild build \
        -project "$IOS_DIR/Pocketctl.xcodeproj" \
        -scheme "$SCHEME" \
        -configuration Debug \
        -destination 'generic/platform=iOS' \
        -derivedDataPath "$BUILD_DIR/DerivedData" \
        -quiet \
        2>&1 | tail -5
    echo -e "  ${GREEN}✓ Debug 构建完成${NC}"
    echo ""
    echo "=========================================="
    echo -e "  ${GREEN}✅ 构建成功${NC}"
    echo "  输出: $BUILD_DIR/DerivedData"
    echo "=========================================="
    exit 0
fi

# Release Archive
echo -e "${YELLOW}[2/4] Archive...${NC}"
xcodebuild archive \
    -project "$IOS_DIR/Pocketctl.xcodeproj" \
    -scheme "$SCHEME" \
    -configuration Release \
    -archivePath "$ARCHIVE_PATH" \
    -destination 'generic/platform=iOS' \
    -quiet \
    2>&1 | tail -5
echo -e "  ${GREEN}✓ Archive 完成${NC}"

# ─── 4. Export IPA ───
echo -e "${YELLOW}[3/4] Export IPA...${NC}"

# 创建 ExportOptions.plist
cat > "$BUILD_DIR/ExportOptions.plist" << 'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>method</key>
    <string>app-store</string>
    <key>teamID</key>
    <string>4M8BRH2MYC</string>
    <key>uploadBitcode</key>
    <false/>
    <key>uploadSymbols</key>
    <true/>
    <key>compileBitcode</key>
    <false/>
</dict>
</plist>
PLIST

xcodebuild -exportArchive \
    -archivePath "$ARCHIVE_PATH" \
    -exportPath "$EXPORT_PATH" \
    -exportOptionsPlist "$BUILD_DIR/ExportOptions.plist" \
    -quiet \
    2>&1 | tail -5

IPA_FILE=$(find "$EXPORT_PATH" -name "*.ipa" | head -1)
if [ -z "$IPA_FILE" ]; then
    echo -e "  ${RED}✗ IPA 导出失败${NC}"
    exit 1
fi
echo -e "  ${GREEN}✓ IPA 导出完成: $IPA_FILE${NC}"

# ─── 5. 上传 TestFlight ───
if [ "$CONFIG" = "upload" ]; then
    echo -e "${YELLOW}[4/4] 上传到 TestFlight...${NC}"

    # 检查 xcrun altool 或 transporter
    if xcrun altool --upload-app --type ios --file "$IPA_FILE" --apiKey "$APPLE_API_KEY" --apiIssuer "$APPLE_API_ISSUER" 2>&1; then
        echo -e "  ${GREEN}✓ 上传成功${NC}"
    else
        echo -e "  ${RED}✗ 上传失败。请配置 APPLE_API_KEY 和 APPLE_API_ISSUER 环境变量${NC}"
        echo "  获取方式: App Store Connect → 用户与访问 → 密钥 → 生成"
        exit 1
    fi
else
    echo -e "${YELLOW}[4/4] 跳过上传（使用 'upload' 参数上传到 TestFlight）${NC}"
fi

echo ""
echo "=========================================="
echo -e "  ${GREEN}✅ iOS 构建完成${NC}"
echo "  版本: $VERSION ($BUILD)"
echo "  Archive: $ARCHIVE_PATH"
echo "  IPA: $IPA_FILE"
echo ""
echo "  上传到 TestFlight:"
echo "    bash scripts/ios-build.sh upload"
echo "=========================================="

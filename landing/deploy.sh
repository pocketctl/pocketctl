#!/bin/bash
# ================================================
# pocketctl Landing Page 线上部署脚本
# 在服务器上执行此脚本（或通过 ssh 远程执行）
# ================================================
set -euo pipefail

WEB_DIR="/var/www/pocketctl"
LANDING_DIR="$WEB_DIR/landing"
NGINX_CONF="/etc/nginx/conf.d/pocketctl.conf"
REPO_DIR="${REPO_DIR:-/root/pocketctl}"

echo "=== 1. 部署 Landing Page 静态文件 ==="
mkdir -p "$LANDING_DIR"
cp -v "$REPO_DIR/landing/index.html" "$LANDING_DIR/"
cp -rv "$REPO_DIR/landing/css" "$LANDING_DIR/"
cp -rv "$REPO_DIR/landing/js" "$LANDING_DIR/"
cp -rv "$REPO_DIR/landing/assets" "$LANDING_DIR/"

echo ""
echo "=== 2. 构建并部署 Web 客户端（base: /app/）==="
cd "$REPO_DIR/web"
npm run build
mkdir -p "$LANDING_DIR/app"
rm -rf "$LANDING_DIR/app/"*
cp -rv dist/* "$LANDING_DIR/app/"

echo ""
echo "=== 3. 部署 Nginx 配置（替换旧配置）==="
# 备份旧配置
BACKUP_DIR="/etc/nginx/backup-$(date +%Y%m%d%H%M%S)"
mkdir -p "$BACKUP_DIR"
if ls /etc/nginx/conf.d/*.conf /etc/nginx/sites-enabled/* 2>/dev/null; then
  echo "备份旧配置到 $BACKUP_DIR"
  cp -r /etc/nginx/conf.d/*.conf "$BACKUP_DIR/" 2>/dev/null || true
  cp -r /etc/nginx/sites-enabled/* "$BACKUP_DIR/" 2>/dev/null || true
fi

# 清空可能冲突的旧配置
echo "清理可能冲突的旧配置..."
rm -f /etc/nginx/sites-enabled/default 2>/dev/null || true
rm -f /etc/nginx/sites-enabled/pocketctl 2>/dev/null || true
rm -f /etc/nginx/conf.d/default.conf 2>/dev/null || true
rm -f /etc/nginx/conf.d/pocketctl-web.conf 2>/dev/null || true

# 安装新配置（唯一 server 块）
cp "$REPO_DIR/landing/nginx.conf" "$NGINX_CONF"
echo "新配置: $NGINX_CONF"

echo ""
echo "=== 4. 验证 Nginx 配置 ==="
nginx -t

echo ""
echo "=== 5. 重载 Nginx ==="
nginx -s reload

echo ""
echo "=== 6. 验证部署 ==="
sleep 1

echo "Landing Page (/):"
curl -s -o /dev/null -w "HTTP %{http_code}" http://localhost/ && echo ""

echo "Landing CSS:"
curl -s -o /dev/null -w "HTTP %{http_code}" http://localhost/css/style.css && echo ""

echo "Web 客户端 (/app/login):"
curl -s -o /dev/null -w "HTTP %{http_code}" http://localhost/app/login && echo ""

echo ""
echo "=== 部署完成 ==="
echo "访问 http://$(hostname -I | awk '{print $1}') 应该看到 Landing Page"

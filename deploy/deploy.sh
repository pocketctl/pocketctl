#!/bin/bash
set -euo pipefail

# ============================================
# pocketctl 一键部署脚本
# 适用于 Ubuntu 22.04 / 24.04
# 用法: bash deploy.sh
# ============================================

# ---------- 配置区（按需修改） ----------
DOMAIN="pocketctl.yourdomain.com"
API_KEY="change-me-to-a-strong-random-string"
DB_PASSWORD="change-me-to-a-strong-db-password"
RELAY_PORT=8080
WEB_PORT=3000
INSTALL_DIR="/opt/pocketctl"
CERT_PATH="/etc/ssl/pocketctl/cert.pem"
KEY_PATH="/etc/ssl/pocketctl/key.pem"
# -----------------------------------------

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# ---------- 1. 系统检查 ----------
info "检查系统环境..."
if [[ "$(id -u)" -ne 0 ]]; then
  error "请使用 root 用户或 sudo 运行此脚本"
fi

if ! command -v lsb_release &>/dev/null || [[ "$(lsb_release -is)" != "Ubuntu" ]]; then
  warn "此脚本针对 Ubuntu 优化，其他系统可能需要手动调整"
fi

info "系统: $(lsb_release -ds 2>/dev/null || uname -a)"

# ---------- 2. 安装基础依赖 ----------
info "安装基础依赖..."
apt-get update -qq
apt-get install -y -qq curl wget git build-essential nginx postgresql postgresql-contrib > /dev/null

# 安装 Node.js 22
if ! command -v node &>/dev/null || [[ "$(node -v | cut -d. -f1)" != "v22" ]]; then
  info "安装 Node.js 22..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - > /dev/null 2>&1
  apt-get install -y -qq nodejs > /dev/null
fi
info "Node.js: $(node -v), npm: $(npm -v)"

# ---------- 3. 创建用户 ----------
if ! id -u pocketctl &>/dev/null 2>&1; then
  info "创建 pocketctl 用户..."
  useradd -r -m -s /bin/bash pocketctl
fi

# ---------- 4. 配置 PostgreSQL ----------
info "配置 PostgreSQL..."
sudo -u postgres psql -c "CREATE USER pocketctl WITH PASSWORD '${DB_PASSWORD}';" 2>/dev/null || true
sudo -u postgres psql -c "CREATE DATABASE pocketctl OWNER pocketctl;" 2>/dev/null || true
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE pocketctl TO pocketctl;" 2>/dev/null || true

# PostgreSQL 配置优化
PG_CONF="/etc/postgresql/$(pg_config --version | grep -oP '\d+' | head -1)/main/postgresql.conf"
if [[ -f "$PG_CONF" ]]; then
  sed -i "s/^#listen_addresses = .*/listen_addresses = 'localhost'/" "$PG_CONF"
  info "PostgreSQL 已限制为本地连接"
fi

# ---------- 5. 部署 Relay ----------
info "部署 Relay 服务..."
mkdir -p ${INSTALL_DIR}/relay

# 如果已有代码就拉取，否则提示
if [[ -d "${INSTALL_DIR}/relay/package.json" ]]; then
  cd ${INSTALL_DIR}/relay && npm ci --production && npm run build
else
  warn "请先将 Relay 代码部署到 ${INSTALL_DIR}/relay/"
  warn "方式一: git clone <repo> ${INSTALL_DIR}/relay"
  warn "方式二: scp -r ./relay/* root@server:${INSTALL_DIR}/relay/"
  info "按 Enter 继续部署完成后续步骤，或 Ctrl+C 退出先传代码..."
  read -r
  cd ${INSTALL_DIR}/relay && npm ci && npm run build
fi

# 创建 .env 文件
cat > ${INSTALL_DIR}/relay/.env << EOF
POCKETCTL_API_KEY=${API_KEY}
DATABASE_URL=postgresql://pocketctl:${DB_PASSWORD}@localhost:5432/pocketctl
PORT=${RELAY_PORT}
NODE_ENV=production
EOF
chmod 600 ${INSTALL_DIR}/relay/.env
chown -R pocketctl:pocketctl ${INSTALL_DIR}/relay

# ---------- 6. 部署 Web UI ----------
info "部署 Web UI..."
mkdir -p ${INSTALL_DIR}/web

if [[ -d "${INSTALL_DIR}/web/package.json" ]]; then
  cd ${INSTALL_DIR}/web && npm ci && npm run build
else
  warn "请先将 Web 代码部署到 ${INSTALL_DIR}/web/"
  warn "构建产物需要在 ${INSTALL_DIR}/web/dist/ 目录"
  info "按 Enter 继续..."
  read -r
  cd ${INSTALL_DIR}/web && npm ci && npm run build
fi

mkdir -p /var/www/pocketctl
cp -r ${INSTALL_DIR}/web/dist/* /var/www/pocketctl/
chown -R www-data:www-data /var/www/pocketctl

# ---------- 7. 配置 Nginx ----------
info "配置 Nginx..."
cat > /etc/nginx/sites-available/pocketctl << EOF
# WebSocket upgrade 映射
map \$http_upgrade \$connection_upgrade {
    default upgrade;
    ''      close;
}

# HTTP -> HTTPS 重定向
server {
    listen 80;
    server_name ${DOMAIN};
    return 301 https://\$host\$request_uri;
}

# HTTPS 主服务
server {
    listen 443 ssl;
    server_name ${DOMAIN};

    # SSL 证书
    ssl_certificate     ${CERT_PATH};
    ssl_certificate_key ${KEY_PATH};
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;

    # 安全头
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header Content-Security-Policy "default-src 'self'; connect-src 'self' wss:; style-src 'self' 'unsafe-inline'; script-src 'self'" always;

    # Web 静态文件
    root /var/www/pocketctl;
    index index.html;

    location / {
        try_files \$uri \$uri/ /index.html;
    }

    # WebSocket 代理 -> Relay
    location /ws {
        proxy_pass http://127.0.0.1:${RELAY_PORT};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$connection_upgrade;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;

        # WebSocket 长连接超时（24 小时）
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;

        # 限制 WebSocket 消息大小（1MB）
        client_max_body_size 1m;
    }

    # Relay 健康检查（可选暴露）
    location /health {
        proxy_pass http://127.0.0.1:${RELAY_PORT};
    }

    # 禁止访问隐藏文件
    location ~ /\. {
        deny all;
    }
}
EOF

ln -sf /etc/nginx/sites-available/pocketctl /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default

# 检查 Nginx 配置
nginx -t || error "Nginx 配置有误，请检查"
info "Nginx 配置验证通过"

# ---------- 8. 配置 systemd ----------
info "配置 systemd 服务..."
cp ${INSTALL_DIR}/deploy/systemd/pocketctl-relay.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable pocketctl-relay
systemctl restart pocketctl-relay

# ---------- 9. 防火墙 ----------
info "配置防火墙..."
if command -v ufw &>/dev/null; then
  ufw allow 22/tcp    # SSH
  ufw allow 80/tcp    # HTTP (重定向)
  ufw allow 443/tcp   # HTTPS
  ufw --force enable
  info "UFW 防火墙已配置（开放 22, 80, 443）"
elif command -v firewall-cmd &>/dev/null; then
  firewall-cmd --permanent --add-service=ssh
  firewall-cmd --permanent --add-service=http
  firewall-cmd --permanent --add-service=https
  firewall-cmd --reload
  info "firewalld 防火墙已配置"
fi

# ---------- 10. 重启 Nginx ----------
systemctl enable nginx
systemctl restart nginx

# ---------- 完成 ----------
echo ""
echo -e "${GREEN}============================================${NC}"
echo -e "${GREEN}  pocketctl 部署完成！${NC}"
echo -e "${GREEN}============================================${NC}"
echo ""
echo "  🌐 Web UI:   https://${DOMAIN}"
echo "  🔌 Relay:    wss://${DOMAIN}/ws"
echo "  ❤️  Health:   https://${DOMAIN}/health"
echo ""
echo "  📋 接下来在本地 Mac 上运行:"
echo "     curl -fsSL https://pocketctl.com/install.sh | bash"
echo "     pocketctl daemon start --relay wss://${DOMAIN}/ws --api-key ${API_KEY}"
echo ""
echo "  📝 常用命令:"
echo "     systemctl status pocketctl-relay   # 查看服务状态"
echo "     journalctl -u pocketctl-relay -f   # 查看实时日志"
echo "     systemctl restart pocketctl-relay  # 重启服务"
echo ""

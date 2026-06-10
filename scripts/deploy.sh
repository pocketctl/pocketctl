#!/bin/bash
# pocketctl 一键部署脚本（Alibaba Cloud Linux 3）
# 用法: bash deploy.sh
set -e

echo "=========================================="
echo "  pocketctl 生产环境部署"
echo "  服务器: $(hostname)"
echo "=========================================="

# ─── 1. 系统准备 ───
echo "[1/7] 系统准备..."
dnf install -y -q git wget curl

# ─── 2. 安装 PostgreSQL（使用系统自带版本） ───
echo "[2/7] 安装 PostgreSQL..."
dnf install -y -q postgresql-server postgresql
# 初始化数据库
postgresql-setup --initdb 2>/dev/null || sudo -u postgres initdb -D /var/lib/pgsql/data 2>/dev/null || true
systemctl enable --now postgresql

# 配置 PostgreSQL
sudo -u postgres psql -c "CREATE USER pocketctl WITH PASSWORD 'pocketctl_prod_2026';" 2>/dev/null || true
sudo -u postgres psql -c "CREATE DATABASE pocketctl OWNER pocketctl;" 2>/dev/null || true
# 修改认证方式为 md5
PG_HBA=$(sudo -u postgres psql -t -c "SHOW hba_file;" | tr -d ' ')
sed -i 's/ident/md5/g' "$PG_HBA"
sed -i 's/peer/md5/g' "$PG_HBA"
systemctl restart postgresql
echo "  ✓ PostgreSQL 已就绪"

# ─── 3. 安装 Node.js 22 ───
echo "[3/7] 安装 Node.js 22..."
curl -fsSL https://rpm.nodesource.com/setup_22.x | bash - 2>/dev/null
dnf install -y -q nodejs
echo "  ✓ Node.js $(node -v) 已就绪"

# ─── 4. 安装 Nginx ───
echo "[4/7] 安装 Nginx..."
dnf install -y -q nginx
systemctl enable --now nginx
echo "  ✓ Nginx 已就绪"

# ─── 5. 部署 Relay ───
echo "[5/7] 部署 Relay..."
cd /opt
if [ -d pocketctl ]; then
    cd pocketctl && git pull origin master
else
    git clone -b master https://gitee.com/muwb123/pocketctl.git
    cd pocketctl
fi

cd relay
npm ci --production 2>/dev/null
npm run build
echo "  ✓ Relay 编译完成"

# ─── 6. 配置环境变量 ───
echo "[6/7] 配置环境变量..."
cat > /opt/pocketctl/relay/.env << 'ENVEOF'
DATABASE_URL=postgresql://pocketctl:pocketctl_prod_2026@localhost:5432/pocketctl
POCKETCTL_API_KEY=pocketctl-prod-key-2026
ZHIPU_API_KEY=d2a111844e8c42f3a5f3f8f1b283894a.WxAlzOp1EUum0EHl
NODE_ENV=production
PORT=8080
ENVEOF
echo "  ✓ 环境变量已写入"

# ─── 7. 创建 systemd 服务 + Nginx ───
echo "[7/7] 配置服务..."

# systemd
cat > /etc/systemd/system/pocketctl-relay.service << 'SVCEOF'
[Unit]
Description=pocketctl Relay Server
After=network.target postgresql.service
Requires=postgresql.service

[Service]
Type=simple
User=root
WorkingDirectory=/opt/pocketctl/relay
ExecStart=/usr/bin/node dist/server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
SVCEOF

systemctl daemon-reload
systemctl enable --now pocketctl-relay

# Nginx
cat > /etc/nginx/conf.d/pocketctl.conf << 'NGXEOF'
server {
    listen 80;
    server_name _;

    location /health {
        proxy_pass http://127.0.0.1:8080/health;
    }

    location /ws {
        proxy_pass http://127.0.0.1:8080/ws;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
        proxy_buffering off;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:8080/api/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    location / {
        return 404 '{"error":"not found"}';
        add_header Content-Type application/json;
    }
}
NGXEOF

rm -f /etc/nginx/conf.d/default.conf 2>/dev/null
nginx -t && systemctl reload nginx

echo "  ✓ 所有服务已启动"

# ─── 验证 ───
echo ""
echo "=========================================="
echo "  部署完成！验证中..."
echo "=========================================="

sleep 3

echo ""
systemctl is-active pocketctl-relay && echo "  ✓ Relay: 运行中" || echo "  ✗ Relay: 未运行"
systemctl is-active postgresql && echo "  ✓ PostgreSQL: 运行中" || echo "  ✗ PostgreSQL: 未运行"
systemctl is-active nginx && echo "  ✓ Nginx: 运行中" || echo "  ✗ Nginx: 未运行"

echo ""
echo "  测试健康检查..."
HEALTH=$(curl -s http://localhost/health 2>/dev/null)
if echo "$HEALTH" | grep -q "ok"; then
    echo "  ✓ /health 返回: $HEALTH"
else
    echo "  ✗ /health 失败: $HEALTH"
    echo "  查看日志: journalctl -u pocketctl-relay -n 20"
fi

echo ""
echo "=========================================="
echo "  部署信息"
echo "=========================================="
echo "  公网 IP:     39.106.218.47"
echo "  WebSocket:   ws://39.106.218.47/ws"
echo "  健康检查:    http://39.106.218.47/health"
echo "  Relay 日志:  journalctl -u pocketctl-relay -f"
echo "  配置文件:    /opt/pocketctl/relay/.env"
echo ""
echo "  ⚠️  请修改 .env 中的 POCKETCTL_API_KEY 为强密码！"
echo "=========================================="

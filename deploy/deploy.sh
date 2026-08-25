#!/bin/bash
set -euo pipefail

DEPLOY_SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/deployment-helpers.sh
source "$DEPLOY_SCRIPT_DIR/lib/deployment-helpers.sh"

# ============================================
# pocketctl 一键部署脚本
# 适用于 Ubuntu 22.04 / 24.04
# 用法: bash deploy.sh
#   DOMAIN=ctl.example.com \
#   POSTGRES_ADMIN_PASSWORD=... POSTGRES_APP_PASSWORD=... bash deploy.sh
# 密码缺失时自动生成强随机值并只写入 root-only .env,绝不回显。
# bash deploy.sh --check-secrets 仅执行配置校验(无系统变更)。
# ============================================

# M-7: 生成的 .env/备份不可被其他用户读取。
umask 077

RELAY_PORT=8080
WEB_PORT=3000
INSTALL_DIR="/opt/pocketctl"
CERT_PATH="/etc/ssl/pocketctl/cert.pem"
KEY_PATH="/etc/ssl/pocketctl/key.pem"
RELAY_ENV_STAGED=""

cleanup_deploy_temp() {
  # Only this exact root-owned staging path may contain generated secrets.
  if [[ -n "$RELAY_ENV_STAGED" && -f "$RELAY_ENV_STAGED" ]]; then
    rm -f -- "$RELAY_ENV_STAGED"
  fi
}
trap cleanup_deploy_temp EXIT

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# ---------- M-7 密钥契约:拒绝占位值,绝不回显 ----------
gen_secret() { pocketctl_generate_url_safe_secret; }

reject_placeholder_secret() {
  local label="$1" value="$2"
  case "$value" in
    ""|"change-me"*|"yourdomain"*|"changeme"*|"placeholder"*|"password"*|"secret"*|"test"*)
      error "${label} 是空值或占位值——请通过环境变量提供强随机值(部署输出不会包含它)"
      ;;
  esac
  if [[ ${#value} -lt 16 ]]; then
    error "${label} 长度不足 16 字符"
  fi
}

validate_secrets() {
  [[ -n "${DOMAIN:-}" ]] || error "必须通过环境变量提供 DOMAIN(例如 DOMAIN=ctl.example.com)"
  pocketctl_validate_domain "$DOMAIN" || error "DOMAIN 必须是合法 DNS 主机名"
  case "$DOMAIN" in
    *yourdomain*|*example.com*|localhost*)
      error "DOMAIN 是占位值——必须使用真实域名"
      ;;
  esac
  reject_placeholder_secret "POSTGRES_ADMIN_PASSWORD" "${POSTGRES_ADMIN_PASSWORD:-}"
  reject_placeholder_secret "POSTGRES_APP_PASSWORD" "${POSTGRES_APP_PASSWORD:-}"
  pocketctl_validate_database_password "POSTGRES_ADMIN_PASSWORD" "$POSTGRES_ADMIN_PASSWORD" \
    || error "POSTGRES_ADMIN_PASSWORD 必须至少 24 字符且仅使用 URL-safe 字符"
  pocketctl_validate_database_password "POSTGRES_APP_PASSWORD" "$POSTGRES_APP_PASSWORD" \
    || error "POSTGRES_APP_PASSWORD 必须至少 24 字符且仅使用 URL-safe 字符"
  if [[ "${POSTGRES_ADMIN_PASSWORD}" == "${POSTGRES_APP_PASSWORD}" ]]; then
    error "POSTGRES_ADMIN_PASSWORD 与 POSTGRES_APP_PASSWORD 不得相同"
  fi
}

if [[ "${1:-}" == "--check-secrets" ]]; then
  validate_secrets
  echo "secret configuration valid"
  exit 0
fi

# 未显式提供时生成强随机值(仅写入 root-only .env)。
if [[ -z "${POSTGRES_ADMIN_PASSWORD:-}" ]]; then POSTGRES_ADMIN_PASSWORD="$(gen_secret)"; fi
if [[ -z "${POSTGRES_APP_PASSWORD:-}" ]]; then POSTGRES_APP_PASSWORD="$(gen_secret)"; fi
validate_secrets

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

# ---------- 4. 无数据库副作用的 Relay 预检、构建与环境暂存 ----------
info "预检并构建 Relay..."
install -d -o root -g root -m 755 "$INSTALL_DIR" "${INSTALL_DIR}/relay"
[[ -f "${INSTALL_DIR}/relay/package.json" ]] \
  || error "缺少 ${INSTALL_DIR}/relay/package.json；必须先以 Git worktree 部署 Relay 源码"

# 服务账号不得拥有代码或 EnvironmentFile 父目录。先收回旧部署遗留的
# 写权限，再校验实际将被构建的 Relay 必须属于 clean Git worktree。
chown -R root:root "${INSTALL_DIR}/relay"
find "${INSTALL_DIR}/relay" -type d -exec chmod go-w {} +
find "${INSTALL_DIR}/relay" -type f -exec chmod go-w {} +
if [[ -f "${INSTALL_DIR}/relay/.env" ]]; then
  chown root:pocketctl "${INSTALL_DIR}/relay/.env"
  chmod 640 "${INSTALL_DIR}/relay/.env"
fi
RELAY_SOURCE_SHA=$(pocketctl_resolve_clean_git_sha "${INSTALL_DIR}/relay") \
  || error "Relay 源码不是 clean Git worktree，无法建立可信发布身份"
if [[ -n "${GIT_SHA:-}" && "${GIT_SHA}" != "$RELAY_SOURCE_SHA" ]]; then
  error "显式 GIT_SHA 与实际 Relay worktree HEAD 不一致"
fi
GIT_SHA_VALUE=$RELAY_SOURCE_SHA

cd "${INSTALL_DIR}/relay"
npm ci
npm run build
npm prune --omit=dev

# 在任何数据库密码轮换前完成 production env 的全部校验与写入。暂存文件
# 与最终 .env 位于同一 root-owned 目录，cutover 时使用原子 rename。
RELAY_ENV="${INSTALL_DIR}/relay/.env"
RELAY_ENV_STAGED="${RELAY_ENV}.next"
relay_env_value() {
  local key=$1
  [[ -f "$RELAY_ENV" ]] || return 0
  awk -v prefix="${key}=" 'index($0, prefix) == 1 { print substr($0, length(prefix) + 1); exit }' "$RELAY_ENV"
}
load_relay_env_value() {
  local target=$1 input_name=$2 persisted_name=$3 value
  [[ -n "${!target:-}" ]] && return 0
  if [[ -n "${!input_name:-}" ]]; then
    value=${!input_name}
  else
    value=$(relay_env_value "$persisted_name")
  fi
  printf -v "$target" '%s' "$value"
}

JWT_SECRET_VALUE="$(relay_env_value JWT_SECRET)"
AUTH_CODE_PEPPER_VALUE="$(relay_env_value AUTH_CODE_PEPPER)"
[[ -n "$JWT_SECRET_VALUE" ]] || JWT_SECRET_VALUE="$(gen_secret)"
[[ -n "$AUTH_CODE_PEPPER_VALUE" ]] || AUTH_CODE_PEPPER_VALUE="$(gen_secret)"
[[ "$JWT_SECRET_VALUE" != "$AUTH_CODE_PEPPER_VALUE" ]] || AUTH_CODE_PEPPER_VALUE="$(gen_secret)"

# Preserve the complete Extension Platform contract across redeploys. Explicit
# operator environment values win; otherwise the last root-owned EnvironmentFile
# is carried forward atomically instead of silently reverting enabled to off.
load_relay_env_value RELAY_EXTENSIONS RELAY_EXTENSIONS RELAY_EXTENSIONS
RELAY_EXTENSIONS=${RELAY_EXTENSIONS:-off}
load_relay_env_value EXTENSION_PROVIDER_JWT_SECRET_VALUE EXTENSION_PROVIDER_JWT_SECRET EXTENSION_PROVIDER_JWT_SECRET
load_relay_env_value EXTENSION_CURSOR_SECRET_VALUE EXTENSION_CURSOR_SECRET EXTENSION_CURSOR_SECRET
load_relay_env_value EXTENSION_GRANT_PRIVATE_KEY_B64_VALUE EXTENSION_GRANT_PRIVATE_KEY_B64 EXTENSION_GRANT_PRIVATE_KEY_B64
load_relay_env_value EXTENSION_GRANT_PUBLIC_KEY_B64_VALUE EXTENSION_GRANT_PUBLIC_KEY_B64 EXTENSION_GRANT_PUBLIC_KEY_B64
load_relay_env_value EXTENSION_GRANT_KEY_ID_VALUE EXTENSION_GRANT_KEY_ID EXTENSION_GRANT_KEY_ID
load_relay_env_value EXTENSION_PROVIDER_PUBLIC_ORIGINS_VALUE EXTENSION_PROVIDER_PUBLIC_ORIGINS EXTENSION_PROVIDER_PUBLIC_ORIGINS
load_relay_env_value RELAY_EXTENSION_PROJECTOR_BATCH_VALUE RELAY_EXTENSION_PROJECTOR_BATCH RELAY_EXTENSION_PROJECTOR_BATCH
load_relay_env_value RELAY_EXTENSION_FEED_RETENTION_DAYS_VALUE RELAY_EXTENSION_FEED_RETENTION_DAYS RELAY_EXTENSION_FEED_RETENTION_DAYS
load_relay_env_value RELAY_EXTENSION_LEASE_TTL_SECONDS_VALUE RELAY_EXTENSION_LEASE_TTL_SECONDS RELAY_EXTENSION_LEASE_TTL_SECONDS
load_relay_env_value RELAY_EXTENSION_RATE_LIMIT_TOKEN_VALUE RELAY_EXTENSION_RATE_LIMIT_TOKEN RELAY_EXTENSION_RATE_LIMIT_TOKEN
load_relay_env_value RELAY_EXTENSION_RATE_LIMIT_FEED_VALUE RELAY_EXTENSION_RATE_LIMIT_FEED RELAY_EXTENSION_RATE_LIMIT_FEED
load_relay_env_value RELAY_EXTENSION_RATE_LIMIT_ACK_VALUE RELAY_EXTENSION_RATE_LIMIT_ACK RELAY_EXTENSION_RATE_LIMIT_ACK
load_relay_env_value RELAY_EXTENSION_RATE_LIMIT_SNAPSHOT_VALUE RELAY_EXTENSION_RATE_LIMIT_SNAPSHOT RELAY_EXTENSION_RATE_LIMIT_SNAPSHOT
load_relay_env_value RELAY_EXTENSION_RATE_LIMIT_STATUS_VALUE RELAY_EXTENSION_RATE_LIMIT_STATUS RELAY_EXTENSION_RATE_LIMIT_STATUS
load_relay_env_value RELAY_EXTENSION_RATE_LIMIT_USAGE_VALUE RELAY_EXTENSION_RATE_LIMIT_USAGE RELAY_EXTENSION_RATE_LIMIT_USAGE
load_relay_env_value RELAY_EXTENSION_RATE_LIMIT_PURGE_VALUE RELAY_EXTENSION_RATE_LIMIT_PURGE RELAY_EXTENSION_RATE_LIMIT_PURGE
load_relay_env_value RELAY_EXTENSION_RATE_LIMIT_GRANT_VALUE RELAY_EXTENSION_RATE_LIMIT_GRANT RELAY_EXTENSION_RATE_LIMIT_GRANT

RELEASE_VERSION_VALUE=${RELEASE_VERSION:-}
if [[ -z "$RELEASE_VERSION_VALUE" ]]; then
  PACKAGE_VERSION=$(node -p "require('${INSTALL_DIR}/relay/package.json').version")
  RELEASE_VERSION_VALUE=${PACKAGE_VERSION#v}
  RELEASE_VERSION_VALUE="v${RELEASE_VERSION_VALUE}"
fi
BUILD_TIME_VALUE=${BUILD_TIME:-$(date -u '+%Y-%m-%dT%H:%M:%SZ')}
pocketctl_validate_runtime_identity "$RELEASE_VERSION_VALUE" "$GIT_SHA_VALUE" "$BUILD_TIME_VALUE" \
  || error "RELEASE_VERSION/GIT_SHA/BUILD_TIME 不符合 production identity 契约"

QUOTA_ENFORCEMENT=${QUOTA_ENFORCEMENT:-enforce}
APNS_KEY_PATH_VALUE=${APNS_KEY_PATH:-}
APNS_KEY_ID_VALUE=${APNS_KEY_ID:-}
APNS_TEAM_ID_VALUE=${APNS_TEAM_ID:-}
APNS_BUNDLE_ID_VALUE=${APNS_BUNDLE_ID:-com.pocketctl.app}
APNS_ENVIRONMENT_VALUE=${APNS_ENVIRONMENT:-production}
pocketctl_write_relay_production_env "$RELAY_ENV_STAGED" \
  || error "无法生成完整的 Relay production 环境暂存文件"
node "${INSTALL_DIR}/relay/dist/extensions/validate-production-env.js" "$RELAY_ENV_STAGED" \
  || error "Relay production 环境未通过运行时 Extension/RSA 配置校验"

chown -R root:root "${INSTALL_DIR}/relay"
find "${INSTALL_DIR}/relay" -type d -exec chmod go-w {} +
find "${INSTALL_DIR}/relay" -type f -exec chmod go-w {} +
if [[ -f "$RELAY_ENV" ]]; then
  chown root:pocketctl "$RELAY_ENV"
  chmod 640 "$RELAY_ENV"
fi

# ---------- 5. 配置 PostgreSQL（SCRAM + 最小 pg_hba 变更） ----------
info "配置 PostgreSQL（scram-sha-256）..."

# Existing databases need an explicit, backed-up ownership migration. This
# read-only gate runs before role/password rotation, .env cutover, service
# restart, or pg_hba changes. A missing peer-management path also fails here,
# while the deployment is still side-effect free with respect to PostgreSQL.
if ! POCKETCTL_DB_EXISTS=$(sudo -u postgres psql -X -v ON_ERROR_STOP=1 -d postgres -Atc \
  "SELECT count(*) FROM pg_database WHERE datname='pocketctl'"); then
  error "无法通过 postgres 本地管理入口执行只读数据库预检；请先恢复 peer 管理访问"
fi
case "$POCKETCTL_DB_EXISTS" in
  0) ;;
  1)
    if ! sudo -u postgres psql -X -v ON_ERROR_STOP=1 -d pocketctl \
      -f "$DEPLOY_SCRIPT_DIR/postgres/check-existing-ownership.sql"; then
      error "已有数据库尚未完成角色/对象属主迁移；请执行 deploy/postgres/migrate-existing-superuser.md 后重试"
    fi
    ;;
  *) error "数据库存在性预检返回异常结果" ;;
esac
unset POCKETCTL_DB_EXISTS

PG_VERSION_NUM="$(pg_config --version | grep -oP '\d+' | head -1)"
PG_CONF="/etc/postgresql/${PG_VERSION_NUM}/main/postgresql.conf"
PG_HBA="/etc/postgresql/${PG_VERSION_NUM}/main/pg_hba.conf"

# 修改前备份；失败即中止，不做任何全局 sed。
for cfg in "$PG_CONF" "$PG_HBA"; do
  if [[ -f "$cfg" && ! -f "${cfg}.pre-pocketctl" ]]; then
    cp "$cfg" "${cfg}.pre-pocketctl"
  fi
done

# M-7:bootstrap/maintenance(pocketctl_admin)与应用(pocketctl_app,非
# superuser)角色分离;数据库属主为应用角色,Relay 只用应用角色连接。
# 密码经 psql variable 传递，不进入命令行/日志；会话内固定 SCRAM 后再
# 创建角色与数据库，确保 verifier 是 SCRAM（服务器默认摘要算法可能较弱）。
{
  # Database passwords are validated as URI-unreserved above, so single-quoted
  # psql \set values cannot terminate or escape these assignments. The secret
  # travels over stdin and never appears in the psql/sudo process argv.
  printf "\\set admin_superuser false\n"
  printf "\\set adminpass '%s'\n" "$POSTGRES_ADMIN_PASSWORD"
  printf "\\set apppass '%s'\n" "$POSTGRES_APP_PASSWORD"
  cat "$DEPLOY_SCRIPT_DIR/postgres/configure-roles.sql"
} | sudo -u postgres psql -X -v ON_ERROR_STOP=1 -d postgres

# SQL 成功后立即切换与新 verifier 匹配的 EnvironmentFile；后续步骤失败
# 也不会留下“数据库新密码 + 旧 .env”的永久失联状态。
mv -f "$RELAY_ENV_STAGED" "$RELAY_ENV"
chown root:pocketctl "$RELAY_ENV"
chmod 640 "$RELAY_ENV"
unset JWT_SECRET_VALUE AUTH_CODE_PEPPER_VALUE POSTGRES_ADMIN_PASSWORD POSTGRES_APP_PASSWORD
if systemctl is-active --quiet pocketctl-relay 2>/dev/null; then
  systemctl restart pocketctl-relay \
    || error "数据库凭据已切换但现有 Relay 重启失败；.env 已保留新凭据，请检查 journal"
fi

# pg_hba：只增加/收紧 PocketCtl 自己的 localhost 规则为 scram-sha-256，
# 保留 postgres 本地 peer 管理规则不动；改完 reload 并用只读视图验证。
PG_HBA_ROLLBACK=$(mktemp)
cp -p "$PG_HBA" "$PG_HBA_ROLLBACK"
if ! pocketctl_install_pg_hba_rules "$PG_HBA"; then
  rm -f "$PG_HBA_ROLLBACK"
  error "无法原子写入 PocketCtl pg_hba SCRAM 规则"
fi
FIRST_HOST_RULE=$(awk '!/^[[:space:]]*(#|$)/ && $1 ~ /^host/ { print; exit }' "$PG_HBA")
if [[ "$FIRST_HOST_RULE" != 'host pocketctl pocketctl_app 127.0.0.1/32 scram-sha-256' ]] || \
  ! sudo -u postgres psql -X -v ON_ERROR_STOP=1 -Atc \
    "SELECT count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL" | grep -qx '0'; then
  cp -p "$PG_HBA_ROLLBACK" "$PG_HBA"
  rm -f "$PG_HBA_ROLLBACK"
  error "pg_hba 顺序或语法校验失败；已恢复本次修改前的配置"
fi
if ! sudo -u postgres pg_ctlcluster "${PG_VERSION_NUM}" main reload && \
   ! systemctl reload postgresql; then
  cp -p "$PG_HBA_ROLLBACK" "$PG_HBA"
  sudo -u postgres pg_ctlcluster "${PG_VERSION_NUM}" main reload >/dev/null 2>&1 \
    || systemctl reload postgresql >/dev/null 2>&1 || true
  rm -f "$PG_HBA_ROLLBACK"
  error "pg_hba reload 失败；已恢复并尝试重新加载本次修改前的配置"
fi

# 只读验证：应用角色的 localhost 规则必须已是 SCRAM，且 postgres 本地
# peer 管理规则保持存在。
if ! sudo -u postgres psql -X -v ON_ERROR_STOP=1 -Atc \
  "SELECT count(*) FROM pg_hba_file_rules WHERE database::text = '{pocketctl}' AND user_name::text = '{pocketctl_app}' AND auth_method = 'scram-sha-256' AND (address = '127.0.0.1/32' OR address = '::1/128')" \
  | grep -qx '2'; then
  cp -p "$PG_HBA_ROLLBACK" "$PG_HBA"
  sudo -u postgres pg_ctlcluster "${PG_VERSION_NUM}" main reload >/dev/null 2>&1 \
    || systemctl reload postgresql >/dev/null 2>&1 || true
  rm -f "$PG_HBA_ROLLBACK"
  error "PocketCtl SCRAM localhost 规则未生效；已恢复并重新加载旧配置"
fi
sudo -u postgres psql -v ON_ERROR_STOP=1 -Atc \
  "SELECT count(*) FROM pg_hba_file_rules WHERE user_name::text = '{postgres}' AND auth_method = 'peer'" \
  | grep -qE '^[1-9]' || warn "未找到 postgres 本地 peer 管理规则（请人工确认未误删）"
rm -f "$PG_HBA_ROLLBACK"

# PostgreSQL 只监听本地回环。
if [[ -f "$PG_CONF" ]]; then
  if grep -qE "^listen_addresses" "$PG_CONF"; then
    sed -i "s/^listen_addresses\s*=.*/listen_addresses = 'localhost'/" "$PG_CONF"
  else
    printf "\nlisten_addresses = 'localhost'\n" >> "$PG_CONF"
  fi
  sudo -u postgres pg_ctlcluster "${PG_VERSION_NUM}" main reload || systemctl reload postgresql
  info "PostgreSQL 已限制为本地连接（SCRAM）"
fi

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
chown -R root:www-data /var/www/pocketctl
find /var/www/pocketctl -type d -exec chmod 755 {} +
find /var/www/pocketctl -type f -exec chmod 644 {} +

# ---------- 7. 配置 Nginx ----------
info "配置 Nginx..."
cat > /etc/nginx/sites-available/pocketctl << EOF
# WebSocket upgrade 映射
map \$http_upgrade \$connection_upgrade {
    default upgrade;
    ''      close;
}

map \$request_uri \$sanitized_uri {
    default \$request_uri;
    "~^(?<pre>.*)(?<param>[?&](token|access_token|refresh_token|api_key)=)[^&]*(?<post>.*)$" "\${pre}\${param}REDACTED\${post}";
}

log_format pocketctl '\$remote_addr - \$remote_user [\$time_local] '
                     '"\$request_method \$sanitized_uri \$server_protocol" '
                     '\$status \$body_bytes_sent "\$http_referer" "\$http_user_agent"';

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
    access_log /var/log/nginx/pocketctl.access.log pocketctl;

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
    add_header Content-Security-Policy "default-src 'self'; connect-src 'self' wss:; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'" always;

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

# 发布身份是部署完成条件，不是展示信息。只有 TLS health 返回 ok 且版本、
# SHA、构建时间与本次 checkout 完全一致时才允许报告成功。
HEALTH_RESPONSE=$(mktemp)
HEALTH_VERIFIED=0
for _ in $(seq 1 60); do
  if curl -fsS --connect-timeout 3 --max-time 5 --cacert "$CERT_PATH" \
      "https://${DOMAIN}/health" -o "$HEALTH_RESPONSE" && \
    EXPECTED_RELEASE_VERSION="$RELEASE_VERSION_VALUE" \
    EXPECTED_GIT_SHA="$GIT_SHA_VALUE" \
    EXPECTED_BUILD_TIME="$BUILD_TIME_VALUE" \
    node - "$HEALTH_RESPONSE" <<'NODE'
const fs = require('node:fs')
const health = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
if (health.status !== 'ok') process.exit(1)
if (health.release_version !== process.env.EXPECTED_RELEASE_VERSION) process.exit(2)
if (health.git_sha !== process.env.EXPECTED_GIT_SHA) process.exit(3)
if (health.build_time !== process.env.EXPECTED_BUILD_TIME) process.exit(4)
NODE
  then
    HEALTH_VERIFIED=1
    break
  fi
  sleep 1
done
rm -f "$HEALTH_RESPONSE"
[[ "$HEALTH_VERIFIED" == 1 ]] \
  || error "production /health 未返回与本次部署一致的版本、SHA、构建时间"
info "Relay production identity 与 /health 已核验"

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
echo "     curl -fsSL https://pocketctl.me/install.sh | bash"
echo "     pocketctl daemon start --relay wss://${DOMAIN}/ws  # login with a user account (email code); no API key"
echo ""
echo "  📝 常用命令:"
echo "     systemctl status pocketctl-relay   # 查看服务状态"
echo "     journalctl -u pocketctl-relay -f   # 查看实时日志"
echo "     systemctl restart pocketctl-relay  # 重启服务"
echo ""

# 迁移现有 volume:从 superuser 应用角色到分离的 admin/app 角色

官方 postgres 镜像的 `POSTGRES_USER/POSTGRES_PASSWORD` 只在**空数据目录**生效;
对已有 pgdata 必须手工迁移。以下步骤在停机窗口执行,全部可回滚。

设:旧应用角色 `pocketctl`(由官方镜像创建,superuser),目标:`pocketctl_admin`(维护)+ `pocketctl_app`(应用,非 superuser)。

## 0. 前置

- 能以超级用户连接(peer 的 `postgres` 或当前 `pocketctl`)。
- 准备两个新的强密码:`ADMIN_PW`、`APP_PW`(不得相同、不得为占位值，至少 24 位且只使用 `A-Za-z0-9._~-`)。
- 密码不放入命令行参数。下文通过标准输入设置 psql 变量，连接认证只使用进程环境中的 `PGPASSWORD`。

先在当前 shell 中按实际部署方式定义唯一的超级用户入口，后续命令统一调用 `psql_super`：

```bash
# 旧 Docker Compose 部署（OLD_DB_SUPERUSER 必须取旧 compose 的 POSTGRES_USER，历史默认是 pocketctl）
DEPLOYMENT_KIND=compose
OLD_DB_SUPERUSER=pocketctl
psql_super() { docker compose exec -T postgres psql -X -U "$OLD_DB_SUPERUSER" "$@"; }

# bare-metal 部署改用下面两行替代上面的设置：
# DEPLOYMENT_KIND=baremetal
# psql_super() { sudo -u postgres psql -X "$@"; }

psql_super -d postgres -Atc 'SELECT current_user, rolsuper FROM pg_roles WHERE rolname=current_user;'
# 必须确认第二列为 t/true 才能继续。
```

## 1. 备份并验证可恢复性

```bash
umask 077
BACKUP="pocketctl-pre-role-split-$(date +%F).dump"
# Compose：备份写到宿主当前目录，不依赖容器内持久路径。
docker compose exec -T postgres pg_dump -U "$OLD_DB_SUPERUSER" -Fc -d pocketctl > "$BACKUP"
docker compose exec -T postgres pg_restore --list < "$BACKUP" >/dev/null && echo RESTORE_TOC_OK

# bare-metal 对应命令：
# sudo -u postgres pg_dump -Fc -d pocketctl -f "$BACKUP"
# sudo -u postgres pg_restore --list "$BACKUP" >/dev/null && echo RESTORE_TOC_OK
```

(可选)在 throwaway 库演练恢复:

```bash
sudo -u postgres createdb pocketctl_restore_test
sudo -u postgres pg_restore -d pocketctl_restore_test "$BACKUP"
sudo -u postgres dropdb pocketctl_restore_test
```

## 2. 创建/轮换新角色并转移对象所有权

```bash
# 在仓库根目录执行。configure-roles.sql 使用 format(%I/%L)+\gexec，
# 可重复执行并确保密码 verifier 为 SCRAM；密码仅通过 stdin 进入 psql。
{
  # Compose maintenance admin must remain the login-capable superuser on every rerun.
  printf "\\set admin_superuser true\n"
  printf "\\set adminpass '%s'\n" "$ADMIN_PW"
  printf "\\set apppass '%s'\n" "$APP_PW"
  cat deploy/postgres/configure-roles.sql
} | psql_super -v ON_ERROR_STOP=1 -d postgres

# 不使用 REASSIGN OWNED：旧 POSTGRES_USER 作为 bootstrap superuser 时还拥有
# PostgreSQL 必需的系统对象，整角色转移会失败。共享 SQL 仅迁移非系统 schema
# 中的表、序列、视图、函数/过程和用户类型，并在一个事务中完成。
cat deploy/postgres/migrate-existing-ownership.sql \
  | psql_super -v ON_ERROR_STOP=1 -d pocketctl
```

## 3. 以应用角色验证 initDB 与读写烟测

```bash
# Compose 不发布数据库宿主端口。用 stdin 在容器内创建一次性 pgpass，
# 强制走 127.0.0.1 TCP/SCRAM；密码不进入 docker/psql argv。
compose_app_psql() {
  local sql=$1
  printf '127.0.0.1:5432:pocketctl:pocketctl_app:%s\n' "$APP_PW" \
    | docker compose exec -T postgres sh -ceu '
        pgpass=$(mktemp)
        trap '\''rm -f "$pgpass"'\'' EXIT
        chmod 600 "$pgpass"
        cat > "$pgpass"
        PGPASSFILE="$pgpass" psql -X -h 127.0.0.1 -U pocketctl_app -d pocketctl -v ON_ERROR_STOP=1 -c "$1"
      ' sh "$sql"
}

# bare-metal 可改用：
# app_psql() { PGPASSWORD="$APP_PW" psql -X -h 127.0.0.1 -U pocketctl_app -d pocketctl -v ON_ERROR_STOP=1 -c "$1"; }
app_psql() { compose_app_psql "$1"; }

# 用 pocketctl_app 验证 Relay initDB 所需 DDL/DML。
app_psql 'CREATE TABLE IF NOT EXISTS _smoke(i INT PRIMARY KEY); INSERT INTO _smoke VALUES (1) ON CONFLICT DO NOTHING; DROP TABLE _smoke;'
# 确认无法提权。
if app_psql 'CREATE ROLE nope'; then
  echo 'UNEXPECTED: escalation allowed' >&2
  exit 1
else
  echo 'escalation correctly denied'
fi
```

## 4. 准备切换连接串

把 `.env`/systemd/compose 的 `DATABASE_URL` 用户改为 `pocketctl_app`，但此时不要用新 Compose 重启 PostgreSQL；先完成第 5～6 步并通过 volume gate。第 6 步启动后再验证 `/health` 与一次登录/WS 连接。

## 5. 撤销旧角色特权

确认没有旧连接(`SELECT pid, usename FROM pg_stat_activity WHERE usename = 'pocketctl';`)后:

```bash
# bootstrap superuser 必须在仍有 SUPERUSER 时先轮换密码；降权后再改会被 PostgreSQL 拒绝。
OLD_PW=$(openssl rand -hex 24)
printf "\\set old_pw '%s'\nALTER ROLE pocketctl PASSWORD :'old_pw';\n" "$OLD_PW" \
  | psql_super -v ON_ERROR_STOP=1 -d postgres
unset OLD_PW

if [[ "$DEPLOYMENT_KIND" == compose ]]; then
  # PostgreSQL 17 不允许撤销 bootstrap superuser(OID 10)的 SUPERUSER。
  # 先把隔离的维护账号提升为 Compose 唯一可登录 superuser，再禁用旧账号登录。
  psql_super -v ON_ERROR_STOP=1 -d postgres \
    -c "ALTER ROLE pocketctl_admin SUPERUSER CREATEDB CREATEROLE; ALTER ROLE pocketctl NOLOGIN;"
  # 后续维护立即切换到仍可登录的隔离 admin；不要再使用已 NOLOGIN 的旧角色。
  OLD_DB_SUPERUSER=pocketctl_admin
  psql_super() { docker compose exec -T postgres psql -X -U "$OLD_DB_SUPERUSER" "$@"; }
  psql_super -d postgres -Atc 'SELECT current_user, rolsuper FROM pg_roles WHERE rolname=current_user;'
else
  # bare-metal 始终还有本地 peer 的 postgres 维护 superuser，可彻底降权旧应用角色。
  psql_super -v ON_ERROR_STOP=1 -d postgres \
    -c "ALTER ROLE pocketctl NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOLOGIN;"
fi
```

Compose 的旧 `pocketctl` 是 PostgreSQL bootstrap role，不能撤销 SUPERUSER、也不能删除；它保留随机未知 verifier 并永久 `NOLOGIN`。日常维护只使用 `pocketctl_admin`，Relay 只使用 `pocketctl_app`。

## 6. 写入迁移标记并验证启动 gate

只有第 1～5 步全部成功后，才允许在数据卷内写入标记。该标记由 `deploy/postgres/check-volume-migration.sh` 只读核验，是新 Compose 启动 PostgreSQL 的硬性前置条件；不要用空文件绕过未完成的迁移。

```bash
# 在旧 PostgreSQL 容器仍运行且已完成上述验证时执行。
docker compose exec -T postgres sh -ceu \
  'test -f "$PGDATA/PG_VERSION"; install -m 600 /dev/null "$PGDATA/.pocketctl-role-split-v1"'

# 用新 Compose 定义只读复核 gate；成功时输出 migrated marker found。
docker compose run --rm --no-deps postgres-volume-gate

# 此后才能切换到新 Compose 配置。
docker compose up -d postgres
```

若 `docker compose up` 在已有 volume 上报告缺少 `.pocketctl-role-split-v1`，必须回到本手册完成迁移；不得删除 `PG_VERSION`、不得清空 volume、不得手工伪造标记。

## 7. 回滚

优先修复新角色配置并继续前进。若必须回到旧 Compose：

```bash
# 此时 psql_super 在 Compose 模式下已经指向 pocketctl_admin。
ROLLBACK_OLD_PW=$(openssl rand -hex 24)
printf "\\set old_pw '%s'\nALTER ROLE pocketctl LOGIN PASSWORD :'old_pw';\n" "$ROLLBACK_OLD_PW" \
  | psql_super -v ON_ERROR_STOP=1 -d postgres

# 停止新 Relay，把旧 Compose/.env 的 POSTGRES_PASSWORD 和 DATABASE_URL
# 更新为 ROLLBACK_OLD_PW 后，按第 1 步备份恢复；不要在命令行打印密码。
# 必要时（确认目标库可覆盖）使用：pg_restore --clean --if-exists ...

# 回滚后角色分离条件不再成立，必须删除 marker，使新 Compose 保持 fail-closed。
docker compose exec -T postgres sh -ceu \
  'rm -f "$PGDATA/.pocketctl-role-split-v1"'
unset ROLLBACK_OLD_PW
```

bare-metal 可继续通过本地 peer 的 `postgres` 角色恢复第 1 步 dump。任何回滚都必须重新验证数据库 owner、对象 owner、应用登录和 `/health`，不得仅切换连接串后宣告完成。

## 验收查询

```sql
SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolcanlogin
FROM pg_roles WHERE rolname IN ('pocketctl', 'pocketctl_admin', 'pocketctl_app');
-- Compose 期望：pocketctl 保留 PostgreSQL 强制的 bootstrap superuser 属性但 rolcanlogin=f；
-- pocketctl_admin 为可登录维护 superuser；pocketctl_app 仅 rolcanlogin=t，其余特权均为 f。
-- bare-metal 期望：上述三角色均非 superuser 且旧 pocketctl 的 rolcanlogin=f；本地 postgres 负责维护。
SELECT pg_get_userbyid(datdba) AS db_owner FROM pg_database WHERE datname = 'pocketctl';
-- 期望:pocketctl_app
```

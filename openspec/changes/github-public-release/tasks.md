## 1. Relay URL 配置化

- [x] 1.1 在 `internal/config/config.go` 中增加 `ProdRelayURL` 字段，支持从 `~/.pocketctl/auth.json` 读写
- [x] 1.2 重构 `cmd/pocketctl/main.go` 中 relay URL 解析逻辑，实现四级优先级：`--relay-url` > `POCKETCTL_RELAY_URL` 环境变量 > `--prod` 读 config > 默认 `ws://localhost:3000/ws`
- [x] 1.3 删除 `cmd/pocketctl/main.go` 中所有 `39.106.218.47` 硬编码（约 6 处）
- [x] 1.4 修改 `scripts/install-daemon.sh`，`--prod` 时将生产 relay URL 写入 `~/.pocketctl/auth.json` 的 `prod_relay_url` 字段
- [ ] 1.5 本地验证：`make build && ./pocketctl daemon start --prod` 正常连接生产 relay

## 2. 敏感数据清理

- [x] 2.1 `relay/src/config/sms.ts`：删除 `TemplateId` 的 fallback `'2661504'`，改为必填环境变量 `SMS_TEMPLATE_ID`
- [x] 2.2 `relay/src/auth.ts`：删除 JWT secret 的 fallback `'dev-secret-change-in-production'`，改为必填环境变量 `JWT_SECRET`
- [x] 2.3 `relay/src/server.ts`：删除测试手机号 `'13800138000'` 和测试验证码 `'000000'` 的 fallback，改为从 `DEV_SMS_PHONE` 和 `DEV_SMS_CODE` 环境变量读取
- [x] 2.4 `relay/.env.example`：清理所有真实值（API Key、密码、模板 ID、业务签名），替换为空占位符
- [x] 2.5 执行 `git rm --cached .env.prod` 并在 `.gitignore` 中追加 `.env.prod` 和 `.env.production`
- [ ] 2.6 本地验证：`cd relay && npx tsx src/server.ts` 在缺少环境变量时正确报错退出

## 3. GitHub 同步基础设施

- [x] 3.1 编写 `scripts/sync-github.sh`：白名单 rsync 同步 + 推送前敏感信息 grep 扫描 + 自动 commit/push
- [x] 3.2 编写面向开源社区的英文 `README.md`（GitHub 版本，放在同步脚本的目标目录中）
- [x] 3.3 创建 `LICENSE` 文件（MIT）
- [x] 3.4 修改 `Makefile` 中 `release` 命令：`git push origin` 改为 `git push github`
- [ ] 3.5 首次运行同步脚本，推送代码到 GitHub
- [ ] 3.6 在 GitHub 仓库中验证：`grep -r "39.106\|d2a111\|pocketctl_prod_2026\|2661504\|北京乐呵"` 无结果

## 4. 首次 Release 验证

- [x] 4.1 在 develop 分支完成所有改动，本地测试通过
- [x] 4.2 合并 develop → master（Gitee）
- [x] 4.3 运行同步脚本更新 GitHub 仓库
- [x] 4.4 打 tag `v0.1.0` 并推送到 GitHub：`git tag v0.1.0 && git push github v0.1.0`
- [x] 4.5 验证 GitHub Actions 构建成功，Release 页面包含 4 个平台二进制 + SHA256 校验文件
- [x] 4.6 测试安装：`curl -fsSL .../install-daemon.sh | bash` 并验证 `pocketctl version` 输出 v0.1.0

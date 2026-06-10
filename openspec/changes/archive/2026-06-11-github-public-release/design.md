## Context

pocketctl 当前所有代码（Daemon/Relay/Web/iOS/部署配置）都在 Gitee 私有仓库中，通过 Webhook 实现 master 合并自动部署。代码中硬编码了生产服务器 IP `39.106.218.47`（6处）、智谱 AI API Key、数据库密码等敏感信息。

目标是将 Daemon + Relay + Web 代码安全发布到 GitHub 公开仓库 `pocketctl/pocketctl`，实现 GitHub Releases 二进制分发。Gitee 全量代码 + Webhook 自动部署流程必须保持不变。

约束：
- 域名尚未备案（1-2 周周期），无法使用自定义域名
- GitHub org `pocketctl` 已创建，空仓库已就绪
- 本地 git remote 已配置：`origin`（Gitee）+ `github`（GitHub）

## Goals / Non-Goals

**Goals:**
- 代码本身不含任何敏感信息，编译产物可被安全公开
- `--prod` relay URL 从配置文件读取，不再硬编码在二进制中
- 通过同步脚本将精简代码推送到 GitHub
- GitHub Actions 自动构建 + Release 分发
- 首次 Release v0.1.0 流程跑通

**Non-Goals:**
- 不做 Linux 实机测试（后续）
- 不做域名相关改动（备案后单独处理）
- 不做 Homebrew formula 自动化更新（后续）
- 不清理 git 历史中的敏感信息（Gitee 私有仓库，暂不需要）
- 不做 Gitee Webhook 自动同步到 GitHub（手动同步脚本即可）

## Decisions

### D1: Relay URL 四级优先级

**决定**: `--prod` 不再硬编码 URL，而是通过四级优先级解析：
1. `--relay-url` CLI 参数（最高）
2. `POCKETCTL_RELAY_URL` 环境变量
3. `--prod` 标志 → 读取 `~/.pocketctl/auth.json` 中的 `prod_relay_url`
4. 默认 `ws://localhost:3000/ws`（开发模式）

**备选方案**:
- (a) ldflags 编译时注入 URL — 放弃，因为安装脚本还需要知道 URL 来写入配置，且二进制反编译仍可获取
- (b) 完全去掉 `--prod` — 放弃，用户体验变差，每次都要手动指定 URL

**理由**: 配置文件方案让安装脚本成为唯一知道生产 URL 的地方，域名备案后只需改安装脚本，老用户更新即可自动使用新配置。

### D2: 独立 GitHub 仓库 + 白名单同步脚本

**决定**: GitHub 作为独立仓库，用 `rsync` 白名单方式从 Gitee 仓库同步指定目录。

**备选方案**:
- (a) 同仓库双 remote + 公开分支 — 放弃，需要维护额外分支，合并时容易泄露敏感信息
- (b) git subtree — 放弃，操作复杂，对主仓库有侵入性

**理由**: 独立仓库最简单、最安全。白名单方式确保只有明确指定的文件才会被同步。

### D3: 敏感值不设 fallback，缺则报错

**决定**: 所有敏感配置（JWT_SECRET、SMS_TEMPLATE_ID 等）删除 fallback 默认值，未设置时服务启动报错。

**备选方案**:
- (a) 保留 dev fallback — 放弃，容易导致生产环境意外使用默认值

**理由**: fail-fast 原则。宁可启动失败，也不要静默使用不安全的默认值。

### D4: .env.prod 从 git 移除跟踪但不清理历史

**决定**: `git rm --cached .env.prod`，加入 `.gitignore`，不使用 BFG 清理历史。

**理由**: Gitee 是私有仓库，历史中的敏感信息不对外暴露。BFG 需要 force push，对一个人开发的私有仓库来说收益不值得风险。

## Risks / Trade-offs

- **[Risk] 现有 Gitee 部署流程受影响** → deploy.sh 保留在 Gitee，服务器上 `.env.prod` 文件已存在不受影响。`--prod` 改为配置驱动后，服务器上的 daemon 更新后需要确认 config.json 有 `prod_relay_url` → 安装脚本 `--prod` 会自动写入。
- **[Risk] GitHub Actions 首次运行可能失败** → Go 1.25 版本在 Actions 环境中的兼容性需要验证，需要关注 `actions/setup-go` 是否支持 1.25。
- **[Risk] 同步脚本可能遗漏敏感文件** → 同步后用 `grep -r` 扫描 GitHub 仓库验证。

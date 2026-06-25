## 1. daemon updater.go — 常量 + 版本查询

- [x] 1.1 新增 `giteeAPI` / `giteeDL` 常量（Gitee Release API 和下载地址），保留原有 `githubAPI` / `githubDL`
- [x] 1.2 `CheckLatest()` 改为先请求 Gitee API `/releases/latest`，10s 超时；失败/非 200 则 fallback 原 GitHub 逻辑
- [x] 1.3 `CheckVersion()` 改为先验证 Gitee Release tag URL，失败则 fallback GitHub tag URL

## 2. daemon updater.go — 二进制下载双源

- [x] 2.1 `ResolveBinary()` 改为遍历 `[{giteeDL, giteeAPI}, {githubDL, githubAPI}]`，每一组先构造 URL + 请求 `.sha256`，成功即返回；两组都失败才报错
- [x] 2.2 新增 `giteeClient` 带 10s 超时的 HTTP client（或复用 `http.DefaultClient` 加超时）
- [x] 2.3 `go build ./cmd/pocketctl/` + `go vet ./internal/update/...` 确保编译和静态检查通过

## 3. install.sh Gitee 源

- [x] 3.1 脚本顶部新增 `REPO_GITEE="muwb123/pocketctl"`，构造 `GITEE_URL` 和 `GITHUB_URL`
- [x] 3.2 新增 `download()` 函数（封装 curl `--connect-timeout 10 --max-time 120 -fsSL`）
- [x] 3.3 主流程改为：先 `download "$GITEE_URL"`，失败则 `download "$GITHUB_URL"`，都失败才报错退出
- [x] 3.4 SHA256 校验文件 URL 改用对应源的 `${BINARY_URL}.sha256`

## 4. CI — GitHub Actions 推 Gitee Release

- [x] 4.1 在 `.github/workflows/release.yml` 的 `upload-release-assets` 之后新增 `upload-gitee-release` job（或 step）
- [x] 4.2 实现 Gitee Release 创建：`curl -X POST gitee.com/api/v5/repos/muwb123/pocketctl/releases`，传入 `tag_name` / `name` / `body` / `target_commitish`
- [x] 4.3 循环上传 8 个资产文件：4 个二进制 + 4 个 `.sha256`，使用 Gitee `attach_files` API（multipart/form-data）
- [x] 4.4 整个 `upload-gitee-release` 步骤设置 `continue-on-error: true`，Gitee 失败不影响 workflow
- [x] 4.5 读取 `${{ secrets.GITEE_TOKEN }}` 作为 Authorization header；token 未配置时跳过（不报错）

## 5. 验证

- [x] 5.1 本地 `make build` 编译 daemon，`pocketctl daemon update --version v0.2.11` 确认能从 Gitee 下载
- [x] 5.2 模拟 Gitee 不可达（临时用无效 URL）确认 fallback GitHub 正常工作
- [x] 5.3 本地运行 install.sh 确认优先走 Gitee 下载
- [ ] 5.4 推送 tag v0.2.13 触发 CI，确认 Gitee Release 自动创建并含 8 个资产文件（需先配置 GITEE_TOKEN secret）
- [ ] 5.5 `pocketctl daemon update` 端到端：Gitee 查版本 → Gitee 下载 → SHA256 校验 → ReplaceBinary → 重启（需 Gitee Release 二进制就绪）

## 6. 文档

- [x] 6.1 README.zh-CN.md 安装章节补充国内用户可直接走 Gitee 下载的说明
- [x] 6.2 `relay/.env.example` 无需改动（daemon 端无新环境变量）

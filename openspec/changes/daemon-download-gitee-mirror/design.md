## Context

> ⚠️ **已废弃 (2026-06-26)**：本方案的 Gitee 镜像路线经实测不可行。
> - Gitee API `GET /repos/muwb123/pocketctl/releases/latest` 返回 `404 Not Found Project`
> - Gitee Release 资产匿名下载返回 `403 Forbidden`（必须登录）
> - 即便 CI 推送成功，用户也无法匿名下载，方案失去意义
>
> 实际落地的替代方案：**多公益代理轮询 + GitHub 直连兜底**（见
> `internal/update/updater.go` 的 `ghProxies` 与 `nginx/html/install.sh`
> 的下载源列表）。CI 中的 `upload-gitee-release` job 已删除。
>
> 下面的内容仅作历史记录保留。

---

`pocketctl daemon update` 和 `install.sh` 当前仅从 GitHub Releases 下载二进制。GitHub 在国内访问速度慢，国内用户需要 Gitee 镜像。GitHub Actions 已自动构建全平台二进制并发布 GitHub Release，但二进制不会自动出现在 Gitee Release。

## Goals / Non-Goals

**Goals:**
- daemon update 版本查询优先 Gitee API，失败 fallback GitHub API
- daemon update 二进制下载优先 Gitee Release，失败 fallback GitHub Release
- install.sh 优先 Gitee 下载，失败 fallback GitHub
- CI 自动推送二进制和 SHA256 到 Gitee Release
- Gitee 源不可用时零影响（对现有用户行为完全不变）

**Non-Goals:**
- 不改变 GitHub Release 的发布流程
- 不改变 daemon update 的 ReplaceBinary 和 RestartDaemon 逻辑
- 不支持自建 relay 作为下载源（pocketctl.me/dl/）——本 change 仅做 Gitee
- 不实现多源并发下载（sequential fallback only——避免浪费带宽）

## Decisions

### Decision 1: 版本查询策略

**选择**：Gitee Release API → GitHub Release API，sequential fallback。

`CheckLatest()` 和 `CheckVersion()` 先调 Gitee API：
- Gitee API URL: `https://gitee.com/api/v5/repos/muwb123/pocketctl/releases/latest`
- Gitee API URL (by tag): `https://gitee.com/api/v5/repos/muwb123/pocketctl/releases/tags/{tag}`

使用 10 秒超时的 HTTP client。如果 Gitee API 不可达（非 200、超时、TLS 错误），自动降级到原 GitHub API 逻辑。

**备选方案**：Gitee 和 GitHub 并发请求，取最先返回的结果。**放弃原因**：增加代码复杂度但收益有限——版本查询只是小 JSON 请求，串行 fallback 延迟可接受（Gitee 失败后 GitHub 通常 < 2 秒）。

### Decision 2: 二进制下载 URL 构造

**选择**：`ResolveBinary()` 返回单个 `BinaryInfo`。内部先尝试 Gitee 源（构造 URL + fetch .sha256），成功则返回 Gitee URL；失败则尝试 GitHub（原逻辑）。

```go
const (
    giteeAPI = "https://gitee.com/api/v5/repos/muwb123/pocketctl/releases"
    giteeDL  = "https://gitee.com/muwb123/pocketctl/releases/download"
    githubAPI = "https://api.github.com/repos/pocketctl/pocketctl/releases"
    githubDL  = "https://github.com/pocketctl/pocketctl/releases/download"
)

func ResolveBinary(tag string) (*BinaryInfo, error) {
    name := fmt.Sprintf("pocketctl_%s_%s", goos, goarch)
    sources := []struct{ dl, api string }{
        {giteeDL, giteeAPI},
        {githubDL, githubAPI},
    }
    for _, s := range sources {
        url := fmt.Sprintf("%s/%s/%s", s.dl, tag, name)
        sha, err := fetchSHA256(url + ".sha256")
        if err == nil && sha != "" {
            return &BinaryInfo{OS, Arch, url, sha, name}, nil
        }
    }
    return nil, fmt.Errorf("binary %s not found on any source", name)
}
```

**备选方案**：`BinaryInfo.URL` 改为 `[]string`，`DownloadAndVerify` 遍历。**放弃原因**：拆开下载和 SHA256 校验序列。当前设计 SHA256 必须来自同一源（不能交叉），在 `ResolveBinary` 层面保证 SHA256 和 URL 同源更安全。

### Decision 3: Gitee API 认证

Gitee Release API 的 `/latest` 端点**可能要求认证**（公开仓库也可能限制），但 tag 下载 URL 不需要认证。

策略：
- `CheckLatest`/`CheckVersion`：不传 Authorization header（匿名访问）。如果 Gitee 返回 401/403，fallback GitHub
- 二进制下载 URL：直接 HTTP GET，无需认证

如果后续 Gitee API 强制要求认证，可以加 `GITEE_TOKEN` 环境变量（daemon 端读 ~/.pocketctl/auth.json 或环境变量），但目前不做。

### Decision 4: CI 上传 Gitee Release

在 `.github/workflows/release.yml` 的 `upload-release-assets` 步骤之后，新增 `upload-gitee-release` 步骤。

**Gitee Release 创建逻辑**：
1. 通过 Gitee API v5 `POST /repos/muwb123/pocketctl/releases` 创建 Release
   - `tag_name`: `${GITHUB_REF_NAME}`
   - `name`: `${GITHUB_REF_NAME}`
   - `body`: `"Release ${GITHUB_REF_NAME} — see GitHub Release for details: ${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/releases/tag/${GITHUB_REF_NAME}"`
   - `target_commitish`: `master`
2. 上传每个资产：`POST /repos/muwb123/pocketctl/releases/{release_id}/attach_files`
   - 注意：Gitee attach_files API 要求 multipart/form-data，字段名 `file`

**非阻塞设计**：整个 `upload-gitee-release` 步骤用 `continue-on-error: true`。如果 Gitee 上传失败（token 无效、网络问题），workflow 不失败，GitHub Release 不受影响。

### Decision 5: install.sh 多源下载

脚本改为顺序尝试两个 URL：

```bash
REPO_GITHUB="pocketctl/pocketctl"
REPO_GITEE="muwb123/pocketctl"

GITEE_URL="https://gitee.com/${REPO_GITEE}/releases/download/v${VERSION}/${BINARY}"
GITHUB_URL="https://github.com/${REPO_GITHUB}/releases/download/v${VERSION}/${BINARY}"

# Try Gitee first (国内快), fallback GitHub
download() {
    local url=$1
    curl --connect-timeout 10 --max-time 120 -fsSL "$url" -o "$TMP_FILE" 2>/dev/null && return 0
    return 1
}

if download "$GITEE_URL"; then
    SHA_URL="${GITEE_URL}.sha256"
elif download "$GITHUB_URL"; then
    SHA_URL="${GITHUB_URL}.sha256"
else
    echo "下载失败，请检查网络"
    exit 1
fi
```

## Risks / Trade-offs

| Risk | Mitigation |
|---|---|
| Gitee API 返回 401/403（认证问题） | `CheckLatest` 自动 fallback GitHub API，不影响版本查询 |
| Gitee Release 没有二进制（CI 上传失败） | `ResolveBinary` 自动 fallback GitHub，daemon update 正常工作 |
| Gitee 下载的 SHA256 与 GitHub 不同 | 不会发生——同一 tag 的二进制是相同文件，SHA256 必须一致。校验时使用**对应源的** .sha256 文件 |
| `GITEE_TOKEN` secret 未配置 | CI 步骤 `continue-on-error: true`，不阻塞 workflow |
| 首次安装用户走 GitHub（无 Gitee Release） | 与当前行为一致，零影响 |

## Open Questions

- Gitee Release API 是否需要认证？之前 curl 返回 "Not Found Project"——需要在 CI 中实际测试 GITEE_TOKEN 是否能正常创建 Release
- Gitee Release 的 `/latest/download/` URL 是否支持？如果 Gitee 不支持 "latest" 重定向，install.sh 需要先查版本号再拼 URL

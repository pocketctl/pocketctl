package main

import "github.com/pocketctl/pocketctl/internal/i18n"

func memoryHelp() string {
	if i18n.Current() == i18n.Chinese {
		return memoryHelpZh
	}
	return memoryHelpEn
}

const memoryHelpZh = `用法:
  pocketctl memory sync-repo --repo <仓库路径> [选项]
  pocketctl memory --help
  pocketctl memory sync-repo --help

将已提交的代码同步到 Memory，供 Web「Memory → 代码图谱」查看依赖和分析变更影响。
此命令主动上传筛选后的源代码；不会由 daemon 自动执行，也不需要重启 daemon。

选项:
  --repo <路径>                  必填，Git 仓库内的目录
  --dry-run                      本地预览清单、大小和排除原因，不登录、不联网、不上传
  --committed                    忽略暂存区/工作区改动，只读取固定的已提交 HEAD
  --include <仓库相对路径>         仅选择该文件/目录，可重复，例如 --include web/src
  --scope-installation-id <UUID>  上传到团队/组织 Memory；省略则使用个人范围
  --allow-partial                 明确允许达到文件数/总大小上限后的截断快照
  --allow-empty                  明确允许发布空图谱（例如删除所有入选代码后）
  --full                         传输全部入选文件正文；默认协商复用已有正文
  -h, --help                     显示帮助并成功退出

首次使用:
  1. pocketctl login；在 Web 代码图谱页允许个人代码上传（团队由管理员授权）。
  2. 服务端须开启 MEMORY_CODEGRAPH_MODE；团队还需共享范围开关和 contribute 权限。
  3. 先预览，再移除 --dry-run 进行同步：
     pocketctl memory sync-repo --repo . --dry-run
     pocketctl memory sync-repo --repo .
  4. Web「Memory → 代码图谱」选择同一范围和仓库，刷新等待 Worker 解析完成。
     输出 repository_id 是仓库 ID，snapshot_id 是本次快照 ID；两者不能混用。

例子:
  pocketctl memory sync-repo --repo . --committed --dry-run
  pocketctl memory sync-repo --repo . --include web/src --include memory/src
  pocketctl memory sync-repo --repo . --scope-installation-id <范围UUID>

同步语义与限制:
  默认要求暂存区和工作区干净；dirty_worktree/dirty_index 时提交改动，或显式用 --committed。
  只读取已提交文件，不读取未跟踪/忽略文件，不跟随符号链接；--committed 不包含未提交代码。
  默认发送完整文件清单，只上传服务端缺失的正文；删除文件会从新快照消失。
  复用限于同一 Memory 范围和仓库；正文清理后需要重传。相同的已完成快照直接复用。
  --full 对新建或未完成的快照传输全部入选正文。
  每次最多 5000 个文件、64 MiB 总正文、单文件 256 KiB；达到总量上限默认拒绝上传。
  大仓库用 --include 或已提交的 .pocketctlmemoryignore 缩小范围，再次 dry-run 检查。
  .pocketctlmemoryignore 支持相对路径、目录前缀、* 和 ?；不支持 ** 和反向包含。
  凭据/私钥、二进制、不支持的语言和扫描出的敏感内容会被排除；请在预览中检查清单。
  TypeScript/JavaScript 提取符号和依赖，其余支持语言仅到文件级；部分覆盖会标记 partial。
  ready 代表入队完成，active 才代表图谱已发布；503 表示服务端功能关闭或门禁未开放。
`

const memoryHelpEn = `Usage:
  pocketctl memory sync-repo --repo <path> [options]
  pocketctl memory --help
  pocketctl memory sync-repo --help

Upload committed source to Memory for Web Memory → Code Graph and change-impact analysis.
This is an explicit source upload, independent of daemon startup; no daemon restart is needed.

Options:
  --repo <path>                  Required: a directory inside a Git repository
  --dry-run                      Local preview; no login, network, or upload
  --committed                    Read only pinned committed HEAD, ignoring index/worktree edits
  --include <relative-path>       Select a file/directory prefix; repeatable
  --scope-installation-id <UUID> Target a team/organization Memory; defaults to personal
  --allow-partial                 Allow truncation at the file-count/total-byte limits
  --allow-empty                  Allow publishing an empty graph (e.g. all selected files deleted)
  --full                         Transfer all selected bodies; default reuses retained content
  -h, --help                     Show this help and exit successfully

Getting started:
  1. pocketctl login; allow personal source uploads on the Web Code Graph page (shared scopes require admin authorization).
  2. Server MEMORY_CODEGRAPH_MODE must be enabled; shared scopes also need the shared
     feature gate and contribute permission.
  3. Preview, then upload:
     pocketctl memory sync-repo --repo . --dry-run
     pocketctl memory sync-repo --repo .
  4. Open Web Memory → Code Graph, select the same scope/repository, and refresh
     after the Worker finishes. repository_id identifies the repository;
     snapshot_id identifies one snapshot, and is not a repository ID.

Examples:
  pocketctl memory sync-repo --repo . --committed --dry-run
  pocketctl memory sync-repo --repo . --include web/src --include memory/src
  pocketctl memory sync-repo --repo . --scope-installation-id <scope-UUID>

Behavior and limits:
  Default requires a clean index/worktree. For dirty_worktree/dirty_index, commit first
  or explicitly use --committed. Uncommitted changes are never uploaded.
  Only committed blobs are read; untracked/ignored files and symlink targets are never read.
  Each sync verifies a complete manifest and uploads only missing bodies. Deletions are
  absent from the new snapshot. Reuse is limited to the same scope/repository; expired
  bodies must be uploaded again. Completed identical snapshots are reused directly.
  --full transfers all selected bodies for new or unfinished snapshots.
  Limits: 5000 files, 64 MiB total, 256 KiB/file. Limit truncation blocks upload by default.
  Use --include or a committed .pocketctlmemoryignore, then inspect another --dry-run.
  Ignore rules support relative paths, directory prefixes, * and ?; no ** or negation.
  Credentials/private keys, binary/unsupported files, and detected secrets are excluded.
  TS/JS provide symbols/dependencies; other supported languages are file-only. Filtered
  or truncated snapshots report partial coverage. Inspect the preview before uploading.
  ready means queued, active means published. HTTP 503 indicates a disabled server gate.
`

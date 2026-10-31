# Memory 代码图谱使用说明

本轮代码为本地实现，未部署线上；需要一起更新 CLI、Web、Memory API 和 Worker，Memory 启动时应用 migration 74。升级前的 CLI 仍是全量正文传输，不能使用新参数；新 CLI 不能凭帮助说明推断线上已经开放代码图谱。代码同步由命令主动执行，无需重启主机 daemon。

## 先查看帮助

```sh
pocketctl help
pocketctl memory --help
pocketctl help memory
pocketctl memory sync-repo --help
```

主帮助列出 Memory，子帮助包含完整参数、首次授权、上传语义、大小限制与故障处理。`pocketctl memory` 无参数也显示帮助并成功退出；所有帮助路径都不采集文件、不要求登录、不联网。

## 首次同步个人仓库

1. 使用 `pocketctl login` 登录。在 Web 的「Memory → 代码图谱」展开「同步仓库与使用说明」，点击「允许个人范围的代码上传」。此操作只增加 `memory.codegraph.write` 授权，不执行上传。
2. 管理员确认 Memory API/Worker 的 `MEMORY_CODEGRAPH_MODE=enabled`。这是服务端开关，与账号服务授权分开。API 和 Worker 都须更新；仅显示模块不表示解析已运行。
3. 在仓库主机先预览，再上传：

```sh
pocketctl memory sync-repo --repo /path/to/repo --dry-run
pocketctl memory sync-repo --repo /path/to/repo
```

`--dry-run` 完全本地运行，输出提交、清单哈希、入选数量、正文大小及排除原因。正式同步会上传筛选后的源代码，请先检查预览。

成功后输出 `repository_id`、`snapshot_id`、状态、上传文件数/字节数、复用文件数及 `view_url`。打开该链接，或在 Web 选择个人范围和仓库名称。`repository_id` 是仓库 UUID；`snapshot_id` 是某次提交快照 UUID，两者不可互换。

上传完成的 `ready` 表示等待 Worker；`parsing` 表示解析中，`active` 表示图谱已发布。刷新列表和图谱读取最新结果。若新提交尚未解析，旧图谱继续标明其原提交，不把旧图谱当作最新提交。

## 未提交改动与大仓库

默认要求暂存区和工作区干净，避免误以为同步包含本地未提交代码。出现 `dirty_worktree` / `dirty_index` 时，可以先提交，也可以明确只同步已提交版本：

```sh
pocketctl memory sync-repo --repo . --committed --dry-run
pocketctl memory sync-repo --repo . --committed
```

`--committed` 固定读取命令开始时解析出的 HEAD 和 Git blob，不读取暂存或工作区正文，不执行 stash/reset/checkout，不包含未提交改动。未跟踪文件与忽略文件始终不会上传。

最多 5000 个入选文件、64 MiB 总正文、单文件 256 KiB。达到文件数或总大小上限时，预览会警告；正式同步默认停止，避免把截断结果当作完整仓库。

```sh
# --include 可重复，均为相对仓库根目录的文件或目录前缀
pocketctl memory sync-repo --repo . --include web/src --include memory/src --dry-run
pocketctl memory sync-repo --repo . --include web/src --include memory/src
```

也可提交仓库根目录 `.pocketctlmemoryignore`，用相对路径、目录前缀、`*`、`?` 排除不需要的内容；不支持 `**` 或反向包含。未提交的 ignore 文件不生效。检查预览后若确实接受截断，可加 `--allow-partial`。对全部入选代码均已删除的仓库，用 `--allow-empty` 明确发布空图谱，清空最后的旧节点。

敏感文件、私钥、扫描出的凭据、二进制、空文件、生成声明文件、锁文件和不支持的文件会被排除。过滤只是辅助，不能替代检查源代码。入选范围、排除统计和部分覆盖标记随快照保存；部分选择或过滤不会宣称覆盖整个仓库。旧快照没有选择记录时按未知的部分覆盖显示。

## 是否只上传改动

默认传输是「完整清单 + 缺失正文」：

- 首次通常上传全部入选正文。
- 后续在同一 Memory 范围、同一仓库内校验已保留正文的哈希和大小，复用可用内容，只传输缺失/变化的正文。
- 新快照仍校验完整清单。删除文件从新清单消失，图谱移除对应节点；不是仅对 `git diff` 建图。
- 复用不跨团队、个人范围或仓库。服务端清理旧正文后需要重传。
- 相同已完成快照直接复用；历史 `superseded` 快照重放不会重新发布为当前图谱。`--full` 为新建或未完成快照传输全部入选正文，跳过复用协商；不会重复覆盖已发布快照。

新服务端保持原有 start/files/finalize 协议兼容，并新增 manifest 协商。新 CLI 发送选择元数据，需本轮 Memory 版本；若只有协商接口未提供，可显式用 `--full`，不会遇到错误后自动扩大上传量。

## 团队或组织范围

管理员需提前为目标 Memory installation 配置 `memory.codegraph.write`，并开放 `RELAY_EXTENSION_V2` 与 `MEMORY_SHARED_SCOPES_MODE`。CLI 登录用户必须拥有该范围的 `contribute` 权限；Web 查看需要 `read`。当前页面只提供个人上传服务授权按钮，共享范围服务仍由管理员配置，不会自动扩大团队授权。

在 Web 选择目标范围，页面会显示带正确 installation UUID 的命令：

```sh
pocketctl memory sync-repo --repo . --scope-installation-id <范围UUID> --dry-run
pocketctl memory sync-repo --repo . --scope-installation-id <范围UUID>
```

范围 UUID 不是团队 ID、仓库 ID 或快照 ID。图谱、仓库列表与影响分析全部使用同一范围授权。指定范围失效或不可访问时显示错误，不回退读取个人数据；切换范围/仓库会清除结果和在途响应。

## 查看与分析

在 Web「Memory → 代码图谱」选择范围、仓库并刷新。源码索引列出文件/符号，选择节点查看导入、定义、调用或引用关联。图谱标明提交、解析器版本与覆盖程度。TypeScript/JavaScript 支持符号和依赖解析，Go 等其他支持语言目前仅提供文件级信息。

在「改动影响」输入仓库相对路径（每行一个），运行分析。分析有深度、节点和边数上限；`partial` 表示结果有覆盖限制，不是证明其他文件绝不受影响。源码同步、代码图谱与 Git Ops 文档同步是不同入口；Git Ops 创建项目不会自动运行主机的源码同步。

## 常见问题

| 提示 | 处理 |
| --- | --- |
| `dirty_worktree` / `dirty_index` | 提交改动，或明确用 `--committed` 仅同步 HEAD |
| `partial_snapshot_requires_consent` | 用 `--include` 或已提交 ignore 缩小范围；确实接受截断再加 `--allow-partial` |
| `empty_selection` | 检查入选范围；确实要清空图谱时加 `--allow-empty` |
| `service_disabled` / 403 | 检查上传服务授权与目标范围贡献权限 |
| 503 | 管理员检查 Code Graph 和共享范围服务端开关，不是重启主机 daemon |
| `ready` 长时间不变 | 检查 Memory Worker 版本、运行状态、队列与代码图谱开关 |
| 404 / 无已发布图谱 | 选择同一范围，完成同步后等待解析并刷新；不要把快照 ID 当仓库 ID |
| `manifest_mismatch` / `integrity_mismatch` | 清单、内容或重试输入不一致；修复原因后重试，不跳过校验 |

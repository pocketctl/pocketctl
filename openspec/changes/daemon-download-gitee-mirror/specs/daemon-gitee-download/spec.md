## ADDED Requirements

### Requirement: daemon update 从 Gitee Release 查询最新版本

`CheckLatest()` 和 `CheckVersion()` SHALL 优先查询 Gitee Release API（`gitee.com/api/v5/repos/muwb123/pocketctl/releases`），失败时自动 fallback 到 GitHub Release API（`api.github.com/repos/pocketctl/pocketctl/releases`）。

#### Scenario: Gitee API 正常返回最新版本

- **WHEN** daemon 执行 `daemon update`（未指定版本）
- **AND** Gitee Release API 在 10 秒内返回 HTTP 200
- **THEN** 使用 Gitee API 返回的 `tag_name` 作为目标版本
- **AND** 不发起 GitHub API 请求

#### Scenario: Gitee API 不可达，fallback GitHub

- **WHEN** Gitee Release API 返回非 200 状态码、网络超时、或 TLS 错误
- **THEN** 系统自动尝试 GitHub Release API
- **AND** 如果 GitHub API 成功，使用其 `tag_name`
- **AND** 如果 GitHub API 也失败，返回错误给用户

#### Scenario: 指定版本号查询（带 v 前缀）

- **WHEN** 用户执行 `daemon update --version v0.2.11`
- **THEN** 系统 SHALL 构造 Gitee Release tag URL 验证该版本存在
- **AND** 失败时 fallback GitHub Release tag URL
- **AND** 如果指定版本在任一平台存在，返回该版本号

### Requirement: daemon update 从 Gitee Release 下载二进制

`ResolveBinary()` SHALL 返回 Gitee Release 和 GitHub Release 两个下载源 URL。`DownloadAndVerify()` SHALL 优先下载 Gitee URL，失败后尝试 GitHub URL。

#### Scenario: Gitee 下载成功

- **WHEN** Gitee Release 有对应的 `pocketctl_<os>_<arch>` 和 `.sha256` 文件
- **AND** 下载完成且 SHA256 校验通过
- **THEN** 返回临时文件路径，不尝试 GitHub URL

#### Scenario: Gitee 下载失败，fallback GitHub

- **WHEN** Gitee 下载返回非 200 状态码、网络超时、或 SHA256 校验不匹配
- **THEN** 系统自动尝试 GitHub Release 下载
- **AND** 使用 GitHub 的 .sha256 文件的校验值进行验证

#### Scenario: 两个源都失败

- **WHEN** Gitee 和 GitHub 下载都无法完成或 SHA256 校验都失败
- **THEN** 返回错误信息，提示用户检查网络或稍后重试

### Requirement: install.sh 从 Gitee Release 下载安装

`nginx/html/install.sh` SHALL 优先从 Gitee Release 下载二进制。如果 Gitee 下载失败（curl/wget 返回非 200、网络错误、SHA256 不匹配），SHALL 自动尝试 GitHub Release 作为 fallback。

#### Scenario: 国内用户从 Gitee 成功安装

- **WHEN** 用户执行 `curl -fsSL https://pocketctl.me/install.sh | bash`
- **AND** Gitee Release 有对应平台和架构的二进制
- **THEN** 脚本从 Gitee 下载、SHA256 校验通过、安装到 /usr/local/bin

#### Scenario: Gitee 不可用时 fallback GitHub

- **WHEN** Gitee 下载失败（任何原因）
- **THEN** 脚本自动尝试从 GitHub Release 下载
- **AND** 至少一个源成功时，安装继续

### Requirement: 双源 SHA256 校验

每个下载源 SHALL 提供独立的 SHA256 校验。`.sha256` 文件存在于同一 Release 中，文件名与二进制相同追加 `.sha256`。`DownloadAndVerify()` 和 `install.sh` SHALL 使用**对应源的** `.sha256` 文件进行验证（不能交叉使用——例如用 GitHub 的 SHA256 验证 Gitee 的文件）。

#### Scenario: SHA256 文件存在且校验通过

- **WHEN** 下载源的同路径下有 `.sha256` 文件且内容非空
- **AND** 下载的二进制 SHA256 与 `.sha256` 文件内容匹配
- **THEN** 校验通过，继续安装流程

#### Scenario: SHA256 文件缺失

- **WHEN** 下载源的 `.sha256` 文件不存在或返回 404
- **THEN** 跳过该源（视为下载失败），尝试下一个源

### Requirement: 向后兼容

所有改动为纯增量。如果 Gitee Release 没有二进制（首次发版前或上游失败），系统 SHALL 自动 fallback GitHub，对现有用户行为无任何变化。

#### Scenario: Gitee Release 不存在时的行为

- **WHEN** Gitee Release 的 tag 存在但没有任何二进制资产（如首次安装前仅同步代码 tag）
- **AND** GitHub Release 有完整二进制
- **THEN** daemon update 和 install.sh 自动走 GitHub 下载
- **AND** 用户体验与本次改动前完全一致

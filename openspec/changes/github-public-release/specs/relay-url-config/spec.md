## ADDED Requirements

### Requirement: Relay URL 四级优先级解析
Daemon 启动时解析 relay URL SHALL 按以下优先级：CLI 参数 `--relay-url` > 环境变量 `POCKETCTL_RELAY_URL` > `--prod` 标志读取配置文件 > 默认 `ws://localhost:3000/ws`。

#### Scenario: 显式指定 relay-url 参数
- **WHEN** 用户运行 `pocketctl daemon start --relay-url ws://custom:4000/ws`
- **THEN** daemon 连接到 `ws://custom:4000/ws`

#### Scenario: 通过环境变量指定
- **WHEN** 设置环境变量 `POCKETCTL_RELAY_URL=ws://env-host:5000/ws` 且未传 `--relay-url`
- **THEN** daemon 连接到 `ws://env-host:5000/ws`

#### Scenario: 使用 --prod 标志
- **WHEN** 用户运行 `pocketctl daemon start --prod`，且 `~/.pocketctl/auth.json` 中存在 `prod_relay_url` 字段
- **THEN** daemon 连接到 `prod_relay_url` 指定的地址

#### Scenario: --prod 但未配置 prod_relay_url
- **WHEN** 用户运行 `pocketctl daemon start --prod`，且 `~/.pocketctl/auth.json` 中不存在 `prod_relay_url` 字段
- **THEN** daemon 输出错误提示并退出，提示用户先运行安装脚本或手动配置

#### Scenario: 无任何参数的默认行为
- **WHEN** 用户运行 `pocketctl daemon start`，未传 `--relay-url`、`--prod`，也未设环境变量
- **THEN** daemon 连接到 `ws://localhost:3000/ws`（开发模式）

### Requirement: 安装脚本 --prod 写入配置
安装脚本 SHALL 在 `--prod` 模式下将生产 relay URL 写入 `~/.pocketctl/auth.json` 的 `prod_relay_url` 字段。

#### Scenario: --prod 安装时写入配置
- **WHEN** 用户运行 `curl .../install-daemon.sh | bash -s -- --prod`
- **THEN** 脚本下载二进制后将 `prod_relay_url` 写入 `~/.pocketctl/auth.json`

#### Scenario: 非 --prod 安装不写入配置
- **WHEN** 用户运行 `curl .../install-daemon.sh | bash`
- **THEN** 脚本只下载二进制，不修改 `~/.pocketctl/auth.json`

### Requirement: 代码中不含硬编码 IP 或域名
Go 源码和 Relay 源码中 SHALL 不包含任何硬编码的服务器 IP 地址或域名。所有外部服务地址 MUST 通过配置文件、环境变量或 CLI 参数传入。

#### Scenario: 编译产物不含服务器 IP
- **WHEN** 对编译后的 pocketctl 二进制执行 `strings pocketctl | grep -E '([0-9]{1,3}\.){3}[0-9]{1,3}'`
- **THEN** 不包含 `39.106.218.47` 或任何生产服务器 IP

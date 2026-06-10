## ADDED Requirements

### Requirement: SMS 配置不设 fallback 默认值
`relay/src/config/sms.ts` 中的 `TemplateId` 和 `SignName` SHALL 仅从环境变量读取，不设任何 fallback 默认值。未设置时服务启动 SHALL 报错退出。

#### Scenario: 环境变量已设置
- **WHEN** `SMS_TEMPLATE_ID` 和 `SMS_SIGN_NAME` 环境变量已设置
- **THEN** SMS 服务正常初始化

#### Scenario: 环境变量未设置
- **WHEN** `SMS_TEMPLATE_ID` 或 `SMS_SIGN_NAME` 环境变量未设置
- **THEN** Relay 服务启动时报错并输出缺失的环境变量名称

### Requirement: JWT 密钥不设 fallback 默认值
`relay/src/auth.ts` 中的 JWT 密钥 SHALL 仅从环境变量 `JWT_SECRET` 读取，不设任何 fallback 默认值。未设置时服务启动 SHALL 报错退出。

#### Scenario: JWT_SECRET 已设置
- **WHEN** `JWT_SECRET` 环境变量已设置
- **THEN** JWT 签名和验证正常工作

#### Scenario: JWT_SECRET 未设置
- **WHEN** `JWT_SECRET` 环境变量未设置
- **THEN** Relay 服务启动时报错并提示设置 `JWT_SECRET`

### Requirement: 开发测试号通过环境变量配置
`relay/src/server.ts` 中的开发测试手机号和验证码 SHALL 仅从环境变量 `DEV_SMS_PHONE` 和 `DEV_SMS_CODE` 读取，不设 fallback 默认值。

#### Scenario: 开发环境变量已设置
- **WHEN** `DEV_SMS_PHONE` 和 `DEV_SMS_CODE` 环境变量已设置且 Relay 运行在非生产模式
- **THEN** 使用环境变量中的测试手机号和验证码

#### Scenario: 开发环境变量未设置
- **WHEN** `DEV_SMS_PHONE` 或 `DEV_SMS_CODE` 环境变量未设置
- **THEN** 开发模式的快捷登录功能不可用，但不阻止启动（不影响生产模式）

### Requirement: .env.prod 从 git 跟踪中移除
`.env.prod` SHALL 从 git 跟踪中移除并加入 `.gitignore`，但文件保留在本地磁盘。

#### Scenario: git status 不显示 .env.prod
- **WHEN** 执行 `git status`
- **THEN** `.env.prod` 不出现在未跟踪或已修改文件列表中

#### Scenario: 本地 .env.prod 文件保留
- **WHEN** 执行 `git rm --cached .env.prod` 后
- **THEN** 本地 `.env.prod` 文件仍然存在，可正常使用

### Requirement: .env.example 仅含占位符
`relay/.env.example` 中 SHALL 不包含任何真实的 API Key、密码、模板 ID 或业务签名。所有值 MUST 为空或明显占位符。

#### Scenario: 检查 .env.example 内容
- **WHEN** 审查 `relay/.env.example` 文件内容
- **THEN** 不包含 `d2a111`、`pocketctl_prod_2026`、`2661504`、`北京乐呵乐呵` 等真实值

# 敏感信息发送与删除操作风险提示 — 设计文档

- **日期**: 2026-06-30
- **状态**: 已批准(待实现)
- **作者**: brainstorming with user
- **范围**: iOS App(SwiftUI)、Web Dashboard(Vue 3)。**仅客户端实现,零后端改动。**

## 1. 背景与目标

pocketctl 让用户从 iOS/Web 客户端继续驱动一个 AI 编码会话(Claude Code / Codex / OpenCode)。用户通过客户端向会话发送文本时,内容会经 WebSocket(`user_message`)明文传给 AI 会话,**全程无任何内容检查**。同时,agent 执行的工具调用(包括 `Bash rm -rf` 这类删除操作)会以审批卡片的形式呈现给用户,但**所有工具的卡片样式完全一致**,删除操作与普通 `Read` 看起来毫无差别。

本设计新增两类风险提示:

- **Feature A — 发送敏感信息拦截**:用户从客户端发送疑似密钥/私钥时,弹确认对话框,阻断式地把关。
- **Feature B — 删除操作分析提示**:对 `Bash` 删除类命令,把审批卡片升级为「高危」样式(红色 + ⚠️ 标识 + 破坏面摘要)。

### 核心约束(用户已确认)

| 决定 | 选择 |
|---|---|
| 交互模型 | **阻断式确认**(Feature A),**视觉提示**(Feature B,不加二次确认) |
| 适用会话 | **仅客户端创建的会话**(iOS/Web 创建,即后端 `source == "daemon"`) |
| Feature A 检测模式 | **已知密钥格式** + **私钥 / SSH 密钥块**(低误报) |
| Feature B 范围 | **仅增强现有审批卡片**(不做通用危险命令库) |
| Feature A 触发时机 | **发送时拦截** |
| 检测逻辑位置 | **纯客户端**(iOS Swift + Web TS 各一份) |

## 2. 架构与数据流

两个功能都是插在**现有流程上的纯客户端薄层**,不引入新的事件类型、不改协议、不改 daemon/relay。

```
Feature A(发送敏感信息拦截):
  用户输入 → 点发送 → sendMessage()
                      ├─ 现有校验(空 / 断线 / pending / 本地斜杠命令)
                      ├─ [新增] SecretDetector.detect(text)   ← 返回 [SecretMatch]
                      │     命中 → 弹确认对话框;用户确认后才继续,取消则不发送
                      └─ wsService.send(user_message)          ← 现有逻辑,不变

Feature B(删除操作分析提示):
  approval_request 事件(仅客户端创建会话才会到达客户端)
    → 渲染 ApprovalCard
    → [新增] 若 tool == "Bash",对 input.command 做删除模式检测
              命中   → 卡片升级为「高危」样式(红边框 + ⚠️ 标识 + 破坏面摘要)
              未命中 → 维持现有样式
```

### 关键简化:无需显式判断 `source`

后端会话有 `source` 字段(`"daemon"` = 客户端创建,`"terminal"` = 终端启动,定义见 `internal/session/manager.go:38`)。本设计**不需要**在客户端显式判断 `source`:

- **Feature B**:终端会话(`source == "terminal"`)在 `internal/approval/hook.go:118` 返回 `"ask"`,走 Claude 原生 y/n 提示,**根本不会向客户端下发 `approval_request` 事件**。所以客户端收到的每张审批卡片天然来自客户端创建的会话。
- **Feature A**:终端会话在客户端的输入栏本身不启用输入(`canSendMessage` 对终端会话关闭),用户无法从客户端对其发送消息。

### 为什么是纯客户端(而非启用 `DaemonEvent.RiskLevel`)

- `internal/protocol/types.go:56` 的 `RiskLevel` 字段确实存在但从未被任何生产者/消费者使用。
- Feature A 的 `user_message` 走的是 `internal/session/manager.go:1634` 的 PTY 写入路径,**不经过审批 broker**,若放后端需额外拦截点、跨进程协调、处理 daemon 离线回退,改动大。
- Feature B 的命令字符串在客户端已可直接提取(Web 的 `web/src/utils/toolDisplay.ts:34` `formatToolInput`、iOS 的 `SessionDetailViewModel.swift:1237`),客户端检测更直接。
- 代价:Swift/TS 两份正则需手动保持一致(但表很短、变动极少)。

## 3. 组件设计

### 3.1 Feature A 检测器(密钥检测)

两端各一个**纯函数**模块,逻辑等价、语法不同。

#### 检测模式表(精简、低误报)

| 类别 | 模式(正则) | 说明 |
|---|---|---|
| AWS | `AKIA[0-9A-Z]{16}` | IAM 访问密钥 ID |
| OpenAI | `sk-[a-zA-Z0-9]{20,}` | API key(兼容 `sk-proj-`、`sk-ant-` 等前缀变体) |
| GitHub | `gh[pousr]_[A-Za-z0-9]{36,}` | PAT / OAuth / fine-grained token |
| Slack | `xox[baprs]-[0-9a-zA-Z-]{10,}` | Bot / App / User token |
| Google API | `AIza[0-9A-Za-z_-]{35}` | Google API key |
| 私钥块 | `-----BEGIN [A-Z ]*PRIVATE KEY-----` | RSA / EC / OpenSSH / PGP 私钥头 |
| SSH 公钥 | `ssh-(rsa\|ed25519\|ecdsa) AAAA[0-9A-Za-z+/]+` | 私钥泄漏常伴随公钥,顺手提示 |

#### 返回值

```swift
// iOS
struct SecretMatch {
    let kind: String        // 人类可读类别,如 "GitHub Token"
    let preview: String     // 脱敏预览,前后各 4 位,中间 …,如 "ghp_xxxx…xxxx"
    let count: Int          // 该 kind 命中的实例数
}
```

```ts
// Web
interface SecretMatch {
  kind: string      // "GitHub Token"
  preview: string   // "ghp_xxxx…xxxx"
  count: number
}
```

#### 关键约束

- **只读检测**:绝不修改/存储用户输入,检测完原样发送。
- **不截断/不脱敏输入框**:用户可能就是想发送一段含密钥的日志,输入框文本保持原样。
- **多密钥去重**:同一种 kind 多个实例只显示一个 `preview` + `count`,避免确认框溢出;不同 kind 各列一行。
- **长度上限保护**:输入 > 50KB 直接放行不检测(正常聊天不会这么大;粘贴密钥通常 < 1KB),避免正则在超长文本上变慢。
- **检测失败不阻塞**:正则引擎异常 → 兜底放行(检测是"尽力而为",不能让误判异常卡死发送)。

### 3.2 Feature A 确认 UI(发送时拦截)

#### iOS(`SessionDetailView.swift` 发送流程)

- `sendMessage` 命中后,用 SwiftUI 原生 `.alert`(由 `@State` 驱动)弹确认:
  ```
  ⚠️ 检测到疑似敏感信息
  命中:GitHub Token ×1
  ghp_xxxx…xxxx
  发送后将以明文传输给 AI 会话,确认发送?
  [ 取消 ]   [ 仍要发送 ]
  ```
- 点「仍要发送」→ 走原有 `wsService.send`;点「取消」→ 不发送、**保留输入框内容**(用户可自行删改)。
- 复用点:`retryLastPrompt()` 内部调 `sendMessage`,自动覆盖。

#### Web(`SessionDetail.vue`)

- 不用原生 `confirm()`(项目用自研 UI)。加一个轻量模态:在输入栏上方/居中浮一个红色警告卡,带「仍要发送」「取消」按钮,确认后才真正 `send(...)`。
- 复用现有卡片样式(`web/src/components/` 已有同款卡片组件)。
- Enter 键发送(`onInputKeydown`)走 `sendMessage()` 函数体拦截,自动覆盖。

#### 关键约束

- 确认只在命中时出现**一次**;用户确认后本次发送不再重复弹窗。
- 检测发生在现有校验(空/断线/pending)之后、`send` 之前。

### 3.3 Feature B 审批卡片增强(删除操作)

两端对现有 `ApprovalCard` 做**条件性视觉升级**,不改变批准/拒绝的数据流。

#### 检测

- 渲染卡片时,若 `message.tool == "Bash"`,从 `input.command` 提取命令字符串(Web:`toolDisplay.ts:34` `formatToolInput`;iOS:`SessionDetailViewModel.swift:1237`),跑删除模式匹配。
- **删除模式**(命令行常见删除类,用 `\b` 词边界避免误报文件名如 `remove.txt`):
  - `\brm\b`
  - `\brmdir\b`
  - `\bunlink\b`
  - `\btrash\b`
  - `\bgit\s+clean\b`
  - `\bfind\b.*\s-delete\b`
- 命中后进一步解析破坏面:
  - `rm -rf`/`-fr` 的目标路径 → "将删除:`/path`"。
  - 危险标志额外标注:`-rf`、`-fr`、`--no-preserve-root`、`/*` 等。

#### 命中后的视觉变化

| 元素 | 默认(普通工具) | 命中删除命令 |
|---|---|---|
| 左侧 accent 条 + 边框 | `warning`(黄) | **`error`(红)** |
| 标题区标签 | 无 | ⚠️ **「高危:删除操作」** |
| 命令下方 | 无 | 一行**破坏面摘要**:"将删除:`/path`;危险标志:`-rf`" |
| 批准按钮文案 | "允许"/"批准" | 加前缀"仍批准"(**不加二次确认**) |

#### 未命中

维持现有卡片样式,零可见改动。

## 4. 错误处理与边界

| 场景 | 处理 |
|---|---|
| 检测器异常 | Feature A 兜底放行;Feature B 回退普通卡片。检测是"尽力而为"。 |
| 空输入 / 仅空白 | 复用现有 guard,不触发检测。 |
| 超长文本(> 50KB) | Feature A 直接放行不检测;Feature B 的 Bash 命令天然短,无需上限。 |
| 多密钥 | 同 kind 多实例只显示一个 preview + `count`;不同 kind 各列一行。 |
| retry 路径 | Feature A 自动覆盖(走 `sendMessage`);Feature B 无 retry 概念。 |
| 终端会话 | Feature A 不触发(输入栏不启用);Feature B 不触发(审批走 Claude 原生 `ask`,不下发卡片)。无需显式 source 判断。 |
| 已确认本次发送 | 不再重复弹窗(本次发送只弹一次)。 |

## 5. 测试

两端各一份**纯函数单测**(检测器 + 删除检测);UI 行为(确认框、卡片样式)人工验证。

| 测试目标 | 内容 |
|---|---|
| `SecretDetector` 正例 | `AKIA…`(AWS)、`sk-…`、`sk-proj-…`、`ghp_…`、`xoxb-…`、`AIza…`、`-----BEGIN RSA PRIVATE KEY-----`、`-----BEGIN OPENSSH PRIVATE KEY-----`、`ssh-rsa AAAA…`、`ssh-ed25519 AAAA…` |
| `SecretDetector` 负例 | 普通英文句子、`password=123`(因未选"敏感字段名"不命中)、短随机串、UUID(不应命中) |
| `SecretDetector` 边界 | 混合多密钥(不同 kind 各一行 + 同 kind count)、超长输入(> 50KB)跳过、空输入返回空 |
| 删除检测 正例 | `rm -rf /tmp/x`、`git clean -fd`、`find . -name '*.log' -delete`、`unlink a`、`rmdir b`、`trash c`、`rm --no-preserve-root /` |
| 删除检测 负例 | `cat README.md`、`echo "remove"`(不命中 `rm`)、`rm.txt` 文件名(不命中)、`chmod 644 a`(非删除) |
| 破坏面解析 | `rm -rf /a /b` → "将删除:`/a`, `/b`;危险标志:`-rf`";`git clean -fd` → "清理未跟踪文件" |
| `sendMessage` 拦截 | 命中时弹确认;取消则不发送且保留输入;确认则发送(单测验证状态流转) |
| 审批卡片渲染 | Bash 删除命令 → 红色 + 标签 + 破坏面;普通 Bash → 默认样式;非 Bash 工具 → 不检测 |

## 6. 受影响文件(实现时核对)

| 平台 | 文件 | 改动 |
|---|---|---|
| iOS 新增 | `ios/Pocketctl/Utils/SecretDetector.swift` | 密钥检测纯函数 + 单测 |
| iOS 新增 | `ios/Pocketctl/Utils/DeleteCommandDetector.swift`(或合并进 SecretDetector 同目录) | 删除命令检测 + 破坏面解析 |
| iOS 修改 | `ios/Pocketctl/ViewModels/SessionDetailViewModel.swift`(`sendMessage` ~L422) | Feature A 拦截 |
| iOS 修改 | `ios/Pocketctl/Views/SessionDetailView.swift` | 确认对话框 |
| iOS 修改 | `ios/Pocketctl/Views/Components/ApprovalCard.swift` | Feature B 视觉升级 |
| Web 新增 | `web/src/utils/secretDetect.ts` | 密钥检测纯函数 + 单测 |
| Web 新增 | `web/src/utils/deleteCommandDetect.ts` | 删除命令检测 + 破坏面解析 |
| Web 修改 | `web/src/views/SessionDetail.vue`(`sendMessage` ~L893) | Feature A 拦截 + 确认模态 |
| Web 修改 | `web/src/components/messages/ApprovalCard.vue` | Feature B 视觉升级 |

复用点(不改动,只读取):
- `web/src/utils/toolDisplay.ts:34` `formatToolInput`(提取 Bash `command`)
- `ios/Pocketctl/ViewModels/SessionDetailViewModel.swift:1237`(提取 Bash `command`)

## 7. 实现顺序建议(供 writing-plans 参考)

1. **检测器优先**(两端纯函数 + 单测)——可独立验证,无 UI 依赖。
2. **Feature A** 的 `sendMessage` 拦截 + 确认 UI。
3. **Feature B** 的审批卡片增强。

## 8. 非目标(明确不做)

- ❌ 不做敏感字段名检测(`password=`/`secret=`/`token=`)。
- ❌ 不做通用高熵字符串检测。
- ❌ 不做通用危险命令库(`sudo`/`chmod 777`/`curl|sh`/fork 炸弹)。
- ❌ Feature B 不加二次确认。
- ❌ 不改后端协议、不启用 `DaemonEvent.RiskLevel`、不改 daemon/relay。
- ❌ 不对终端会话生效(天然不触发)。
- ❌ 不做密钥检测结果的持久化/上报(纯只读、本地、即用即弃)。

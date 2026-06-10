## Context

pocketctl 的 Session 创建流程中，工作目录（cwd）从 iOS 端一路透传到 Go Daemon 的 `exec.Cmd.Dir`，中间没有任何默认值、路径解析或权限校验。当前行为：

- cwd 为空时：`cmd.Dir` 不设置，Go 默认用 Daemon 进程自身的工作目录（不可控）
- cwd 为绝对路径时：直接使用，无权限检查，失败后错误信息不友好
- iOS 端 placeholder 为 `/path/to/project`，暗示必须手动填写

Daemon 运行在用户的 Mac 上，`os.UserHomeDir()` 返回的就是当前登录用户的 home 目录，对该目录一定有完整读写权限。

## Goals / Non-Goals

**Goals:**
- cwd 为空或 `~` 时自动回退到用户 home 目录（`os.UserHomeDir()`）
- 支持 `~/xxx` 相对 home 的路径语法
- 启动进程前校验目录存在性、是否为目录、是否可访问
- 校验失败时返回友好错误信息给 iOS 端
- iOS 端 placeholder 和按钮逻辑适配新的默认行为

**Non-Goals:**
- 不做目录浏览器/文件选择器 UI（后续迭代）
- 不做目录自动发现或推荐列表
- 不在 Relay 层做路径校验（Daemon 负责）
- 不改变已运行 Session 的 cwd（只影响新建）

## Decisions

### D1: 路径解析放在 Go Daemon（非 iOS 或 Relay）

**选择**: Daemon 端 `resolveCwd()` 函数统一处理
**替代方案**: iOS 端展开 `~` → iOS 不知道远程 Mac 的 home 路径
**理由**:
- Daemon 是唯一知道远程文件系统的组件
- `os.UserHomeDir()` 在 Daemon 运行的机器上执行，结果准确
- Relay 和 iOS 只做透传，职责清晰

### D2: `~` 解析规则

**选择**:
- `""` 或 `"~"` → `os.UserHomeDir()`
- `"~/xxx"` → `filepath.Join(home, "xxx")`
- 其他 → 原样使用（绝对路径）

**替代方案**: 只支持空值回退，不支持 `~` 语法 → 用户体验差，`~` 是直觉预期
**理由**: 覆盖最常见的三种使用场景，实现简单

### D3: 校验时机在 CreateSession 入口处

**选择**: `resolveCwd()` 之后、`cmd.Start()` 之前校验
**替代方案**: 不校验，让进程自然失败 → 错误信息来自 Claude Code CLI，不友好
**理由**: 提前拦截可以返回明确的错误类型（目录不存在、无权限、不是目录），iOS 端可以直接展示

### D4: 校验失败返回 error 事件（复用现有协议）

**选择**: 返回 `{ type: "error", session_id: "...", error: "工作目录不存在: /path" }`
**替代方案**: 新增专门的 cwd_error 事件类型 → 过度设计
**理由**: 现有协议已有 error 事件，iOS 端已有处理逻辑，直接复用

### D5: iOS 端 placeholder 改为提示可选

**选择**: placeholder 改为 `"~（默认）"` 或 `"留空使用 home 目录"`
**替代方案**: 保留 `/path/to/project` → 继续误导用户
**理由**: 让用户知道 cwd 是可选的，`~` 是默认行为

## Risks / Trade-offs

- **[home 目录不适合运行 Claude]** → Claude Code 在 `~` 启动完全正常，它会根据 prompt 内容自行决定操作范围。用户可通过填写具体路径覆盖
- **[~/xxx 路径不存在]** → 校验拦截，返回 "目录不存在: ~/projects" 错误，用户可修正
- **[权限校验增加启动延迟]** → `os.Stat()` + `os.Access()` 是极轻量系统调用，延迟 < 1ms，可忽略
- **[现有 Session 不受影响]** → 本次只改 `CreateSession` 流程，已运行的 Session 使用启动时的 cwd，不受影响

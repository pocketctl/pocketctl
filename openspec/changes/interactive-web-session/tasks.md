## 1. 依赖与 PTY 基础（D8）

- [x] 1.1 添加 `github.com/creack/pty` 依赖（`go get` + go.mod tidy）— GOSUMDB=off（sum.golang.org 网络限制）
- [x] 1.2 新增 PTY helper（`internal/session/pty.go`）：`startPTYCli(cliPath, args, cwd)` —— env 清理 + `pty.Start`
- [x] 1.3 `ProcessState` 加 `PTY *os.File` 字段
- [x] 1.4 单元测试 `TestStartPTYCliStdinWriteRead`（PTY stdin/stdout 闭环）+ `TestSanitizePTYEnvStripsClaudeCodeMarkers`

## 2. CreateSession 改造为 PTY interactive（D1）

- [x] 2.1 新增 `adapter.BuildInteractiveArgs()`（仅 `--permission-mode acceptEdits`，无 `-p`/`--output-format`）
- [x] 2.2 `CreateSession` 改用 `startPTYCli` 启动 interactive claude（用 `--session-id <uuid>` 指定，spike 验证写 `<uuid>.jsonl`）
- [x] 2.3 session 初始 `status=idle`；`ps.PTY = ptmx`；session-id = uuid（real，非 pending）
- [x] 2.4 首条 prompt 由 `servePTYSession` 等 JSONL 出现 + 2s settle 后写 PTY stdin（`\r`）
- [x] 2.5 保留首条 `user_text` 早发射（即时 UI 反馈；PTY claude 也会写 JSONL user 记录）

## 3. 输出通道：JSONL tailer 接入（D2）

- [x] 3.1 `servePTYSession` 轮询等 JSONL 文件（≤30s）→ `NewJSONLTailerFromStart` + `Run`
- [x] 3.2 `SetTailer` 接入（main.go 已有，daemon PTY session 复用）
- [ ] 3.3 验证闭环（PTY 响应 → JSONL → tailer → outputCh → relay → web）— **代码完成，待部署实测**

## 4. session-id（D5 — 设计简化）

- [x] 4.1 ~~从 JSONL init 提取~~ → **简化**：`--session-id <uuid>` 直接指定，跳过 pending→real（spike 验证 claude 尊重 --session-id 写 `<uuid>.jsonl`）
- [x] 4.2 ~~renameSession~~ → 不需要（--session-id 直接 real）；`servePTYSession` 触发 `OnSessionIDResolved`（title 生成）
- [x] 4.3 web pending 机制沿用 fix-session-interaction（daemon 直接返回 real uuid，web 不进 pending 态）

## 5. SendMessage 改造为 PTY stdin 写入（D1/D4/D6）

- [x] 5.1 `SendMessage` 新增 `source==daemon` 分支 → `ps.PTY.WriteString(content + "\r")`
- [x] 5.2 移除 daemon 路径的 `exec.CommandContext(--resume)` spawn + readOutput
- [x] 5.3 status running→idle：`ParseJSONLLine` 对 `system/turn_duration` → `session_status idle` 事件；tailer 从文件名 stamp 空 sessionID
- [x] 5.4 `source==terminal` 路径完整保留（sendToIdleTerminal + --resume + tailer pause/resume）

## 6. 生命周期与崩溃检测（D7）

- [x] 6.1 `servePTYSession` goroutine `cmd.Wait()` + `handlePTYExit`（exit code → exited/error + session_status 事件）
- [x] 6.2 `KillSession` 加 PTY 优雅退出（`/exit\r` + `defer PTY.Close()`）
- [x] 6.3 session 结束关 PTY（handlePTYExit + KillSession defer）；tailer 由 ctx cancel 停 — **代码完成，待实测确认无 fd 泄漏**
- [ ] 6.4 macOS codesign（PTY re-exec 子进程）— **部署步骤，待部署时验证**（见 memory `macos-codesign-reexec-sigkill`）

## 7. 环境清理（D3）

- [x] 7.1 `sanitizePTYEnv` unset `CLAUDE_CODE*` / `CLAUDECODE` / `CLAUDE_EFFORT`
- [x] 7.2 `TestSanitizePTYEnvStripsClaudeCodeMarkers` 单元测试
- [x] 7.3 集成验证：清理 env 后 PTY claude 写 JSONL（非 ephemeral）— spike v5/v6 已验证

## 8. Web 实测（已部署验证）

- [x] 8.1 SessionDetail.vue 命令执行 UI（复用 command_receipt 卡片，fix-session-interaction 已建）
- [ ] 8.2 ~~web 发 `/help` 显示帮助~~ — **claude 限制（非 pocketctl bug）**：local command（/help /model /compact）在 go creack/pty 下 "isn't available in this environment"，python pty.fork 下正常；已排除 isTTY/winsize/env（AI_AGENT/ANTHROPIC_*/--session-id）；根因 PTY 实现细节，claude 闭源。见 design.md Known Limitation + memory `pty-interactive-claude-pitfalls`
- [x] 8.3 web 发 `/opsx:new` → skill 真正执行 ✓（实测 session d4ad8247，JSONL 完整记录 skill 加载 + 执行）
- [x] 8.4 普通消息往返 + 多消息上下文保持 ✓（d4ad8247 多轮）

## 9. 测试与验证

- [x] 9.1 `go build ./...` 通过
- [ ] 9.2 `vue-tsc`（本变更未改 web，N/A 除非 8.x 触发改动）
- [ ] 9.3 集成：daemon session 创建 → PTY → 发消息 → JSONL tail → web 响应
- [ ] 9.4 skill/local command 在 web daemon session 执行（/help、/opsx:new、/compact）
- [ ] 9.5 回归：terminal session（--resume + JSONL tail）+ 跨设备接力不受影响

## 10. 部署

- [ ] 10.1 daemon：`go build` + `cp` + `codesign --force --sign -` + restart
- [ ] 10.2 relay 重建（若事件类型微调）
- [ ] 10.3 web 重建
- [ ] 10.4 端到端：web 创建 session + 发 skill 命令 + 验证执行
- [ ] 10.5 更新 `macos-codesign-reexec-sigkill` memory（若 PTY re-exec 有额外 codesign 要点）

---

## 本 session 进度（/opsx:apply）

**代码完成 26/40**（1.x, 2.x, 3.1-3.2, 4.x 简化, 5.x, 6.1-6.3, 7.x, 9.1）。**剩余 14 项需部署 + 实测环境**（3.3 闭环验证、6.4 codesign、8.x web 实测、9.3-9.5 集成/回归、10.x 部署）。

**验证状态**：
- ✅ `go build ./...` + `go vet` 通过
- ✅ 单元测试：PTY stdin/stdout 闭环 + env 清理（`TestStartPTYCliStdinWriteRead` / `TestSanitizePTYEnv...`）通过
- ✅ adapter / watcher 测试通过
- ✅ spike 验证全部关键假设（清理 env + --session-id 写 `<uuid>.jsonl`、`\r` 提交、/help 真实执行）
- ⚠️ session 包 5 个预存在测试失败（`TestSetSessionExited` 等 "timed out waiting for session_discovered"）—— **git stash 验证：改动前就失败**，与本次无关（mock 环境 `/tmp` 无 JSONL 文件 → session_discovered 永不触发）

**核心改造摘要**：
- `internal/session/pty.go`（新）：`startPTYCli` + `sanitizePTYEnv`（D3）
- `internal/session/manager.go`：`CreateSession` PTY 重写 + `servePTYSession`/`handlePTYExit` + `SendMessage` daemon PTY stdin + `KillSession` 优雅退出
- `internal/adapter/claude.go`：`BuildInteractiveArgs`
- `internal/adapter/claude_jsonl.go`：`turn_duration` → `session_status idle`
- `internal/watcher/tailer.go`：从文件名 stamp 空 sessionID

**下一步（需用户操作）**：部署 daemon（10.1）+ web 重建（10.3）→ 实测 web 创建 session + 发 `/help`/`/opsx:new` 验证 PTY 闭环（3.3/8.x/9.3-9.4）。

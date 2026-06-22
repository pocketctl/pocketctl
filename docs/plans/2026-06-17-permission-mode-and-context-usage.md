# Permission Mode + Context Usage Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 让 Web 客户端能在创建会话时选择权限模式（3a）、实时显示当前会话的 context token 用量（2）、运行时切换权限模式（3b）。

**Architecture:** 三阶段递进。3a 纯参数透传（ClientMessage→SessionConfig→--permission-mode），零风险。2 在 adapter 层解析 Claude JSONL/stream-json 里已有的 `usage` 字段，经新 DaemonEvent 字段上报。3b 通过 PTY 写 Shift+Tab 转义序列触发 Claude TUI 的模式循环 + 扩展 JSONL parser 捕获 `permission-mode` 条目反馈。

**Tech Stack:** Go 1.25（daemon/adapter）、Vue 3.5 + TypeScript（web）、SwiftUI（iOS，本次不改）、relay TypeScript（纯透传无需改）

**Key Files:**
- Protocol: `internal/protocol/types.go`
- Daemon entry: `cmd/pocketctl/main.go` (`handleCommands` ~L1006)
- Adapter: `internal/adapter/claude.go`, `internal/adapter/claude_jsonl.go`
- Session manager: `internal/session/manager.go`
- Web dialog: `web/src/components/NewSessionDialog.vue`
- Web detail: `web/src/views/SessionDetail.vue`

---

## 阶段 3a：创建会话时选择权限模式（低风险）

### Task 1: 协议层——ClientMessage 加 PermissionMode 字段

**Files:**
- Modify: `internal/protocol/types.go:6-15`

**Step 1: 加字段**

在 `ClientMessage` 结构体的 `Approved` 字段后面加：

```go
type ClientMessage struct {
    Type      string `json:"type"`
    SessionID string `json:"session_id,omitempty"`
    Content   string `json:"content,omitempty"`
    Agent     string `json:"agent,omitempty"`
    Cwd       string `json:"cwd,omitempty"`
    Prompt    string `json:"prompt,omitempty"`
    RequestID string `json:"request_id,omitempty"`
    Approved  bool   `json:"approved,omitempty"`
    // PermissionMode for session_create: "default" | "acceptEdits" | "plan" | "bypassPermissions".
    // Empty falls back to "acceptEdits" (the daemon default).
    PermissionMode string `json:"permission_mode,omitempty"`
}
```

**Step 2: 编译验证**

Run: `go build ./internal/protocol/`
Expected: 无错误

**Step 3: Commit**

```bash
git add internal/protocol/types.go
git commit -m "feat(protocol): add PermissionMode to ClientMessage"
```

---

### Task 2: daemon——session_create 透传 PermissionMode

**Files:**
- Modify: `cmd/pocketctl/main.go:1016-1020`（`handleCommands` 的 `session_create` 分支）

**Step 1: 改 SessionConfig 构造**

把 `config := protocol.SessionConfig{...}` 改为读取 `cmd.PermissionMode`：

```go
config := protocol.SessionConfig{
    Agent:          cmd.Agent,
    Cwd:            cmd.Cwd,
    Prompt:         cmd.Prompt,
    PermissionMode: cmd.PermissionMode,
}
```

**Step 2: 确认 BuildInteractiveArgs 已处理空值兜底**

验证 `internal/adapter/claude.go:310-323`（`BuildInteractiveArgs`）已有 `if permMode == "" { permMode = "acceptEdits" }`——无需改动，空值自动兜底。

**Step 3: 编译验证**

Run: `go build ./cmd/pocketctl/`
Expected: 无错误

**Step 4: Commit**

```bash
git add cmd/pocketctl/main.go
git commit -m "feat(daemon): pass permission_mode through session_create"
```

---

### Task 3: Web——NewSessionDialog 加权限模式下拉

**Files:**
- Modify: `web/src/components/NewSessionDialog.vue`（form 定义 ~L122，发送逻辑 ~L220）

**Step 1: 给 form 加 permissionMode 字段**

找到 `const form = reactive({...})`，加字段：

```typescript
const form = reactive({
  daemonId: '',
  agent: 'claude-code',
  cwd: localStorage.getItem('pocketctl_default_cwd') || '',
  prompt: '',
  permissionMode: 'acceptEdits',  // default | acceptEdits | plan | bypassPermissions
})
```

**Step 2: 在模板里加下拉选择器**

在 prompt 输入框之前（或 cwd 之后）加：

```html
<div class="form-field">
  <label class="form-label">权限模式</label>
  <select v-model="form.permissionMode" class="input-field">
    <option value="default">默认（每次操作需确认）</option>
    <option value="acceptEdits">自动接受编辑（推荐）</option>
    <option value="plan">计划模式（只读分析）</option>
    <option value="bypassPermissions">跳过所有权限检查</option>
  </select>
</div>
```

**Step 3: session_create payload 带上 permission_mode**

找到 `send({ type: 'session_create', ... })`，加字段：

```typescript
send({
  type: 'session_create',
  daemon_id: form.daemonId,
  agent: form.agent,
  cwd: form.cwd || undefined,
  prompt: form.prompt || undefined,
  permission_mode: form.permissionMode || undefined,
})
```

**Step 4: 类型检查 + 构建**

Run: `npx vue-tsc --noEmit -p web/tsconfig.json && npm run build --prefix web`
Expected: 无错误

**Step 5: Commit**

```bash
git add web/src/components/NewSessionDialog.vue
git commit -m "feat(web): add permission mode selector to NewSessionDialog"
```

---

### Task 4: 集成测试 3a

**Step 1: 重新编译 daemon**

Run: `go build -o pocketctl ./cmd/pocketctl`

**Step 2: 重启 daemon**

```bash
pkill -f "pocketctl daemon"
nohup ./pocketctl daemon start > /tmp/pocketctl-daemon.log 2>&1 &
```

**Step 3: 构建 + 重启 web 容器**

Run: `docker compose build web && docker compose up -d web`

**Step 4: 手动验证**

1. 硬刷新 web，打开新建会话弹窗
2. 确认权限模式下拉有 4 个选项，默认选中"自动接受编辑"
3. 选"计划模式"创建会话，发消息让 agent 尝试编辑文件
4. 确认 agent 不执行编辑（plan 模式只读）

**Step 5: Commit（如有微调）**

```bash
git add -A && git commit -m "fix: 3a integration adjustments"
```

---

## 阶段 2：获取 context token 用量（中等难度）

### Task 5: adapter 结构体——加 Usage 字段

**Files:**
- Modify: `internal/adapter/claude.go:35-41`（`ClaudeMessage`）
- Modify: `internal/adapter/claude_jsonl.go:21-27`（`JSONLMessage`）

**Step 1: 定义 Usage 结构体**

在 `claude.go` 的 `ClaudeMessage` 之前加：

```go
// TokenUsage mirrors Anthropic API's usage object (present on every assistant
// message in both stream-json and JSONL output).
type TokenUsage struct {
    InputTokens     int `json:"input_tokens,omitempty"`
    OutputTokens    int `json:"output_tokens,omitempty"`
    CacheCreation   int `json:"cache_creation_input_tokens,omitempty"`
    CacheRead       int `json:"cache_read_input_tokens,omitempty"`
}
```

**Step 2: ClaudeMessage 加 Usage 字段**

```go
type ClaudeMessage struct {
    ID      string          `json:"id"`
    Type    string          `json:"type"`
    Role    string          `json:"role"`
    Model   string          `json:"model,omitempty"`
    Content []ClaudeContent `json:"content"`
    Usage   *TokenUsage     `json:"usage,omitempty"`
}
```

**Step 3: JSONLMessage 加 Usage 字段**

在 `claude_jsonl.go` 的 `JSONLMessage` 加同样的字段：

```go
type JSONLMessage struct {
    Role    string          `json:"role"`
    Model   string          `json:"model,omitempty"`
    Content json.RawMessage `json:"content"`
    Usage   *TokenUsage     `json:"usage,omitempty"`
}
```

**Step 4: 编译验证**

Run: `go build ./internal/adapter/`
Expected: 无错误

**Step 5: Commit**

```bash
git add internal/adapter/claude.go internal/adapter/claude_jsonl.go
git commit -m "feat(adapter): add TokenUsage struct to message types"
```

---

### Task 6: 协议层——DaemonEvent 加 Usage 字段

**Files:**
- Modify: `internal/protocol/types.go:18-50`（`DaemonEvent`）

**Step 1: 加 Usage 子结构 + 字段**

在 `protocol/types.go` 加（和 adapter 的 TokenUsage 对齐，但独立定义避免循环依赖）：

```go
// ContextUsage carries token consumption for a single assistant turn.
type ContextUsage struct {
    InputTokens  int `json:"input_tokens,omitempty"`
    OutputTokens int `json:"output_tokens,omitempty"`
    CacheRead    int `json:"cache_read_tokens,omitempty"`
    CacheCreate  int `json:"cache_create_tokens,omitempty"`
}
```

在 `DaemonEvent` 末尾（`Message` 字段后）加：

```go
    Usage *ContextUsage `json:"usage,omitempty"` // token usage for agent_text events
```

**Step 2: 编译验证**

Run: `go build ./internal/protocol/`
Expected: 无错误

**Step 3: Commit**

```bash
git add internal/protocol/types.go
git commit -m "feat(protocol): add Usage to DaemonEvent for context tracking"
```

---

### Task 7: adapter——stream-json 路径解析 usage

**Files:**
- Modify: `internal/adapter/claude.go:153-185`（`convertAssistant`）

**Step 1: 在 agent_text 事件里附加 usage**

找到 `convertAssistant` 里产出 `agent_text` 事件的分支（~L167-172），改为：

```go
case "text":
    if isSynthetic {
        events = append(events, a.makeReceipt(sid, c.Text))
    } else {
        ev := protocol.DaemonEvent{
            Type:      "agent_text",
            SessionID: sid,
            Text:      c.Text,
            Streaming: false,
        }
        if u := raw.Message.Usage; u != nil {
            ev.Usage = &protocol.ContextUsage{
                InputTokens:  u.InputTokens,
                OutputTokens: u.OutputTokens,
                CacheRead:    u.CacheRead,
                CacheCreate:  u.CacheCreation,
            }
        }
        events = append(events, ev)
    }
```

**Step 2: 写测试**

在 `internal/adapter/claude_test.go` 加：

```go
func TestAssistantUsageForwarded(t *testing.T) {
    a := NewClaudeAdapter("hello")
    line := `{"type":"assistant","message":{"role":"assistant","model":"claude-sonnet-4","content":[{"type":"text","text":"Hi"}],"usage":{"input_tokens":1200,"output_tokens":50,"cache_read_input_tokens":8000}}}`
    events, _ := a.ParseStreamLine(line)
    if len(events) != 1 || events[0].Type != "agent_text" {
        t.Fatalf("expected 1 agent_text, got %v", events)
    }
    u := events[0].Usage
    if u == nil {
        t.Fatal("expected Usage non-nil")
    }
    if u.InputTokens != 1200 || u.OutputTokens != 50 || u.CacheRead != 8000 {
        t.Errorf("unexpected usage: %+v", u)
    }
}
```

**Step 3: 跑测试**

Run: `go test ./internal/adapter/ -run TestAssistantUsageForwarded -v`
Expected: PASS

**Step 4: Commit**

```bash
git add internal/adapter/claude.go internal/adapter/claude_test.go
git commit -m "feat(adapter): forward token usage on stream-json agent_text"
```

---

### Task 8: adapter——JSONL 路径解析 usage（PTY session）

**Files:**
- Modify: `internal/adapter/claude_jsonl.go`（`parseAssistantJSONL` ~L93-101，`JSONLStreamParser.parseAssistant`）

**Step 1: 无状态 ParseJSONLLine 的 parseAssistantJSONL 加 usage**

找到 `parseAssistantJSONL` 里产出 `agent_text` 的分支，改为：

```go
case "text":
    ev := protocol.DaemonEvent{
        Type:      "agent_text",
        SessionID: sid,
        Text:      b.Text,
        Streaming: false,
    }
    if u := entry.Message.Usage; u != nil {
        ev.Usage = &protocol.ContextUsage{
            InputTokens:  u.InputTokens,
            OutputTokens: u.OutputTokens,
            CacheRead:    u.CacheRead,
            CacheCreate:  u.CacheCreation,
        }
    }
    events = append(events, ev)
```

**Step 2: JSONLStreamParser.parseAssistant 同样加 usage**

在 `JSONLStreamParser.parseAssistant`（有状态版）的 `!isSynthetic` 分支里做同样修改。

**Step 3: JSONL 路径补 result 事件处理（让 PTY session 也能拿到 cost）**

在 `ParseJSONLLine` 的 switch（~L51-78）和 `JSONLStreamParser.Parse` 的 switch（~L317-329）里，default 分支前加：

```go
case "result":
    // End-of-turn summary with aggregated cost/turns (PTY path previously
    // dropped this — forwarding it lets daemon sessions report cost too).
    return []protocol.DaemonEvent{{
        Type:      "session_status",
        SessionID: sid,
        Status:    protocol.StatusCompleted,
        CostUSD:   entry.TotalCost,
        Turns:     entry.NumTurns,
    }}, nil
```

同时在 `JSONLEntry` 结构体加字段：

```go
type JSONLEntry struct {
    // ... existing fields ...
    TotalCost float64 `json:"total_cost_usd,omitempty"`
    NumTurns  int     `json:"num_turns,omitempty"`
}
```

**Step 4: 写测试**

在 `internal/adapter/claude_jsonl_test.go` 加：

```go
func TestJSONLStreamParserUsageForwarded(t *testing.T) {
    p := NewJSONLStreamParser()
    line := `{"type":"assistant","sessionId":"s1","message":{"role":"assistant","model":"claude-sonnet-4","content":[{"type":"text","text":"Hi"}],"usage":{"input_tokens":500,"output_tokens":30,"cache_read_input_tokens":3000}}}}`
    events, _ := p.Parse(line)
    if len(events) != 1 || events[0].Usage == nil {
        t.Fatalf("expected agent_text with usage, got %v", events)
    }
    if events[0].Usage.InputTokens != 500 {
        t.Errorf("expected 500 input tokens, got %d", events[0].Usage.InputTokens)
    }
}
```

**Step 5: 跑测试**

Run: `go test ./internal/adapter/ -run "JSONLStreamParserUsage|JSONLStream" -v`
Expected: PASS

**Step 6: Commit**

```bash
git add internal/adapter/claude_jsonl.go internal/adapter/claude_jsonl_test.go
git commit -m "feat(adapter): parse token usage + result events from JSONL path"
```

---

### Task 9: Web——SessionDetail 显示 context 用量

**Files:**
- Modify: `web/src/views/SessionDetail.vue`（processEvent ~L420，toolbar ~L42）

**Step 1: processEvent 解析 usage**

在 `agent_text` 分支（~L426-434）里，把 usage 存进 message 对象：

```typescript
} else if (type === 'agent_text') {
    const content = evt.text || evt.content || evt.payload?.text || evt.payload?.content || ''
    if (!content || isDuplicate('agent_text', content, target)) return
    const streaming = evt.streaming ?? evt.payload?.streaming ?? false
    const usage = evt.usage || evt.payload?.usage
    const last = target[target.length - 1]
    if (last && last.type === 'agent_text' && last.streaming && !content.startsWith('\n')) {
      last.content += content
      if (!streaming) last.streaming = false
    } else {
      target.push({ id: nextId('a'), type: 'agent_text', role: 'agent', content, streaming, usage })
    }
}
```

**Step 2: 在 toolbar 显示累计 context 用量**

在 `.chat-toolbar` 里 status-pill 旁边加一个 context indicator（从最后一条带 usage 的 message 取值）：

```typescript
const lastUsage = computed(() => {
  for (let i = messages.value.length - 1; i >= 0; i--) {
    const m = messages.value[i]
    if (m.usage) return m.usage
  }
  return null
})
const contextTokens = computed(() => {
  const u = lastUsage.value
  if (!u) return ''
  const total = (u.input_tokens || 0) + (u.cache_read_tokens || 0) + (u.cache_create_tokens || 0)
  return total > 1000 ? (total / 1000).toFixed(1) + 'K' : String(total)
})
```

toolbar 模板里加（status-pill 后面）：

```html
<span v-if="contextTokens" class="context-pill" title="当前 context 用量（输入 + 缓存 token）">
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>
  {{ contextTokens }}
</span>
```

样式（加到 SessionDetail 的 `<style>`）：

```css
.context-pill { display: inline-flex; align-items: center; gap: 4px; padding: 4px 10px; border-radius: var(--radius-full); font-size: 12px; font-weight: 500; background: var(--accent-muted); color: var(--accent); font-family: var(--font-mono); }
```

**Step 3: 类型检查 + 构建**

Run: `npx vue-tsc --noEmit -p web/tsconfig.json && npm run build --prefix web`
Expected: 无错误

**Step 4: Commit**

```bash
git add web/src/views/SessionDetail.vue
git commit -m "feat(web): show context token usage in session toolbar"
```

---

### Task 10: 集成测试阶段 2

**Step 1: 重新编译 daemon + 重启**

```bash
go build -o pocketctl ./cmd/pocketctl
pkill -f "pocketctl daemon" && sleep 2
nohup ./pocketctl daemon start > /tmp/pocketctl-daemon.log 2>&1 &
```

**Step 2: 重建 web 容器**

Run: `docker compose build web && docker compose up -d web`

**Step 3: 手动验证**

1. 硬刷新 web，新建会话
2. 发几条消息，观察 toolbar 出现 context token 数字
3. 每轮对话后数字应递增（反映 input + cache token 累计）
4. 确认数字格式（>1000 显示如 "12.3K"）

**Step 4: 跑全量 Go 测试**

Run: `go test ./internal/adapter/ ./internal/protocol/`
Expected: 全部 PASS

**Step 5: Commit（如有微调）**

---

## 阶段 3b：运行时切换权限模式（中高风险）

> ⚠️ 此阶段需要先 spike 验证 PTY 转义序列。如果 spike 失败，此阶段搁置。

### Task 11: Spike——验证 Shift+Tab 转义序列能否触发 Claude TUI 模式切换

**Files:**
- 无代码改动，纯验证脚本

**Step 1: 创建测试会话**

启动一个 daemon 会话（PTY 模式），用 web 连上。

**Step 2: 手动写 PTY 测试**

写一个临时 Go 脚本 `/tmp/spike_shifttab.go`：

```go
// 打开已有 session 的 PTY（需从 daemon 状态获取 ptmx 路径）
// 写入 \x1b[Z（Shift+Tab）
// 观察 claude TUI 是否切换了权限模式
```

或更简单——在 `manager.go` 的 `SendMessage` 里临时加一行：当 content == `__SHIFT_TAB__` 时写 `\x1b[Z` 而非 `content + "\r"`。

**Step 3: 验证**

通过 web 发送特殊消息触发，观察：
- Claude TUI 是否切换了模式（底部状态栏变化）
- JSONL 文件是否写入了 `permission-mode` 条目

**Step 4: 记录结果**

如果成功 → 继续 Task 12-15。
如果失败 → 停止 3b，记录原因（"creack/pty 的 Shift+Tab 不被 Claude TUI 识别"），考虑替代方案（重启 spawn 带 new --permission-mode）。

**Step 5: Commit（spike 代码不提交，仅记录结论）**

---

### Task 12: 协议层——set_permission_mode 消息 + permission_mode_changed 事件

**Files:**
- Modify: `internal/protocol/types.go`

**Step 1: ClientMessage 无需新字段（复用 Type + Content）**

`set_permission_mode` 消息用现有 `ClientMessage`：
- `Type: "set_permission_mode"`
- `SessionID: <sid>`
- `Content: "plan"`（目标模式）

无需改结构体。

**Step 2: DaemonEvent 加 PermissionMode 字段**

```go
// 在 DaemonEvent 里加：
PermissionMode string `json:"permission_mode,omitempty"` // current mode (permission_mode_changed event)
```

**Step 3: 编译验证 + Commit**

```bash
go build ./internal/protocol/
git add internal/protocol/types.go
git commit -m "feat(protocol): add PermissionMode to DaemonEvent for mode-change feedback"
```

---

### Task 13: daemon——handleCommands 加 set_permission_mode 分支

**Files:**
- Modify: `cmd/pocketctl/main.go`（`handleCommands` switch）

**Step 1: 加 case 分支**

在 `case "list_commands":` 之前加：

```go
case "set_permission_mode":
    err := sm.SetPermissionMode(ctx, cmd.SessionID, cmd.Content)
    if err != nil {
        client.SendMsg(protocol.DaemonEvent{
            Type:      "error",
            SessionID: cmd.SessionID,
            Error:     err.Error(),
        })
    }
    // 成功的反馈由 JSONL tailer 的 permission-mode 条目异步驱动
```

**Step 2: 编译验证**

Run: `go build ./cmd/pocketctl/`
Expected: 报错 `sm.SetPermissionMode undefined`（下一个 Task 实现）

**Step 3: 暂不 Commit（等 Task 14 完成后一起提交）**

---

### Task 14: session manager——SetPermissionMode 实现

**Files:**
- Modify: `internal/session/manager.go`
- Modify: `internal/session/pty.go`（新增 WriteSpecialKey helper）

**Step 1: pty.go 加 WriteSpecialKey**

```go
// WriteSpecialKey writes an escape sequence to the PTY master (e.g. Shift+Tab).
func WriteSpecialKey(ptmx *os.File, seq string) error {
    _, err := ptmx.Write([]byte(seq))
    return err
}
```

**Step 2: manager.go 加 SetPermissionMode**

```go
// SetPermissionMode cycles the Claude TUI's permission mode via Shift+Tab.
// Because Shift+Tab cycles blindly (default→acceptEdits→plan), we need to
// know the current mode to calculate how many presses are needed. The current
// mode is tracked on ProcessState (updated by the JSONL permission-mode parser).
func (sm *SessionManager) SetPermissionMode(ctx context.Context, sessionID, targetMode string) error {
    sm.mu.RLock()
    ps, ok := sm.sessions[sessionID]
    sm.mu.RUnlock()
    if !ok {
        return fmt.Errorf("session not found")
    }
    if ps.Source != "daemon" || ps.PTY == nil {
        return fmt.Errorf("only daemon (interactive) sessions support runtime mode switch")
    }

    // Shift+Tab cycle order: default → acceptEdits → plan → (back to default)
    cycle := []string{"default", "acceptEdits", "plan"}
    currentIdx := indexOf(cycle, ps.PermissionMode)
    if currentIdx == -1 {
        currentIdx = 0 // unknown, assume default
    }
    targetIdx := indexOf(cycle, targetMode)
    if targetIdx == -1 {
        return fmt.Errorf("unsupported permission mode: %s", targetMode)
    }

    presses := (targetIdx - currentIdx + len(cycle)) % len(cycle)
    for i := 0; i < presses; i++ {
        if err := pty.WriteSpecialKey(ps.PTY, "\x1b[Z"); err != nil {
            return fmt.Errorf("pty write shift+tab: %w", err)
        }
        time.Sleep(150 * time.Millisecond) // let TUI process each press
    }
    return nil
}

func indexOf(slice []string, val string) int {
    for i, v := range slice {
        if v == val { return i }
    }
    return -1
}
```

**Step 3: ProcessState 加 PermissionMode 字段**

在 `manager.go` 的 `ProcessState` 结构体（~L24-41）加：

```go
type ProcessState struct {
    // ... existing fields ...
    PermissionMode string // current permission mode (updated by JSONL parser)
}
```

在 `CreateSession` 启动后初始化：

```go
ps.PermissionMode = config.PermissionMode
if ps.PermissionMode == "" {
    ps.PermissionMode = "acceptEdits"
}
```

**Step 4: 编译验证**

Run: `go build ./internal/session/ ./cmd/pocketctl/`
Expected: 无错误

**Step 5: Commit**

```bash
git add internal/session/manager.go internal/session/pty.go cmd/pocketctl/main.go
git commit -m "feat(daemon): implement SetPermissionMode via PTY Shift+Tab cycle"
```

---

### Task 15: adapter——JSONL parser 捕获 permission-mode 条目

**Files:**
- Modify: `internal/adapter/claude_jsonl.go`（`JSONLStreamParser.Parse` 的 default 分支 ~L329）

**Step 1: 加 permission-mode 类型处理**

在 `JSONLStreamParser.Parse` 的 switch 里，default 之前加：

```go
case "permission-mode":
    // Claude writes this when the user cycles modes. Extract the new mode
    // and emit a feedback event so the web UI stays in sync.
    mode := strings.TrimSpace(entry.Content)
    if mode == "" {
        return nil, nil
    }
    return []protocol.DaemonEvent{{
        Type:           "permission_mode_changed",
        SessionID:      sid,
        PermissionMode: mode,
    }}, nil
```

同时在 `JSONLEntry` 确认 `Content` 字段能承载 permission-mode 的值（Claude 的格式是 `{"type":"permission-mode","content":"plan"}`，已有 `Content string` 字段覆盖）。

**Step 2: 写测试**

```go
func TestJSONLStreamParserPermissionMode(t *testing.T) {
    p := NewJSONLStreamParser()
    line := `{"type":"permission-mode","sessionId":"s1","content":"plan"}`
    events, _ := p.Parse(line)
    if len(events) != 1 || events[0].Type != "permission_mode_changed" {
        t.Fatalf("expected permission_mode_changed, got %v", events)
    }
    if events[0].PermissionMode != "plan" {
        t.Errorf("expected plan, got %s", events[0].PermissionMode)
    }
}
```

**Step 3: 跑测试**

Run: `go test ./internal/adapter/ -run TestJSONLStreamParserPermissionMode -v`
Expected: PASS

**Step 4: Commit**

```bash
git add internal/adapter/claude_jsonl.go internal/adapter/claude_jsonl_test.go
git commit -m "feat(adapter): emit permission_mode_changed from JSONL permission-mode entries"
```

---

### Task 16: manager——tailer 收到 permission_mode_changed 时更新 ProcessState

**Files:**
- Modify: `internal/watcher/tailer.go`（`Run` 方法，事件分发处）

**Step 1: 在 Run 里拦截 permission_mode_changed 事件**

tailer 的 `Run` 把事件推入 outputCh。我们需要在推之前，如果是 `permission_mode_changed`，同步更新 ProcessState。

但 tailer 不持有 SessionManager 引用（解耦设计）。更简单的方案：**让 manager 在收到事件后自己更新**——在 `main.go` 的事件分发循环里（daemon ws client 把 outputCh 事件发给 relay 之前）拦截：

找到 `main.go` 里把 `sm.outputCh` 事件转发给 ws client 的循环，加拦截：

```go
// Before forwarding, sync permission mode changes to session state.
if evt.Type == "permission_mode_changed" && evt.SessionID != "" {
    sm.UpdatePermissionMode(evt.SessionID, evt.PermissionMode)
}
```

在 `manager.go` 加方法：

```go
func (sm *SessionManager) UpdatePermissionMode(sessionID, mode string) {
    sm.mu.Lock()
    defer sm.mu.Unlock()
    if ps, ok := sm.sessions[sessionID]; ok {
        ps.PermissionMode = mode
    }
}
```

**Step 2: 编译验证**

Run: `go build ./...`
Expected: 无错误

**Step 3: Commit**

```bash
git add cmd/pocketctl/main.go internal/session/manager.go
git commit -m "feat(daemon): sync permission_mode_changed events to ProcessState"
```

---

### Task 17: Web——SessionDetail 加权限模式切换 UI

**Files:**
- Modify: `web/src/views/SessionDetail.vue`

**Step 1: 加状态 + 发送逻辑**

```typescript
const currentPermissionMode = ref('acceptEdits')
const PERMISSION_MODES = [
  { value: 'default', label: '默认' },
  { value: 'acceptEdits', label: '自动编辑' },
  { value: 'plan', label: '计划' },
]

function setPermissionMode(mode: string) {
  send({ type: 'set_permission_mode', session_id: sessionId.value, content: mode })
}
```

**Step 2: 监听 permission_mode_changed 事件**

```typescript
cleanups.push(onEvent('permission_mode_changed', (msg: any) => {
  if (msg.session_id !== sessionId.value) return
  currentPermissionMode.value = msg.permission_mode || 'acceptEdits'
}))
```

**Step 3: toolbar 加切换按钮组**

在 toolbar 的 status-pill 附近加：

```html
<div class="perm-mode-group">
  <button v-for="m in PERMISSION_MODES" :key="m.value"
    :class="['perm-btn', { active: currentPermissionMode === m.value }]"
    @click="setPermissionMode(m.value)"
    :title="`切换到${m.label}模式`">
    {{ m.label }}
  </button>
</div>
```

样式：

```css
.perm-mode-group { display: inline-flex; gap: 2px; padding: 2px; background: var(--bg); border-radius: var(--radius-full); }
.perm-btn { padding: 3px 10px; border: none; background: none; color: var(--fg-tertiary); font-size: 11px; cursor: pointer; border-radius: var(--radius-full); transition: all 0.15s; }
.perm-btn.active { background: var(--accent); color: #fff; }
.perm-btn:hover:not(.active) { color: var(--fg); }
```

**Step 4: 类型检查 + 构建 + Commit**

```bash
npx vue-tsc --noEmit -p web/tsconfig.json && npm run build --prefix web
git add web/src/views/SessionDetail.vue
git commit -m "feat(web): add permission mode switcher to session toolbar"
```

---

### Task 18: 集成测试 3b + 全量验证

**Step 1: 重新编译 daemon + 重启**

```bash
go build -o pocketctl ./cmd/pocketctl
pkill -f "pocketctl daemon" && sleep 2
nohup ./pocketctl daemon start > /tmp/pocketctl-daemon.log 2>&1 &
```

**Step 2: 重建 web 容器**

Run: `docker compose build web && docker compose up -d web`

**Step 3: 手动验证 3b**

1. 新建会话（默认 acceptEdits）
2. 发消息让 agent 编辑文件，确认自动执行
3. 点击 toolbar 的"计划"按钮
4. 确认按钮高亮切换到"计划"
5. 发消息让 agent 编辑文件，确认 agent 只分析不执行
6. 切回"自动编辑"，确认恢复正常

**Step 4: 跑全量测试**

Run: `go test ./internal/... && npm run test --prefix web`
Expected: 全部 PASS（session 包的环境依赖测试除外）

**Step 5: 最终 Commit**

```bash
git add -A
git commit -m "feat: permission mode runtime switch + context usage (3a+2+3b complete)"
```

---

## 风险与回滚

| 阶段 | 风险 | 回滚方式 |
|---|---|---|
| 3a | 极低（纯参数透传） | revert 单个 commit |
| 2 | 低（只加字段解析，不改现有逻辑） | revert adapter commit |
| 3b Task 11 | 中高（Shift+Tab 可能不被 TUI 识别） | spike 失败则停止 3b，不影响 3a+2 |
| 3b Task 14 | 中（PTY 转义序列副作用未知） | 隔离在 SetPermissionMode 方法里，不影响正常消息发送 |

## 依赖关系

```
3a (Task 1-4) ── 独立，可单独上线
2  (Task 5-10) ── 独立，可单独上线
3b (Task 11-18) ── 依赖 Task 11 spike 成功；Task 12 复用 3a 的协议字段
```

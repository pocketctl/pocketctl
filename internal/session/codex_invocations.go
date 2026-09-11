package session

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"unicode"

	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/codexapp"
	"github.com/pocketctl/pocketctl/internal/protocol"
	"gopkg.in/yaml.v3"
)

type codexInvocationKey struct{}

var codexCommandDescriptions = [][2]string{
	{"skills", "浏览当前项目技能"}, {"model", "选择模型与推理强度"}, {"permissions", "调整当前会话权限"}, {"review", "审查代码修改"}, {"compact", "压缩会话上下文"}, {"rename", "重命名当前会话"}, {"new", "在当前主机和目录新建会话"}, {"resume", "继续本项目已有会话"}, {"fork", "从当前会话创建分支"}, {"status", "查看会话模型、权限与状态"}, {"pwd", "查看工作目录"}, {"usage", "查看 Codex 账户额度"}, {"copy", "复制最近一条完整回复"}, {"export", "导出完整会话 Markdown"},
}

func (sm *SessionManager) invocationBackend(id string) (*CodexAppServerBackend, error) {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	ps := sm.sessions[id]
	if ps == nil || ps.Agent != adapter.AgentCodex {
		return nil, errors.New("Codex session not found")
	}
	b, ok := ps.Backend.(*CodexAppServerBackend)
	if !ok || b.coord.projectCwd == "" {
		return nil, errors.New("此会话未启用 Codex 远程调用，请在新版中创建会话")
	}
	return b, nil
}
func (c *codexCoordinator) ownsInvocationThread(id string) bool {
	if c.sm == nil {
		return false
	}
	c.sm.mu.RLock()
	defer c.sm.mu.RUnlock()
	ps := c.sm.sessions[id]
	if ps == nil {
		return false
	}
	b, ok := ps.Backend.(*CodexAppServerBackend)
	return ok && b.coord == c
}
func nativeSkillID(sessionID, path string) string {
	hash := sha256.Sum256([]byte(sessionID + "\x00" + path))
	return "skill:" + hex.EncodeToString(hash[:16])
}
func (sm *SessionManager) codexSkillCatalog(ctx context.Context, id string) (codexapp.SkillsCatalog, error) {
	b, err := sm.invocationBackend(id)
	if err != nil {
		return codexapp.SkillsCatalog{}, err
	}
	b.coord.skillsMu.Lock()
	defer b.coord.skillsMu.Unlock()
	client, _, ok := b.coord.backendClient()
	if !ok {
		return codexapp.SkillsCatalog{}, errors.New("Codex runtime disconnected")
	}
	if err := b.coord.configureProjectSkills(ctx, client); err != nil {
		return codexapp.SkillsCatalog{}, err
	}
	var result codexapp.SkillsListResponse
	err = client.Call(ctx, "skills/list", map[string]any{"cwds": []string{b.coord.projectCwd}, "forceReload": true}, &result)
	if err != nil {
		return codexapp.SkillsCatalog{}, err
	}
	if len(result.Data) != 1 {
		return codexapp.SkillsCatalog{}, errors.New("invalid native skills response")
	}
	return result.Data[0], nil
}

func skillUnavailable(skill codexapp.SkillMetadata) string {
	if !skill.Enabled {
		return "技能已禁用"
	}
	if strings.Contains(filepath.ToSlash(skill.Path), "/.claude/") {
		file, err := os.Open(skill.Path)
		if err != nil {
			return "技能源文件不可读"
		}
		defer file.Close()
		data, err := io.ReadAll(io.LimitReader(file, (1<<20)+1))
		if err != nil {
			return "技能源文件不可读"
		}
		if len(data) > 1<<20 {
			return "技能定义过大"
		}
		// Native Codex validates the YAML; conservatively block Claude invocation,
		// permission and subagent extensions until equivalent semantics are supported.
		parts := strings.SplitN(strings.ReplaceAll(string(data), "\r\n", "\n"), "---", 3)
		if len(parts) < 3 {
			return "技能定义无有效 frontmatter"
		}
		var metadata map[string]any
		if yaml.Unmarshal([]byte(parts[1]), &metadata) != nil {
			return "技能 frontmatter 无效"
		}
		if value, exists := metadata["user-invocable"]; exists && value != true {
			return "此技能禁止用户显式调用"
		}
		for _, key := range []string{"allowed-tools", "context", "agent", "hooks", "disable-model-invocation"} {
			if value, exists := metadata[key]; exists && value != nil && value != false {
				return "含 Claude 专有调用或权限配置，暂不可远程调用"
			}
		}
	}
	return ""
}
func (sm *SessionManager) CodexInvocations(ctx context.Context, id string) ([]protocol.CommandItem, error) {
	catalog, err := sm.codexSkillCatalog(ctx, id)
	if err != nil {
		return nil, err
	}
	items := make([]protocol.CommandItem, 0, len(catalog.Skills)+14)
	for _, pair := range codexCommandDescriptions {
		items = append(items, protocol.CommandItem{ID: "command:" + pair[0], Name: pair[0], Source: "codex", Kind: "command", Description: pair[1]})
	}
	seen := make(map[string]bool)
	for _, skill := range catalog.Skills {
		if seen[skill.Path] || skill.Path == "" {
			continue
		}
		seen[skill.Path] = true
		origin := skill.Scope
		display := ""
		if origin == "repo" {
			origin = "project"
		}
		if origin == "system" {
			origin = "builtin"
		}
		if rel, err := filepath.Rel(catalog.Cwd, skill.Path); err == nil && !strings.HasPrefix(rel, "..") {
			origin = "project"
			display = filepath.ToSlash(rel)
		} else if i := strings.Index(filepath.ToSlash(skill.Path), "/.claude/"); i >= 0 {
			origin = "project"
			display = filepath.ToSlash(skill.Path)[i+1:]
		}
		desc := skill.ShortDescription
		if desc == "" {
			desc = skill.Description
		}
		items = append(items, protocol.CommandItem{ID: nativeSkillID(id, skill.Path), Name: skill.Name, Source: origin, Kind: "skill", Description: desc, DisplayPath: display, Unavailable: skillUnavailable(skill)})
	}
	for _, loadErr := range catalog.Errors {
		display := loadErr.Path
		if rel, err := filepath.Rel(catalog.Cwd, display); err == nil && !strings.HasPrefix(rel, "..") {
			display = filepath.ToSlash(rel)
		}
		items = append(items, protocol.CommandItem{ID: "error:" + nativeSkillID(id, loadErr.Path), Name: filepath.Base(filepath.Dir(loadErr.Path)), Kind: "skill", Source: "project", DisplayPath: display, Unavailable: "加载失败：" + loadErr.Message})
	}
	sort.SliceStable(items, func(i, j int) bool { return strings.ToLower(items[i].Name) < strings.ToLower(items[j].Name) })
	return items, nil
}
func splitInvocation(text string) (string, string, error) {
	text = strings.TrimSpace(text)
	if !strings.HasPrefix(text, "/") {
		return "", "", errors.New("调用必须以 / 开头")
	}
	text = strings.TrimPrefix(text, "/")
	name, args := text, ""
	if index := strings.IndexFunc(text, unicode.IsSpace); index >= 0 {
		name, args = text[:index], text[index:]
	}
	name = strings.TrimSpace(name)
	if name == "" {
		return "", "", errors.New("请选择命令或技能")
	}
	return name, strings.TrimSpace(args), nil
}
func (sm *SessionManager) resolveCodexSkill(ctx context.Context, id, text, entryID string) (codexapp.SkillMetadata, error) {
	name, _, err := splitInvocation(text)
	if err != nil {
		return codexapp.SkillMetadata{}, err
	}
	catalog, err := sm.codexSkillCatalog(ctx, id)
	if err != nil {
		return codexapp.SkillMetadata{}, err
	}
	nativePath := ""
	if entryID != "" {
		for _, s := range catalog.Skills {
			if nativeSkillID(id, s.Path) == entryID && s.Name == name {
				nativePath = s.Path
				break
			}
		}
		if nativePath == "" {
			return codexapp.SkillMetadata{}, errors.New("技能已失效，请刷新后选择")
		}
	}
	skill, err := catalog.ResolveSkill(name, nativePath)
	if err != nil {
		return skill, err
	}
	if why := skillUnavailable(skill); why != "" {
		return skill, errors.New(why)
	}
	return skill, nil
}
func choice(label, args string) map[string]any {
	return map[string]any{"label": label, "arguments": args}
}
func choices(title string, options []map[string]any) map[string]any {
	return map[string]any{"kind": "choose", "title": title, "options": options}
}
func textResult(text string) map[string]any { return map[string]any{"kind": "text", "text": text} }

// InvokeCodexCommand performs control-only operations. Skills return a validated
// identity; clients then send the original draft through user_message, preserving
// quota admission, message correlation, hidden context and canonical turn identity.
func (sm *SessionManager) InvokeCodexCommand(ctx context.Context, id, text, entryID string) (map[string]any, error) {
	ctx, release, err := sm.acquireObserverDrive(ctx, id)
	if err != nil {
		return nil, err
	}
	defer release()
	return sm.invokeCodexCommand(ctx, id, text, entryID, false)
}

func (sm *SessionManager) invokeCodexCommand(ctx context.Context, id, text, entryID string, executeTurn bool) (map[string]any, error) {
	b, err := sm.invocationBackend(id)
	if err != nil {
		return nil, err
	}
	name, args, err := splitInvocation(text)
	if err != nil {
		return nil, err
	}
	if name == "cwd" {
		name = "pwd"
	}
	items, err := sm.CodexInvocations(ctx, id)
	if err != nil {
		return nil, err
	}
	var matches []protocol.CommandItem
	for _, item := range items {
		if item.Name == name && (entryID == "" || item.ID == entryID) {
			matches = append(matches, item)
		}
	}
	if len(matches) != 1 {
		return nil, errors.New("未找到唯一调用，请刷新目录并选择具体来源")
	}
	item := matches[0]
	if item.Unavailable != "" {
		return nil, errors.New(item.Unavailable)
	}
	client, _, ok := b.coord.backendClient()
	if !ok {
		return nil, errors.New("Codex runtime disconnected")
	}
	if b.coord.currentTurn(id) != "" && name != "skills" && name != "status" && name != "pwd" && name != "usage" && name != "copy" && name != "export" {
		return nil, errors.New("本轮结束后可调用")
	}
	if executeTurn {
		// review/start and compact/start inherit loaded thread settings instead
		// of accepting turn/start overrides. Apply the authoritative next-turn
		// configuration first, including edits made by the existing UI picker.
		sm.mu.RLock()
		ps := sm.sessions[id]
		permission, model, effort := clonePermission(ps.Permission), ps.Model, ps.Effort
		sm.mu.RUnlock()
		params := map[string]any{"threadId": id}
		applyCodexPermissionParams(params, permission)
		if model != "" {
			params["model"] = model
		}
		if effort != "" {
			params["config"] = map[string]any{"model_reasoning_effort": effort}
		}
		if err := client.Call(ctx, "thread/resume", params, nil); err != nil {
			return nil, err
		}
	}
	if item.Kind == "skill" {
		return map[string]any{"kind": "skill", "entry_id": item.ID}, nil
	}
	switch name {
	case "skills":
		return map[string]any{"kind": "skills", "query": args, "commands": items}, nil
	case "pwd":
		return textResult(b.coord.projectCwd), nil
	case "status":
		sm.mu.RLock()
		ps := sm.sessions[id]
		result := fmt.Sprintf("模型：%s\n目录：%s\n状态：%s\n推理强度：%s", ps.Model, ps.Cwd, ps.Status, ps.Effort)
		permission, _ := json.Marshal(ps.Permission)
		sm.mu.RUnlock()
		return textResult(result + "\n权限：" + string(permission) + "\nToken：此接口未提供，可用 /cost 查看客户端统计"), nil
	case "usage":
		var result any
		if err = client.Call(ctx, "account/rateLimits/read", map[string]any{}, &result); err != nil {
			return nil, err
		}
		raw, _ := json.MarshalIndent(result, "", "  ")
		return textResult(string(raw)), nil
	case "model":
		var result struct {
			Data []struct {
				Model                     string `json:"model"`
				DisplayName               string `json:"displayName"`
				DefaultReasoningEffort    string `json:"defaultReasoningEffort"`
				SupportedReasoningEfforts []struct {
					ReasoningEffort string `json:"reasoningEffort"`
				} `json:"supportedReasoningEfforts"`
			} `json:"data"`
		}
		if err = client.Call(ctx, "model/list", map[string]any{"limit": 100}, &result); err != nil {
			return nil, err
		}
		var options []map[string]any
		for _, model := range result.Data {
			options = append(options, choice(model.Model, model.Model))
			for _, effort := range model.SupportedReasoningEfforts {
				options = append(options, choice(model.Model+" · "+effort.ReasoningEffort, model.Model+" "+effort.ReasoningEffort))
			}
		}
		if args == "" {
			return choices("选择模型与推理强度", options), nil
		}
		valid := false
		for _, o := range options {
			if o["arguments"] == args {
				valid = true
			}
		}
		if !valid {
			return nil, errors.New("模型或推理强度不可用")
		}
		model, effort, _ := strings.Cut(args, " ")
		if effort == "" {
			for _, available := range result.Data {
				if available.Model == model {
					effort = available.DefaultReasoningEffort
					break
				}
			}
			// Older servers can omit the default; require an explicit supported
			// choice rather than silently retaining an unrelated old override.
			if effort == "" {
				return choices("请选择推理强度", filterEffortChoices(options, model)), nil
			}
		}
		params := map[string]any{"threadId": id, "model": model}
		if effort != "" {
			params["config"] = map[string]any{"model_reasoning_effort": effort}
		}
		if err = client.Call(ctx, "thread/resume", params, nil); err != nil {
			return nil, err
		}
		sm.mu.Lock()
		sm.sessions[id].Model = model
		sm.sessions[id].Effort = effort
		sm.mu.Unlock()
		sm.outputCh <- protocol.DaemonEvent{Type: "session_meta", SessionID: id, Model: model, Effort: effort}
		return textResult("后续回合使用 " + args), nil
	case "permissions":
		if args == "" {
			return choices("选择会话权限", []map[string]any{choice("只读", "read-only"), choice("工作目录可写，按需审批", "workspace-write"), choice("完全访问…", "danger-full-access")}), nil
		}
		if args == "danger-full-access" {
			return choices("完全访问会关闭沙箱和逐项审批，是否启用？", []map[string]any{choice("确认启用完全访问", "danger-full-access confirm")}), nil
		}
		permission := &protocol.PermissionConfig{Agent: "codex", Preset: "custom", SandboxMode: args, ApprovalPolicy: "on-request"}
		if args == "danger-full-access confirm" {
			permission = &protocol.PermissionConfig{Agent: "codex", Preset: "full_access", DangerousBypass: true}
		} else if args != "read-only" && args != "workspace-write" {
			return nil, errors.New("不支持的权限配置")
		}
		sm.mu.RLock()
		policy := sm.remotePermission
		sm.mu.RUnlock()
		if err := adapter.ValidateRemotePermissionConfigWithPolicy(adapter.AgentCodex, permission, policy); err != nil {
			return nil, err
		}
		err = sm.setPermissionConfig(ctx, id, permission)
		return textResult("权限将在下个回合生效"), err
	case "rename":
		if args == "" {
			return map[string]any{"kind": "input", "title": "重命名会话"}, nil
		}
		if len(args) > 512 {
			return nil, errors.New("名称过长")
		}
		err = client.Call(ctx, "thread/name/set", map[string]any{"threadId": id, "name": args}, nil)
		if err == nil {
			sm.outputCh <- protocol.DaemonEvent{Type: "session_title_update", SessionID: id, Title: args}
		}
		return textResult("名称已更新"), err
	case "compact":
		if !executeTurn {
			return map[string]any{"kind": "turn_command", "entry_id": "command:compact"}, nil
		}
		err = client.Call(ctx, "thread/compact/start", map[string]any{"threadId": id}, nil)
		return textResult("已请求压缩上下文，请等待原生执行完成"), err
	case "review":
		if args == "" {
			return choices("选择审查范围", []map[string]any{choice("当前未提交修改", "uncommitted"), choice("自定义审查范围…", "custom:")}), nil
		}
		target := map[string]any{"type": "custom", "instructions": args}
		switch {
		case args == "uncommitted":
			target = map[string]any{"type": "uncommittedChanges"}
		case strings.HasPrefix(args, "base:"):
			target = map[string]any{"type": "baseBranch", "branch": strings.TrimPrefix(args, "base:")}
		case strings.HasPrefix(args, "commit:"):
			target = map[string]any{"type": "commit", "sha": strings.TrimPrefix(args, "commit:")}
		case args == "custom:":
			return map[string]any{"kind": "input", "title": "输入 base:分支、commit:提交或审查说明"}, nil
		}
		if !executeTurn {
			return map[string]any{"kind": "turn_command", "entry_id": "command:review"}, nil
		}
		var response struct {
			Turn struct {
				ID string `json:"id"`
			} `json:"turn"`
		}
		err = client.Call(ctx, "review/start", map[string]any{"threadId": id, "target": target, "delivery": "inline"}, &response)
		if err == nil && response.Turn.ID != "" {
			b.coord.setActiveTurn(id, response.Turn.ID)
			b.reserveNativeTurn(id, response.Turn.ID)
		}
		return textResult("已请求代码审查"), err
	case "new", "fork":
		if args != "confirm" {
			return choices("当前目录已有本会话，是否继续创建？", []map[string]any{choice("继续创建独立会话", "confirm")}), nil
		}
		return map[string]any{"kind": "create", "cwd": b.coord.projectCwd, "force": true, "fork_from": func() string {
			if name == "fork" {
				return id
			}
			return ""
		}()}, nil
	case "resume":
		sm.mu.RLock()
		var options []map[string]any
		for sessionID, ps := range sm.sessions {
			if backend, ok := ps.Backend.(*CodexAppServerBackend); ok && backend.coord == b.coord {
				options = append(options, choice(sessionID, sessionID))
			}
		}
		sm.mu.RUnlock()
		sort.Slice(options, func(i, j int) bool { return options[i]["label"].(string) < options[j]["label"].(string) })
		if args == "" {
			return choices("继续本项目会话", options), nil
		}
		if !b.coord.ownsInvocationThread(args) {
			return nil, errors.New("会话不属于当前项目运行时")
		}
		if err = client.Call(ctx, "thread/resume", map[string]any{"threadId": args}, nil); err != nil {
			return nil, err
		}
		return map[string]any{"kind": "navigate", "session_id": args}, nil
	case "copy", "export":
		markdown, last, err := codexVisibleHistory(ctx, client, id)
		if err != nil {
			return nil, err
		}
		if name == "copy" {
			return map[string]any{"kind": "copy", "text": last}, nil
		}
		return map[string]any{"kind": "export", "text": markdown, "filename": "codex-" + id + ".md"}, nil
	}
	return nil, errors.New("不支持此调用")
}
func filterEffortChoices(options []map[string]any, model string) []map[string]any {
	var filtered []map[string]any
	for _, option := range options {
		if strings.HasPrefix(option["arguments"].(string), model+" ") {
			filtered = append(filtered, option)
		}
	}
	return filtered
}
func codexVisibleHistory(ctx context.Context, client codexRuntimeClient, id string) (string, string, error) {
	var sections []string
	last := ""
	cursor := ""
	seen := map[string]bool{}
	size := 0
	for page := 0; page < 1000; page++ {
		var result struct {
			Data []struct {
				Items []struct {
					Type    string `json:"type"`
					Text    string `json:"text"`
					Phase   string `json:"phase"`
					Content []struct {
						Type string `json:"type"`
						Text string `json:"text"`
					} `json:"content"`
				} `json:"items"`
			} `json:"data"`
			NextCursor string `json:"nextCursor"`
		}
		params := map[string]any{"threadId": id, "itemsView": "full", "sortDirection": "asc", "limit": 100}
		if cursor != "" {
			params["cursor"] = cursor
		}
		if err := client.Call(ctx, "thread/turns/list", params, &result); err != nil {
			return "", "", err
		}
		for _, turn := range result.Data {
			for _, item := range turn.Items {
				title := ""
				body := item.Text
				switch item.Type {
				case "userMessage":
					title = "用户"
					var parts []string
					for _, part := range item.Content {
						if part.Type == "text" {
							parts = append(parts, part.Text)
						}
					}
					body = strings.Join(parts, "\n")
				case "agentMessage":
					title = "Codex"
					if item.Phase == "" || item.Phase == "final_answer" {
						last = body
					}
				default:
					continue
				}
				size += len(body)
				if size > 8<<20 {
					return "", "", errors.New("会话导出超过 8 MiB，未生成部分导出")
				}
				sections = append(sections, "## "+title+"\n\n"+body)
			}
		}
		if result.NextCursor == "" {
			return strings.Join(sections, "\n\n"), last, nil
		}
		if seen[result.NextCursor] {
			return "", "", errors.New("历史分页循环")
		}
		cursor = result.NextCursor
		seen[cursor] = true
	}
	return "", "", errors.New("历史未完整读取，未生成部分导出")
}

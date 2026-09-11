package session

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/pocketctl/pocketctl/internal/adapter"
	"github.com/pocketctl/pocketctl/internal/codexapp"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

func invocationFixture(t *testing.T) (*SessionManager, *codexCoordinator, *fakeCodexRuntimeClient, string) {
	t.Helper()
	cwd := t.TempDir()
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 64))
	c := newVerifiedTestCodexCoordinator(sm)
	c.projectCwd = cwd
	c.statePath = filepath.Join(t.TempDir(), "runtime.state")
	rpc := newFakeCodexRuntimeClient()
	c.runtime = &codexAppServerRuntime{Client: rpc}
	c.generation = 1
	paths := []string{filepath.Join(cwd, ".claude", "skills", "review", "SKILL.md"), filepath.Join(cwd, ".codex", "skills", "review", "SKILL.md")}
	var skills []codexapp.SkillMetadata
	for _, path := range paths {
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("---\nname: review-code\ndescription: Review fixture\n---\nReview only"), 0600); err != nil {
			t.Fatal(err)
		}
		skills = append(skills, codexapp.SkillMetadata{Name: "review-code", Description: "Review", Path: path, Scope: "repo", Enabled: true})
	}
	raw, _ := json.Marshal(codexapp.SkillsListResponse{Data: []codexapp.SkillsCatalog{{Cwd: cwd, Skills: skills}}})
	rpc.results["skills/list"] = raw
	rpc.results["turn/start"] = json.RawMessage(`{"turn":{"id":"turn-1"}}`)
	sm.sessions["s"] = &ProcessState{SessionID: "s", Cwd: cwd, Agent: "codex", ControlMode: protocol.ControlManaged, Source: "daemon", Status: "idle", Backend: newCodexAppServerBackend(sm, c, rpc, 1)}
	return sm, c, rpc, paths[0]
}
func TestCodexInvocationCatalogAndExplicitSkill(t *testing.T) {
	sm, c, rpc, path := invocationFixture(t)
	ctx := context.Background()
	items, err := sm.CodexInvocations(ctx, "s")
	if err != nil || len(items) != 16 {
		t.Fatalf("catalog %d %v", len(items), err)
	}
	if _, err = sm.InvokeCodexCommand(ctx, "s", "/review-code task", ""); err == nil {
		t.Fatal("ambiguous name accepted")
	}
	id := nativeSkillID("s", path)
	result, err := sm.InvokeCodexCommand(ctx, "s", "/review-code task", id)
	if err != nil || result["kind"] != "skill" {
		t.Fatalf("preflight: %v %v", result, err)
	}
	b := sm.sessions["s"].Backend.(*CodexAppServerBackend)
	ctx = context.WithValue(ctx, codexInvocationKey{}, id)
	ctx = withUserMessageCorrelation(ctx, userMessageCorrelation{MsgID: "message-1"})
	if err = b.Send(ctx, "s", "/review-code task"); err != nil {
		t.Fatal(err)
	}
	call := rpc.lastCall(t, "turn/start")
	var params map[string]any
	_ = json.Unmarshal(call.params, &params)
	inputs := params["input"].([]any)
	if inputs[0].(map[string]any)["text"] != "/review-code task" || inputs[1].(map[string]any)["path"] != path || params["clientUserMessageId"] != "message-1" {
		t.Fatalf("lost native identity or original echo: %s", call.params)
	}
	c.setActiveTurn("s", "running")
	if _, err = sm.InvokeCodexCommand(ctx, "s", "/review-code task", id); err == nil {
		t.Fatal("busy skill accepted")
	}
	if _, err = sm.resolveCodexSkill(context.Background(), "s", "/review-code", nativeSkillID("other-session", path)); err == nil {
		t.Fatal("foreign session identity accepted")
	}
}
func TestCodexInvocationModelsAndExportFailure(t *testing.T) {
	sm, _, rpc, _ := invocationFixture(t)
	ctx := context.Background()
	rpc.results["model/list"] = json.RawMessage(`{"data":[{"model":"fixture","supportedReasoningEfforts":[{"reasoningEffort":"high"}]}]}`)
	if _, err := sm.InvokeCodexCommand(ctx, "s", "/model fixture high", ""); err != nil {
		t.Fatal(err)
	}
	if sm.sessions["s"].Model != "fixture" || sm.sessions["s"].Effort != "high" {
		t.Fatal("model only changed presentation")
	}
	rpc.results["thread/turns/list"] = json.RawMessage(`{"data":[],"nextCursor":"same"}`)
	if _, err := sm.InvokeCodexCommand(ctx, "s", "/export", ""); err == nil {
		t.Fatal("partial export accepted on cursor loop")
	}
}
func TestCodexProjectRootsAndLegacyIsolation(t *testing.T) {
	sm, c, _, _ := invocationFixture(t)
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(c.projectCwd, ".claude", "escape")); err != nil {
		t.Fatal(err)
	}
	if _, err := codexProjectSkillRoots(c.projectCwd); err == nil {
		t.Fatal("cross-project link accepted")
	}
	c.projectCwd = ""
	if _, err := sm.CodexInvocations(context.Background(), "s"); err == nil {
		t.Fatal("legacy shared runtime opted in")
	}
}

func TestCodexProjectRuntimeNamespacesPersistWithoutChangingLegacy(t *testing.T) {
	sm := NewSessionManager(make(chan protocol.DaemonEvent, 64))
	provider := newCodexRuntimeProvider(sm)
	a, err := provider.projectCoordinator(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	b, err := provider.projectCoordinator(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if a == b || a.runtimeStatePath() == b.runtimeStatePath() || a.generation == b.generation {
		t.Fatal("project runtimes share identity")
	}
	if provider.coordinator.projectCwd != "" {
		t.Fatal("legacy runtime was reconfigured")
	}
	again, err := provider.projectCoordinator(a.projectCwd)
	if err != nil || again != a {
		t.Fatal("same cwd spawned another runtime")
	}
	a.statePath = filepath.Join(t.TempDir(), "project.state")
	a.runtime = &codexAppServerRuntime{PID: 123, Endpoint: "fixture", RemoteURI: "fixture", Client: newFakeCodexRuntimeClient(), Stop: func() error { return nil }}
	if err := a.persist(); err != nil {
		t.Fatal(err)
	}
	state, err := a.readState()
	if err != nil || state.Cwd != a.projectCwd {
		t.Fatalf("lost restart context: %+v %v", state, err)
	}
	if err := a.shutdown(); err != nil {
		t.Fatal(err)
	}
	if _, err := a.readState(); err != nil {
		t.Fatalf("project restart metadata discarded: %v", err)
	}
}

func TestCodexTurnControlsRequireUserMessageAdmission(t *testing.T) {
	sm, _, rpc, _ := invocationFixture(t)
	for _, command := range []string{"/compact", "/review uncommitted"} {
		result, err := sm.InvokeCodexCommand(context.Background(), "s", command, "")
		if err != nil || result["kind"] != "turn_command" {
			t.Fatalf("preflight %s: %v %v", command, result, err)
		}
	}
	for _, call := range rpc.calls {
		if call.method == "review/start" || call.method == "thread/compact/start" {
			t.Fatal("preflight executed a model operation without quota admission")
		}
	}
}
func TestCodexProjectTurnUsesNativeSandboxPolicy(t *testing.T) {
	sm, _, rpc, _ := invocationFixture(t)
	sm.sessions["s"].Permission = &protocol.PermissionConfig{Agent: "codex", ApprovalPolicy: "on-request", SandboxMode: "read-only"}
	if err := sm.sessions["s"].Backend.Send(context.Background(), "s", "hello"); err != nil {
		t.Fatal(err)
	}
	var params map[string]any
	_ = json.Unmarshal(rpc.lastCall(t, "turn/start").params, &params)
	if params["sandbox"] != nil || params["sandboxPolicy"].(map[string]any)["type"] != "readOnly" {
		t.Fatalf("permission was not applied natively: %v", params)
	}
}
func TestClaudeSkillInvocationMetadata(t *testing.T) {
	_, _, _, path := invocationFixture(t)
	skill := codexapp.SkillMetadata{Name: "review", Path: path, Enabled: true}
	for _, test := range []struct {
		header  string
		allowed bool
	}{{"user-invocable: true", true}, {"user-invocable: false", false}, {"'user-invocable': false", false}, {"allowed-tools: [Read]", false}, {"context: fork", false}} {
		_ = os.WriteFile(path, []byte("---\nname: review\ndescription: fixture\n"+test.header+"\n---\nbody"), 0600)
		if got := skillUnavailable(skill) == ""; got != test.allowed {
			t.Fatalf("metadata %q allowed=%v", test.header, got)
		}
	}
}

func TestCodexInvocationNativeControlsApplyLatestPermissions(t *testing.T) {
	sm, _, rpc, _ := invocationFixture(t)
	sm.sessions["s"].Permission = &protocol.PermissionConfig{Agent: "codex", SandboxMode: "read-only", ApprovalPolicy: "on-request"}
	if _, err := sm.invokeCodexCommand(context.Background(), "s", "/compact", "command:compact", true); err != nil {
		t.Fatal(err)
	}
	var params map[string]any
	_ = json.Unmarshal(rpc.lastCall(t, "thread/resume").params, &params)
	if params["sandbox"] != "read-only" || params["approvalPolicy"] != "on-request" {
		t.Fatalf("stale native permissions: %v", params)
	}
}
func TestCodexInvocationModelDefaultReplacesPreviousEffort(t *testing.T) {
	sm, _, rpc, _ := invocationFixture(t)
	sm.sessions["s"].Effort = "high"
	rpc.results["model/list"] = json.RawMessage(`{"data":[{"model":"fixture","defaultReasoningEffort":"medium","supportedReasoningEfforts":[{"reasoningEffort":"medium"},{"reasoningEffort":"high"}]}]}`)
	if _, err := sm.InvokeCodexCommand(context.Background(), "s", "/model\tfixture", ""); err != nil {
		t.Fatal(err)
	}
	var params map[string]any
	_ = json.Unmarshal(rpc.lastCall(t, "thread/resume").params, &params)
	if sm.sessions["s"].Effort != "medium" || params["config"].(map[string]any)["model_reasoning_effort"] != "medium" {
		t.Fatalf("stale effort: %v", params)
	}
}
func TestCodexProjectNestedDirectoryLinkFailsClosed(t *testing.T) {
	_, c, _, _ := invocationFixture(t)
	target := filepath.Join(c.projectCwd, "shared")
	if err := os.MkdirAll(target, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(t.TempDir(), filepath.Join(target, "escape")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, filepath.Join(c.projectCwd, ".claude", "nested")); err != nil {
		t.Fatal(err)
	}
	if _, err := codexProjectSkillRoots(c.projectCwd); err == nil {
		t.Fatal("native traversal could escape through a nested link")
	}
}

func TestCodexInvocationPermissionsRequireExplicitExpansion(t *testing.T) {
	sm, _, _, _ := invocationFixture(t)
	result, err := sm.InvokeCodexCommand(context.Background(), "s", "/permissions danger-full-access", "")
	if err != nil || result["kind"] != "choose" || sm.sessions["s"].Permission != nil {
		t.Fatalf("unconfirmed expansion: %v %v", result, err)
	}
	if _, err = sm.InvokeCodexCommand(context.Background(), "s", "/permissions read-only", ""); err != nil {
		t.Fatal(err)
	}
	if _, err = sm.InvokeCodexCommand(context.Background(), "s", "/permissions danger-full-access confirm", ""); err == nil {
		t.Fatal("remote invocation bypassed host policy")
	}
	sm.SetRemotePermissionPolicy(adapter.RemotePermissionPolicy{AllowDangerous: true})
	if _, err = sm.InvokeCodexCommand(context.Background(), "s", "/permissions danger-full-access confirm", ""); err != nil {
		t.Fatal(err)
	}
	if !sm.sessions["s"].Permission.DangerousBypass {
		t.Fatal("confirmed permission was not applied")
	}
}
func TestCodexInvocationCompactionRequiresNativeCompletion(t *testing.T) {
	p := newCodexProjection(1)
	params := json.RawMessage(`{"threadId":"s","turnId":"t","item":{"id":"compact-1","type":"contextCompaction"}}`)
	for _, event := range p.Project(codexapp.Inbound{Method: "item/started", Params: params}) {
		if event.Type == "agent_compaction" {
			t.Fatal("announced completion at start")
		}
	}
	events := p.Project(codexapp.Inbound{Method: "item/completed", Params: params})
	if len(events) != 1 || events[0].Type != "agent_compaction" || events[0].Status != "completed" || events[0].TurnID == "" {
		t.Fatalf("missing completed compaction event: %+v", events)
	}
	if again := p.Project(codexapp.Inbound{Method: "item/completed", Params: params}); len(again) != 0 {
		t.Fatal("duplicate completion")
	}
}

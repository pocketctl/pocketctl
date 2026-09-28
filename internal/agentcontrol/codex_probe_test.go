package agentcontrol

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

const completeCodexSchema = `
initialize thread/start thread/resume thread/turns/list
turn/start turn/steer turn/interrupt
item/commandExecution/requestApproval item/fileChange/requestApproval
item/permissions/requestApproval item/tool/requestUserInput
mcpServer/elicitation/request serverRequest/resolved`

const emptyThreadPersistenceMethod = `thread/inject_items`

const nativeHiddenSchema = `{"title":"ClientRequest","description":"initialize thread/start thread/resume thread/turns/list turn/interrupt serverRequest/resolved","definitions":{"ThreadInjectItemsParams":{"type":"object","required":["threadId","items"],"properties":{"threadId":{"type":"string"},"items":{"type":"array","items":true}}},"TurnStartParams":{"type":"object","required":["threadId","input"],"properties":{"threadId":{"type":"string"},"input":{"type":"array","items":{"$ref":"#/definitions/UserInput"}}}},"UserInput":{"oneOf":[{"type":"object","required":["type","text"],"properties":{"type":{"type":"string","enum":["text"]},"text":{"type":"string"}}}]}},"oneOf":[{"type":"object","required":["id","method","params"],"properties":{"id":{"type":"string"},"method":{"type":"string","enum":["thread/inject_items"]},"params":{"$ref":"#/definitions/ThreadInjectItemsParams"}}},{"type":"object","required":["id","method","params"],"properties":{"id":{"type":"string"},"method":{"type":"string","enum":["turn/start"]},"params":{"$ref":"#/definitions/TurnStartParams"}}}]}`
const nativeHiddenResponseSchema = `{"title":"ThreadInjectItemsResponse","type":"object"}`

func TestCodexProbeStructurallyValidatesHiddenHistoryAndUserTurn(t *testing.T) {
	// Any missing or changed native contract must leave ordinary persistence
	// available while denying hidden delivery.
	for _, tc := range []struct {
		name, schema string
		want         bool
	}{
		{"supported concatenated documents", nativeHiddenSchema + nativeHiddenResponseSchema, true},
		{"method mentions only", completeCodexSchema + " thread/inject_items ThreadInjectItemsParams TurnStartParams UserInput", false},
		{"trailing malformed JSON", nativeHiddenSchema + nativeHiddenResponseSchema + "{", false},
		{"missing response", nativeHiddenSchema, false},
		{"wrong response type", nativeHiddenSchema + `{"title":"ThreadInjectItemsResponse","type":"string"}`, false},
		{"missing inject required", strings.Replace(nativeHiddenSchema, `["threadId","items"]`, `["threadId"]`, 1) + nativeHiddenResponseSchema, false},
		{"extra inject required", strings.Replace(nativeHiddenSchema, `["threadId","items"]`, `["threadId","items","unknown"]`, 1) + nativeHiddenResponseSchema, false},
		{"wrong items type", strings.Replace(nativeHiddenSchema, `"items":{"type":"array","items":true}`, `"items":{"type":"string"}`, 1) + nativeHiddenResponseSchema, false},
		{"typed items disallow raw response", strings.Replace(nativeHiddenSchema, `"items":true`, `"items":{"type":"string"}`, 1) + nativeHiddenResponseSchema, false},
		{"wrong thread ID type", strings.Replace(nativeHiddenSchema, `"threadId":{"type":"string"}`, `"threadId":{"type":"integer"}`, 1) + nativeHiddenResponseSchema, false},
		{"method uncorrelated params", strings.Replace(nativeHiddenSchema, `"params":{"$ref":"#/definitions/ThreadInjectItemsParams"}`, `"params":{"$ref":"#/definitions/TurnStartParams"}`, 1) + nativeHiddenResponseSchema, false},
		{"missing user text required", strings.Replace(nativeHiddenSchema, `["type","text"]`, `["type"]`, 1) + nativeHiddenResponseSchema, false},
		{"user text must be string", strings.Replace(nativeHiddenSchema, `"text":{"type":"string"}`, `"text":{"type":"integer"}`, 1) + nativeHiddenResponseSchema, false},
		{"required role cannot preserve user input", strings.Replace(nativeHiddenSchema, `["type","text"]`, `["type","text","role"]`, 1) + nativeHiddenResponseSchema, false},
		{"wrong input array", strings.Replace(nativeHiddenSchema, `"input":{"type":"array"`, `"input":{"type":"string"`, 1) + nativeHiddenResponseSchema, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p := CodexProbe{Run: func(context.Context, string, ...string) ([]byte, error) {
				return []byte("--remote --listen unix://"), nil
			}, GenerateSchema: func(context.Context, string) ([]byte, error) { return []byte(tc.schema), nil }}
			caps, err := p.Probe(context.Background(), "/test/codex", "0.154.0")
			if err != nil {
				t.Fatal(err)
			}
			if caps.HiddenContext != tc.want || !caps.ThreadInjection || caps.SchemaHash == "" {
				t.Fatalf("capabilities=%+v want hidden=%t", caps, tc.want)
			}
		})
	}
	var bundled map[string]any
	if err := json.Unmarshal([]byte(nativeHiddenSchema), &bundled); err != nil {
		t.Fatal(err)
	}
	delete(bundled, "title")
	definitions := bundled["definitions"].(map[string]any)
	delete(bundled, "definitions")
	definitions["ClientRequest"] = bundled
	bundle, _ := json.Marshal(map[string]any{"definitions": definitions})
	p := CodexProbe{Run: func(context.Context, string, ...string) ([]byte, error) {
		return []byte("--remote --listen unix://"), nil
	}, GenerateSchema: func(context.Context, string) ([]byte, error) {
		return append(bundle, []byte(nativeHiddenResponseSchema)...), nil
	}}
	if caps, err := p.Probe(context.Background(), "/test/codex", "0.154.0"); err != nil || !caps.HiddenContext {
		t.Fatalf("bundled schema=%+v error=%v", caps, err)
	}
}

func TestCodexProbeReportsGranularCapabilities(t *testing.T) {
	probe := CodexProbe{
		Timeout: time.Second,
		Run: func(_ context.Context, _ string, args ...string) ([]byte, error) {
			switch strings.Join(args, " ") {
			case "--help":
				return []byte("--remote <ADDR> --remote-auth-token-env <ENV_VAR>"), nil
			case "app-server --help":
				return []byte("--listen <URL> unix:// ws://"), nil
			default:
				t.Fatalf("unexpected args: %v", args)
				return nil, nil
			}
		},
		GenerateSchema: func(context.Context, string) ([]byte, error) {
			return []byte(completeCodexSchema + " " + emptyThreadPersistenceMethod), nil
		},
	}
	caps, err := probe.Probe(context.Background(), "/opt/codex", "0.144.1")
	if err != nil {
		t.Fatal(err)
	}
	if !caps.Managed() || !caps.Core || !caps.TerminalRemote || !caps.Steer || !caps.Approvals || !caps.UserInput || !caps.MCPElicitation || !caps.ThreadInjection {
		t.Fatalf("incomplete capabilities: %+v", caps)
	}
	if caps.SchemaHash == "" {
		t.Fatal("schema hash is empty")
	}
}

func TestCodexProbeKeepsManagedCapabilityWithoutEmptyThreadPersistence(t *testing.T) {
	probe := CodexProbe{
		Run: func(_ context.Context, _ string, args ...string) ([]byte, error) {
			if len(args) == 1 {
				return []byte("--remote <ADDR>"), nil
			}
			return []byte("--listen <URL> unix://"), nil
		},
		GenerateSchema: func(context.Context, string) ([]byte, error) { return []byte(completeCodexSchema), nil },
	}
	caps, err := probe.Probe(context.Background(), "/opt/codex", "0.144.1")
	if err != nil || !caps.Managed() || caps.ThreadInjection {
		t.Fatalf("caps=%+v error=%v", caps, err)
	}
}

func TestCodexProbeRejectsOldVersionWithoutRunningCommands(t *testing.T) {
	probe := CodexProbe{Run: func(context.Context, string, ...string) ([]byte, error) {
		t.Fatal("old version must not execute capability probes")
		return nil, nil
	}}
	caps, err := probe.Probe(context.Background(), "/opt/codex", "0.144.0")
	if !errors.Is(err, ErrCodexVersionUnsupported) {
		t.Fatalf("error=%v, want ErrCodexVersionUnsupported", err)
	}
	if caps.Managed() {
		t.Fatalf("old version reported managed: %+v", caps)
	}
}

func TestCodexProbeRequiresCoreButKeepsPartialCapabilities(t *testing.T) {
	probe := CodexProbe{
		Run: func(_ context.Context, _ string, args ...string) ([]byte, error) {
			if len(args) == 1 {
				return []byte("--remote <ADDR>"), nil
			}
			return []byte("--listen <URL> unix://"), nil
		},
		GenerateSchema: func(context.Context, string) ([]byte, error) {
			return []byte("initialize thread/start thread/resume turn/start turn/interrupt"), nil
		},
	}
	caps, err := probe.Probe(context.Background(), "/opt/codex", "0.144.1")
	if !errors.Is(err, ErrCodexCapabilities) {
		t.Fatalf("error=%v, want ErrCodexCapabilities", err)
	}
	if !caps.TerminalRemote || caps.Core || caps.Managed() {
		t.Fatalf("unexpected partial capabilities: %+v", caps)
	}
}

func TestCodexProbeHonorsTimeout(t *testing.T) {
	probe := CodexProbe{
		Timeout: 20 * time.Millisecond,
		Run: func(ctx context.Context, _ string, _ ...string) ([]byte, error) {
			<-ctx.Done()
			return nil, ctx.Err()
		},
	}
	start := time.Now()
	_, err := probe.Probe(context.Background(), "/opt/codex", "0.144.1")
	if !errors.Is(err, ErrCodexProbeTimeout) {
		t.Fatalf("error=%v, want ErrCodexProbeTimeout", err)
	}
	if elapsed := time.Since(start); elapsed > 250*time.Millisecond {
		t.Fatalf("timeout took %v", elapsed)
	}
}

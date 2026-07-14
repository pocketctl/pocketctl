package adapter

import "testing"

func TestConvertOpencodePart_Text(t *testing.T) {
	// Real text-part shape from storage/part/.../prt_*.json
	p, err := ParseOpencodePart([]byte(`{
		"id":"prt_x","sessionID":"ses_x","messageID":"msg_x",
		"type":"text","text":"现在开始实施 P2 阶段计划。",
		"time":{"start":1768953957903,"end":1768953957903}
	}`))
	if err != nil {
		t.Fatal(err)
	}
	// assistant text → agent_text with model
	got := ConvertOpencodePart(p, "assistant", "glm-5")
	if len(got) != 1 || got[0].Type != "agent_text" || got[0].Model != "glm-5" || got[0].Text == "" {
		t.Fatalf("assistant text mapping wrong: %+v", got)
	}
	// user text → user_text
	got = ConvertOpencodePart(p, "user", "")
	if len(got) != 1 || got[0].Type != "user_text" {
		t.Fatalf("user text mapping wrong: %+v", got)
	}
	// empty text → nothing
	p.Text = "   "
	if got := ConvertOpencodePart(p, "assistant", "glm-5"); got != nil {
		t.Fatalf("empty text should map to nil, got %+v", got)
	}
}

func TestConvertOpencodePart_Tool(t *testing.T) {
	// Real tool-part shape (completed): carries callID, tool, state.output
	completed, err := ParseOpencodePart([]byte(`{
		"id":"prt_y","sessionID":"ses_y","messageID":"msg_y",
		"type":"tool","callID":"call_1","tool":"grep",
		"state":{"status":"completed","input":{"pattern":"x"},"output":"Found 1 match"}
	}`))
	if err != nil {
		t.Fatal(err)
	}
	got := ConvertOpencodePart(completed, "assistant", "glm-5")
	if len(got) != 1 || got[0].Type != "tool_result" || got[0].CallID != "call_1" || got[0].Output != "Found 1 match" {
		t.Fatalf("completed tool mapping wrong: %+v", got)
	}

	// running → tool_call with tool + input
	running, _ := ParseOpencodePart([]byte(`{
		"type":"tool","callID":"call_1","tool":"grep",
		"state":{"status":"running","input":{"pattern":"x"}}
	}`))
	got = ConvertOpencodePart(running, "assistant", "glm-5")
	if len(got) != 1 || got[0].Type != "tool_call" || got[0].Tool != "grep" || got[0].CallID != "call_1" || len(got[0].Input) == 0 {
		t.Fatalf("running tool mapping wrong: %+v", got)
	}
}

func TestConvertOpencodePart_StepFinish(t *testing.T) {
	// Real step-finish shape: token accounting
	p, err := ParseOpencodePart([]byte(`{
		"id":"prt_z","type":"step-finish","reason":"tool-calls",
		"tokens":{"input":460,"output":88,"reasoning":0,"cache":{"read":124407,"write":577}}
	}`))
	if err != nil {
		t.Fatal(err)
	}
	got := ConvertOpencodePart(p, "assistant", "glm-5")
	if len(got) != 1 || got[0].Usage == nil {
		t.Fatalf("step-finish should yield usage event: %+v", got)
	}
	u := got[0].Usage
	if u.InputTokens != 460 || u.OutputTokens != 88 || u.CacheRead != 124407 || u.CacheCreate != 577 {
		t.Fatalf("usage mapping wrong: %+v", u)
	}
}

func TestConvertOpencodePart_Skipped(t *testing.T) {
	for _, typ := range []string{"step-start", "patch", "file"} {
		p := &OpencodePart{Type: typ}
		if got := ConvertOpencodePart(p, "assistant", "glm-5"); got != nil {
			t.Fatalf("%s should map to nil, got %+v", typ, got)
		}
	}
}

func TestConvertOpencodePart_Reasoning(t *testing.T) {
	p := &OpencodePart{Type: "reasoning", Text: "checking the repository"}
	got := ConvertOpencodePart(p, "assistant", "glm-5")
	if len(got) != 1 || got[0].Type != "agent_reasoning" || got[0].Text != p.Text || got[0].Model != "glm-5" {
		t.Fatalf("reasoning mapping wrong: %+v", got)
	}
}

func TestParseOpencodeMessage(t *testing.T) {
	// Real message shape from storage/message/<sid>/msg_*.json
	m, err := ParseOpencodeMessage([]byte(`{
		"id":"msg_x","sessionID":"ses_x","role":"user",
		"time":{"created":1772514046913},"agent":"Sisyphus",
		"model":{"providerID":"zhipuai-coding-plan","modelID":"glm-5"},
		"path":{"cwd":"/Users/x/proj","root":"/"}
	}`))
	if err != nil {
		t.Fatal(err)
	}
	if m.Role != "user" || m.OpencodeModelDisplay() != "zhipuai-coding-plan/glm-5" || m.Path == nil || m.Path.Cwd != "/Users/x/proj" {
		t.Fatalf("message parse wrong: %+v", m)
	}
}

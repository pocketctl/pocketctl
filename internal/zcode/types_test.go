package zcode

import "testing"

func TestDecodeMessageData_Shapes(t *testing.T) {
	// shape 1: top-level providerID/modelID
	m1, ok := DecodeMessageData(`{"role":"assistant","providerID":"anthropic","modelID":"claude-x"}`)
	if !ok {
		t.Fatal("decode shape1 failed")
	}
	if got := m1.ResolveModel(); got != "anthropic/claude-x" {
		t.Fatalf("model shape1 = %q", got)
	}
	// shape 2: nested model object
	m2, ok := DecodeMessageData(`{"role":"assistant","model":{"providerID":"openai","modelID":"gpt-y"}}`)
	if !ok {
		t.Fatal("decode shape2 failed")
	}
	if got := m2.ResolveModel(); got != "openai/gpt-y" {
		t.Fatalf("model shape2 = %q", got)
	}
	// shape 3: only modelID
	m3, ok := DecodeMessageData(`{"role":"assistant","modelID":"only-model"}`)
	if !ok {
		t.Fatal("decode shape3 failed")
	}
	if got := m3.ResolveModel(); got != "only-model" {
		t.Fatalf("model shape3 = %q", got)
	}
	// shape 4: none
	m4, ok := DecodeMessageData(`{"role":"assistant"}`)
	if !ok {
		t.Fatal("decode shape4 failed")
	}
	if got := m4.ResolveModel(); got != "" {
		t.Fatalf("model shape4 = %q want empty", got)
	}
}

func TestDecodeMessageData_BadJSON(t *testing.T) {
	if _, ok := DecodeMessageData(`{not json`); ok {
		t.Fatal("bad JSON should decode-fail")
	}
	if _, ok := DecodePartData(`{not json`); ok {
		t.Fatal("bad JSON part should decode-fail")
	}
}

func TestMessageVisible_FilterRules(t *testing.T) {
	tests := []struct {
		name string
		data ZcodeMessageData
		want bool
	}{
		{"user visible", ZcodeMessageData{Role: "user"}, true},
		{"assistant visible", ZcodeMessageData{Role: "assistant"}, true},
		{"unknown role", ZcodeMessageData{Role: "system"}, false},
		{"synthetic", ZcodeMessageData{Role: "assistant", Synthetic: true}, false},
		{"hidden", ZcodeMessageData{Role: "assistant", Hidden: true}, false},
		{"internal", ZcodeMessageData{Role: "assistant", Internal: true}, false},
		{"visibility blocked", ZcodeMessageData{Role: "assistant", Visibility: "internal"}, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := MessageVisible(tt.data); got != tt.want {
				t.Fatalf("MessageVisible = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestDecodeMessageData_FinishField(t *testing.T) {
	// assistant with finish=stop
	m, ok := DecodeMessageData(`{"role":"assistant","finish":"stop"}`)
	if !ok || m.Finish != "stop" {
		t.Fatalf("finish=stop: ok=%v finish=%q", ok, m.Finish)
	}
	// assistant with finish empty (running / generating)
	m2, ok := DecodeMessageData(`{"role":"assistant"}`)
	if !ok || m2.Finish != "" {
		t.Fatalf("finish empty: ok=%v finish=%q", ok, m2.Finish)
	}
	// user message (no finish)
	m3, ok := DecodeMessageData(`{"role":"user"}`)
	if !ok || m3.Finish != "" {
		t.Fatalf("user finish: ok=%v finish=%q", ok, m3.Finish)
	}
}

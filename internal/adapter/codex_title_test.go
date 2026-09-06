package adapter

import "testing"

func TestCodexTitleUserMessageSupportsDesktopResponseItems(t *testing.T) {
	lines := []string{
		`{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>injected</environment_context>"}]}}`,
		`{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"# AGENTS.md instructions for /repo"}]}}`,
		`{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"修复"},{"type":"input_text","text":"会话标题"}]}}`,
	}
	if got := CodexExtractFirstUserMessage(lines, 200); got != "修复会话标题" {
		t.Fatalf("got %q", got)
	}
	legacy := []string{`{"type":"event_msg","payload":{"type":"user_message","message":"legacy request"}}`}
	if got := CodexExtractFirstUserMessage(legacy, 200); got != "legacy request" {
		t.Fatalf("legacy=%q", got)
	}
}

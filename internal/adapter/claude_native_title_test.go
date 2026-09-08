package adapter

import "testing"

func TestClaudeNativeTitles(t *testing.T) {
	for _, tc := range []struct{ line, title, source string }{
		{`{"type":"ai-title","aiTitle":" AI name ","sessionId":"sid"}`, "AI name", "claude-code"},
		{`{"type":"custom-title","customTitle":" Custom name ","sessionId":"sid"}`, "Custom name", "claude-code-manual"},
	} {
		events, err := NewClaudeAdapter("").ParseStreamLine(tc.line)
		if err != nil || len(events) != 1 || events[0].Type != "session_title_update" || events[0].Title != tc.title || events[0].TitleSource != tc.source || events[0].SessionID != "sid" {
			t.Fatalf("native title: %+v, %v", events, err)
		}
	}
	if events, _ := NewClaudeAdapter("").ParseStreamLine(`{"type":"ai-title","aiTitle":"  "}`); len(events) != 0 {
		t.Fatal("empty title must be ignored")
	}
}

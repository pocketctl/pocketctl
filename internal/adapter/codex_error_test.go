package adapter

import (
	"encoding/json"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestProjectCodexErrorUsageLimitShapes(t *testing.T) {
	tests := []struct {
		name string
		raw  string
	}{
		{"app-server camel case", `{"message":"You've hit your usage limit.","codexErrorInfo":"usageLimitExceeded"}`},
		{"rollout snake case", `{"message":"You've hit your usage limit.","codex_error_info":"usage_limit_exceeded"}`},
		{"documented pascal case", `{"message":"You've hit your usage limit.","codexErrorInfo":"UsageLimitExceeded"}`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ProjectCodexError(json.RawMessage(tt.raw))
			if !got.Present || got.Code != CodexUsageLimitExceededCode || got.Message != "You've hit your usage limit." {
				t.Fatalf("ProjectCodexError() = %+v", got)
			}
		})
	}
}

func TestProjectCodexErrorFailsClosed(t *testing.T) {
	tests := []struct {
		name    string
		raw     string
		present bool
	}{
		{"missing", ``, false},
		{"null", `null`, false},
		{"malformed", `{`, true},
		{"unknown", `{"message":"secret diagnostic","codexErrorInfo":"other","additionalDetails":"do not expose"}`, true},
		{"object info", `{"message":"provider body","codexErrorInfo":{"httpConnectionFailed":{"httpStatusCode":500}}}`, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ProjectCodexError(json.RawMessage(tt.raw))
			if got.Present != tt.present {
				t.Fatalf("Present = %t, want %t", got.Present, tt.present)
			}
			if tt.present && (got.Code != CodexTurnFailedCode || got.Message != CodexTurnFailedMessage) {
				t.Fatalf("fallback = %+v", got)
			}
		})
	}
}

func TestProjectCodexErrorSanitizesAndBoundsUsageMessage(t *testing.T) {
	message := " \r\nlimit\x00reached\x07 " + strings.Repeat("界", 2000)
	raw, err := json.Marshal(map[string]any{
		"message":           message,
		"codexErrorInfo":    "usageLimitExceeded",
		"additionalDetails": "must not appear",
	})
	if err != nil {
		t.Fatal(err)
	}
	got := ProjectCodexError(raw)
	if !got.Present || got.Code != CodexUsageLimitExceededCode {
		t.Fatalf("projected = %+v", got)
	}
	if len(got.Message) > codexErrorMessageMaxBytes || !utf8.ValidString(got.Message) || !strings.HasSuffix(got.Message, "…") {
		t.Fatalf("invalid bounded message bytes=%d valid=%t suffix=%q", len(got.Message), utf8.ValidString(got.Message), got.Message[len(got.Message)-3:])
	}
	if strings.Contains(got.Message, "\x00") || strings.Contains(got.Message, "\x07") || strings.Contains(got.Message, "must not appear") {
		t.Fatalf("unsafe content survived: %q", got.Message)
	}
}

func TestProjectCodexErrorUsesSafeEmptyUsageFallback(t *testing.T) {
	got := ProjectCodexError(json.RawMessage(`{"message":"  ","codexErrorInfo":"usageLimitExceeded"}`))
	if got.Code != CodexUsageLimitExceededCode || got.Message != codexUsageLimitFallbackMessage {
		t.Fatalf("fallback = %+v", got)
	}
}

func TestCodexErrorEventIDIsStableAndContentFree(t *testing.T) {
	a := CodexErrorEventID("turn-1", CodexUsageLimitExceededCode, "limit reached")
	b := CodexErrorEventID("turn-1", CodexUsageLimitExceededCode, "limit reached")
	c := CodexErrorEventID("turn-2", CodexUsageLimitExceededCode, "limit reached")
	if a != b || a == c || !strings.HasPrefix(a, "codex:error:") {
		t.Fatalf("ids = %q %q %q", a, b, c)
	}
	if strings.Contains(a, "turn-1") || strings.Contains(a, "limit") {
		t.Fatalf("event id leaks content: %q", a)
	}
}

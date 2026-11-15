package usageanalytics

import (
	"github.com/pocketctl/pocketctl/internal/protocol"
	"testing"
)

func TestNormalize(t *testing.T) {
	u, e := Normalize(protocol.ContextUsage{InputTokens: 100, OutputTokens: 20, CacheRead: 40, ReasoningTokens: 8}, "includes_cache")
	if e != nil || u.InputTokens != 60 || u.TotalTokens != 120 {
		t.Fatalf("%+v %v", u, e)
	}
	if _, e = Normalize(u, "unknown"); e == nil {
		t.Fatal("guessed unknown")
	}
}

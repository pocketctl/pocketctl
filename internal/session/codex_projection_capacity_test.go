package session

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func TestCodexTextDeltasRetainStableSnapshotsAndIdentities(t *testing.T) {
	p := newCodexProjection(1)
	key := p.partKey("s", "t", "i", "agent_text")
	var snapshots []string
	previous := ""
	fragment := json.RawMessage(`{"threadId":"s","turnId":"t","itemId":"i","delta":"猫"}`)
	for i := 1; i <= 256; i++ {
		events := p.projectTextDelta("item/agentMessage/delta", "agent_text", fragment)
		event := events[len(events)-1]
		text := strings.Repeat("猫", i)
		expected := p.key("part", digest([]byte(key)), fmt.Sprint(i), digest([]byte(text)))
		if event.EventID != expected || event.PreviousEventID != previous || event.Snapshot != text {
			t.Fatalf("incorrect event at revision %d", i)
		}
		previous = event.EventID
		snapshots = append(snapshots, event.Snapshot)
	}
	final := p.finalText("s", "t", "i", "agent_text", "纠正")
	if final.PreviousEventID != previous {
		t.Fatal("correction lost predecessor")
	}
	after := p.projectTextDelta("item/agentMessage/delta", "agent_text", fragment)
	got := after[len(after)-1]
	if got.EventID != p.key("part", digest([]byte(key)), "258", digest([]byte("纠正猫"))) || got.PreviousEventID != final.EventID {
		t.Fatal("delta following authoritative correction used stale content")
	}
	for i, snapshot := range snapshots {
		if snapshot != strings.Repeat("猫", i+1) {
			t.Fatal("previously published snapshot changed")
		}
	}
}

func BenchmarkCodexLongTextDeltas(b *testing.B) {
	fragment := json.RawMessage(`{"threadId":"s","turnId":"t","itemId":"i","delta":"猫"}`)
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		p := newCodexProjection(1)
		for range 4096 {
			p.projectTextDelta("item/agentMessage/delta", "agent_text", fragment)
		}
	}
}

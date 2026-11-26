package ws

import (
	"testing"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

func BenchmarkLogicalTinyTextFrames(b *testing.B) {
	c := &Client{maxChunkBytes: 64 << 10, maxEventBytes: 128 << 10, outboundStreams: make(map[string]outboundContentStream)}
	event := protocol.DaemonEvent{Type: "agent_text", SessionID: "session", StreamID: "stream", Text: "猫", EventID: "event"}
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		if _, err := c.prepareLogicalStream(event, int64(i+1)); err != nil {
			b.Fatal(err)
		}
	}
}

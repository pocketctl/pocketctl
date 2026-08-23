package ws

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

func TestStreamTransportChunksUTF8BeforeSpool(t *testing.T) {
	const (
		maxEventBytes = 1 << 20
		maxChunkBytes = 64 << 10
	)
	c := newTestClient("ws://example")
	spoolPath := filepath.Join(t.TempDir(), "stream.log")
	if err := c.InitSpool(spoolPath); err != nil {
		t.Fatal(err)
	}
	defer c.spool.Close()
	c.onRegisterAck(protocol.RegisterAckMessage{
		SupportsEventAck: true,
		Capabilities:     []string{"tool_output_stream_v1"},
		MaxEventBytes:    maxEventBytes,
		MaxChunkBytes:    maxChunkBytes,
	})

	// Mirrors the production failure shape: content just over 1 MiB after JSON
	// encoding, including multi-byte UTF-8 and escaped newlines.
	output := strings.Repeat("你\n", 300_000)
	if ok := c.sendEventUntil(protocol.DaemonEvent{
		Type: "tool_result", SessionID: "session-1", CallID: "call-1",
		EventID: "source-event-1", Output: output,
	}, nil); !ok {
		t.Fatal("streamable event was not durably accepted")
	}

	persisted, err := loadSpool(spoolPath)
	if err != nil {
		t.Fatal(err)
	}
	if len(persisted) < 2 {
		t.Fatalf("oversized output remained one spool record: %d", len(persisted))
	}
	var rebuilt strings.Builder
	streamID := ""
	offset := 0
	for index, record := range persisted {
		if len(record.data) > maxEventBytes {
			t.Fatalf("frame %d has %d bytes, max %d", index, len(record.data), maxEventBytes)
		}
		var chunk protocol.DaemonEvent
		if err := json.Unmarshal(record.data, &chunk); err != nil {
			t.Fatal(err)
		}
		if chunk.Type != "tool_result" || chunk.StreamID == "" ||
			chunk.ChunkSeq == nil || *chunk.ChunkSeq != index ||
			chunk.ByteOffset == nil || *chunk.ByteOffset != offset {
			t.Fatalf("chunk %d metadata=%+v", index, chunk)
		}
		if len([]byte(chunk.Output)) > maxChunkBytes {
			t.Fatalf("chunk %d content=%d bytes, max %d", index, len([]byte(chunk.Output)), maxChunkBytes)
		}
		if streamID == "" {
			streamID = chunk.StreamID
		} else if chunk.StreamID != streamID {
			t.Fatalf("chunk %d stream=%q want %q", index, chunk.StreamID, streamID)
		}
		if index < len(persisted)-1 && (chunk.Final || chunk.EventID != "") {
			t.Fatalf("non-final chunk %d leaked completion metadata: %+v", index, chunk)
		}
		offset += len([]byte(chunk.Output))
		rebuilt.WriteString(chunk.Output)
	}
	var final protocol.DaemonEvent
	if err := json.Unmarshal(persisted[len(persisted)-1].data, &final); err != nil {
		t.Fatal(err)
	}
	if !final.Final || final.TotalBytes != len([]byte(output)) ||
		final.ContentHash == "" || final.EventID != "source-event-1" {
		t.Fatalf("final chunk=%+v", final)
	}
	if rebuilt.String() != output {
		t.Fatal("UTF-8 content changed during transport chunking")
	}
}

func TestAgentFileChangeContentStreamChunksDiffBeforeSpool(t *testing.T) {
	const (
		maxEventBytes = 1 << 20
		maxChunkBytes = 64 << 10
	)
	c := newTestClient("ws://example")
	spoolPath := filepath.Join(t.TempDir(), "file-change-stream.log")
	if err := c.InitSpool(spoolPath); err != nil {
		t.Fatal(err)
	}
	defer c.spool.Close()
	c.onRegisterAck(protocol.RegisterAckMessage{
		SupportsEventAck: true,
		Capabilities:     []string{"tool_output_stream_v1"},
		MaxEventBytes:    maxEventBytes,
		MaxChunkBytes:    maxChunkBytes,
	})

	diff := strings.Repeat("+large line\n", 120_000)
	if ok := c.sendEventUntil(protocol.DaemonEvent{
		Type: "agent_file_change", SessionID: "ses_1", TurnID: "turn_1",
		ChangeSetID: "native:call_1", CallID: "call_1", EventID: "file-event-1",
		Path: "large.go", ChangeKind: protocol.FileChangeUpdate,
		Diff: diff, Additions: 120_000, Deletions: 17,
		ChangeIndex: 0, ChangeTotal: 1, Status: "completed", Final: true,
	}, nil); !ok {
		t.Fatal("streamable file change was not durably accepted")
	}

	persisted, err := loadSpool(spoolPath)
	if err != nil {
		t.Fatal(err)
	}
	if len(persisted) < 2 {
		t.Fatalf("oversized diff remained one spool record: %d", len(persisted))
	}
	var rebuilt strings.Builder
	streamID := ""
	offset := 0
	for index, record := range persisted {
		if len(record.data) > maxEventBytes {
			t.Fatalf("frame %d has %d bytes, max %d", index, len(record.data), maxEventBytes)
		}
		var chunk protocol.DaemonEvent
		if err := json.Unmarshal(record.data, &chunk); err != nil {
			t.Fatal(err)
		}
		if chunk.Type != "agent_file_change" || chunk.SessionID != "ses_1" ||
			chunk.TurnID != "turn_1" || chunk.ChangeSetID != "native:call_1" ||
			chunk.CallID != "call_1" || chunk.Path != "large.go" ||
			chunk.ChangeKind != protocol.FileChangeUpdate || chunk.Additions != 120_000 ||
			chunk.Deletions != 17 || chunk.ChangeIndex != 0 || chunk.ChangeTotal != 1 ||
			chunk.Status != "completed" || chunk.StreamID == "" ||
			chunk.ChunkSeq == nil || *chunk.ChunkSeq != index ||
			chunk.ByteOffset == nil || *chunk.ByteOffset != offset {
			t.Fatalf("chunk %d metadata=%+v", index, chunk)
		}
		if len([]byte(chunk.Diff)) > maxChunkBytes {
			t.Fatalf("chunk %d content=%d bytes, max %d", index, len([]byte(chunk.Diff)), maxChunkBytes)
		}
		if streamID == "" {
			streamID = chunk.StreamID
		} else if chunk.StreamID != streamID {
			t.Fatalf("chunk %d stream=%q want %q", index, chunk.StreamID, streamID)
		}
		if index < len(persisted)-1 &&
			(chunk.Final || chunk.EventID != "" || chunk.ContentHash != "" || chunk.TotalBytes != 0) {
			t.Fatalf("non-final chunk %d leaked completion metadata: %+v", index, chunk)
		}
		offset += len([]byte(chunk.Diff))
		rebuilt.WriteString(chunk.Diff)
	}

	var final protocol.DaemonEvent
	if err := json.Unmarshal(persisted[len(persisted)-1].data, &final); err != nil {
		t.Fatal(err)
	}
	if !final.Final || final.TotalBytes != len([]byte(diff)) ||
		final.ContentHash == "" || final.EventID != "file-event-1" {
		t.Fatalf("final chunk=%+v", final)
	}
	if rebuilt.String() != diff {
		t.Fatal("file diff changed during transport chunking")
	}
}

func TestAgentFileChangeWithoutStreamCapabilityKeepsDiffAndClearsStreamMetadata(t *testing.T) {
	c := newTestClient("ws://example")
	c.onRegisterAck(protocol.RegisterAckMessage{SupportsEventAck: true})
	diff := "@@ -1 +1 @@\n-old\n+new\n"
	if ok := c.sendEventUntil(protocol.DaemonEvent{
		Type: "agent_file_change", SessionID: "ses_1", TurnID: "turn_1",
		ChangeSetID: "managed:patch_1", EventID: "file-event-1",
		Path: "a.go", ChangeKind: protocol.FileChangeUpdate, Diff: diff,
		StreamID: "file-stream-1", Streaming: true, Final: true,
		TotalBytes: len([]byte(diff)), ContentHash: "source-hash",
	}, nil); !ok {
		t.Fatal("legacy file change was not accepted")
	}
	if len(c.outBuf) != 1 {
		t.Fatalf("legacy relay unexpectedly received %d chunks", len(c.outBuf))
	}
	var got protocol.DaemonEvent
	if err := json.Unmarshal(c.outBuf[0].data, &got); err != nil {
		t.Fatal(err)
	}
	if got.Type != "agent_file_change" || got.Diff != diff || got.Path != "a.go" ||
		got.ChangeSetID != "managed:patch_1" || got.EventID != "file-event-1" ||
		got.StreamID != "" || got.Streaming || got.Final || got.TotalBytes != 0 ||
		got.ContentHash != "" || got.ChunkSeq != nil || got.ByteOffset != nil {
		t.Fatalf("legacy file change changed: %+v", got)
	}
}

func TestStreamTransportPreservesLegacySingleEventWithoutCapability(t *testing.T) {
	c := newTestClient("ws://example")
	c.onRegisterAck(protocol.RegisterAckMessage{SupportsEventAck: true})
	output := strings.Repeat("x", 2_000)

	if ok := c.sendEventUntil(protocol.DaemonEvent{
		Type: "tool_result", SessionID: "session-1", CallID: "call-1", Output: output,
	}, nil); !ok {
		t.Fatal("legacy event was not accepted")
	}
	if len(c.outBuf) != 1 {
		t.Fatalf("legacy relay unexpectedly received %d chunks", len(c.outBuf))
	}
	var got protocol.DaemonEvent
	if err := json.Unmarshal(c.outBuf[0].data, &got); err != nil {
		t.Fatal(err)
	}
	if got.Output != output || got.StreamID != "" {
		t.Fatalf("legacy event changed: %+v", got)
	}
}

func TestLegacyRelayReceivesAuthoritativeFinalWithoutStreamMetadata(t *testing.T) {
	c := newTestClient("ws://example")
	c.onRegisterAck(protocol.RegisterAckMessage{SupportsEventAck: true})
	streamID := "codex:stream:agent:item-1"
	if ok := c.sendEventUntil(protocol.DaemonEvent{
		Type: "agent_text", SessionID: "session-1", PartID: "item-1",
		Text: "Hel", Snapshot: "Hel", StreamID: streamID,
		Revision: 1, Streaming: true,
	}, nil); !ok {
		t.Fatal("legacy delta was not accepted")
	}
	if ok := c.sendEventUntil(protocol.DaemonEvent{
		Type: "agent_text", SessionID: "session-1", PartID: "item-1",
		Text: "Hello", Snapshot: "Hello", StreamID: streamID,
		Revision: 2, Replace: true, Streaming: true,
		Final: true, TotalBytes: 5, ContentHash: "hash",
	}, nil); !ok {
		t.Fatal("legacy final was not accepted")
	}

	var final protocol.DaemonEvent
	if err := json.Unmarshal(c.outBuf[1].data, &final); err != nil {
		t.Fatal(err)
	}
	if final.StreamID != "" || final.ChunkSeq != nil || final.ByteOffset != nil ||
		final.Final || final.TotalBytes != 0 || final.ContentHash != "" ||
		final.Streaming || final.Text != "Hello" || final.Snapshot != "Hello" ||
		!final.Replace {
		t.Fatalf("legacy final did not preserve authoritative semantics: %+v", final)
	}

	streamed := newTestClient("ws://example")
	streamed.onRegisterAck(protocol.RegisterAckMessage{
		SupportsEventAck: true,
		Capabilities:     []string{"tool_output_stream_v1"},
		MaxEventBytes:    512,
		MaxChunkBytes:    48,
	})
	for _, event := range []protocol.DaemonEvent{
		{
			Type: "agent_text", SessionID: "session-1", PartID: "item-1",
			Text: "Hel", Snapshot: "Hel", StreamID: streamID,
			Revision: 1, Streaming: true,
		},
		{
			Type: "agent_text", SessionID: "session-1", PartID: "item-1",
			Text: "Hello", Snapshot: "Hello", StreamID: streamID,
			Revision: 2, Replace: true, Streaming: true,
			Final: true, TotalBytes: 5, ContentHash: "hash",
		},
	} {
		if ok := streamed.sendEventUntil(event, nil); !ok {
			t.Fatal("negotiated logical stream was not accepted")
		}
	}
	if len(streamed.outBuf) != 2 {
		t.Fatalf("negotiated logical stream frames=%d want 2", len(streamed.outBuf))
	}
	var firstChunk, finalChunk protocol.DaemonEvent
	if err := json.Unmarshal(streamed.outBuf[0].data, &firstChunk); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(streamed.outBuf[1].data, &finalChunk); err != nil {
		t.Fatal(err)
	}
	if firstChunk.Text != "Hel" || finalChunk.Text != "lo" ||
		firstChunk.Snapshot != "" || finalChunk.Snapshot != "" ||
		firstChunk.ChunkSeq == nil || *firstChunk.ChunkSeq != 0 ||
		finalChunk.ChunkSeq == nil || *finalChunk.ChunkSeq != 1 ||
		finalChunk.ByteOffset == nil || *finalChunk.ByteOffset != 3 ||
		!finalChunk.Final {
		t.Fatalf("negotiated stream did not suppress repeated snapshots: first=%+v final=%+v",
			firstChunk, finalChunk)
	}
}

func TestNonStreamableOversizedEventBecomesDeliveryError(t *testing.T) {
	c := newTestClient("ws://example")
	spoolPath := filepath.Join(t.TempDir(), "delivery-error.log")
	if err := c.InitSpool(spoolPath); err != nil {
		t.Fatal(err)
	}
	defer c.spool.Close()
	c.onRegisterAck(protocol.RegisterAckMessage{
		SupportsEventAck: true,
		Capabilities:     []string{"tool_output_stream_v1"},
		MaxEventBytes:    320,
		MaxChunkBytes:    48,
	})
	metadata := json.RawMessage(`{"blob":"` + strings.Repeat("x", 2_000) + `"}`)

	if ok := c.sendEventUntil(protocol.DaemonEvent{
		Type: "session_meta", SessionID: "session-1",
		EventID: "source-meta-1", Metadata: metadata,
	}, nil); !ok {
		t.Fatal("delivery error replacement was not accepted")
	}
	persisted, err := loadSpool(spoolPath)
	if err != nil || len(persisted) != 1 {
		t.Fatalf("persisted=%+v err=%v", persisted, err)
	}
	if len(persisted[0].data) > 320 {
		t.Fatalf("delivery error has %d bytes, max 320", len(persisted[0].data))
	}
	var got protocol.DaemonEvent
	if err := json.Unmarshal(persisted[0].data, &got); err != nil {
		t.Fatal(err)
	}
	if got.Type != "event_delivery_error" || got.SessionID != "session-1" ||
		got.EventID != "source-meta-1" || got.OriginalType != "session_meta" ||
		got.OriginalBytes <= 320 || got.ContentHash == "" || !got.Truncated {
		t.Fatalf("delivery error=%+v", got)
	}
}

func TestRegisterAckRepairsRestoredOversizedSpoolAtSameSequence(t *testing.T) {
	spoolPath := filepath.Join(t.TempDir(), "restored-poison.log")
	seed, err := openSpool(spoolPath)
	if err != nil {
		t.Fatal(err)
	}
	oversized, _ := json.Marshal(protocol.DaemonEvent{
		Type: "tool_result", Seq: 7, SessionID: "session-1",
		EventID: "source-poison-7", CallID: "call-1",
		Output: strings.Repeat("x", 2_000),
	})
	normal, _ := json.Marshal(protocol.DaemonEvent{
		Type: "agent_text", Seq: 8, SessionID: "session-1", Text: "after",
	})
	seed.append(oversized)
	seed.append(normal)
	if err := seed.Close(); err != nil {
		t.Fatal(err)
	}

	c := newTestClient("ws://example")
	if err := c.InitSpool(spoolPath); err != nil {
		t.Fatal(err)
	}
	defer c.spool.Close()
	c.outMu.Lock()
	c.fatalFlowBlockedSeq = 7
	c.fatalFlowReason = "event_too_large"
	c.flowBackpressured = true
	c.outMu.Unlock()

	c.onRegisterAck(protocol.RegisterAckMessage{
		SupportsEventAck: true,
		Capabilities:     []string{"flow_control", "tool_output_stream_v1"},
		EventWindow:      8,
		MaxEventBytes:    400,
		MaxChunkBytes:    48,
	})

	c.outMu.Lock()
	if c.fatalFlowBlockedSeq != 0 || c.flowBackpressured {
		blocked, backpressured := c.fatalFlowBlockedSeq, c.flowBackpressured
		c.outMu.Unlock()
		t.Fatalf("repaired spool remained blocked: seq=%d backpressured=%v", blocked, backpressured)
	}
	if len(c.outBuf) != 2 || c.outBuf[0].seq != 7 || c.outBuf[1].seq != 8 {
		got := append([]bufferedEvent(nil), c.outBuf...)
		c.outMu.Unlock()
		t.Fatalf("repair changed sequence ordering: %+v", got)
	}
	repaired := append([]byte(nil), c.outBuf[0].data...)
	c.outMu.Unlock()
	if len(repaired) > 400 {
		t.Fatalf("repaired frame=%d bytes, max 400", len(repaired))
	}
	var diagnostic protocol.DaemonEvent
	if err := json.Unmarshal(repaired, &diagnostic); err != nil {
		t.Fatal(err)
	}
	if diagnostic.Type != "event_delivery_error" || diagnostic.Seq != 7 ||
		diagnostic.EventID != "source-poison-7" || diagnostic.OriginalBytes != len(oversized) {
		t.Fatalf("repair diagnostic=%+v", diagnostic)
	}
	persisted, err := loadSpool(spoolPath)
	if err != nil || len(persisted) != 2 || !bytes.Equal(persisted[0].data, repaired) {
		t.Fatalf("repaired spool=%+v err=%v", persisted, err)
	}
	quarantined, err := os.ReadFile(spoolPath + ".quarantine")
	if err != nil || !bytes.Contains(quarantined, oversized) {
		t.Fatalf("quarantine missing original frame: bytes=%d err=%v", len(quarantined), err)
	}
}

func TestEventTooLargeRepairsNegotiatedBufferedEvent(t *testing.T) {
	spoolPath := filepath.Join(t.TempDir(), "runtime-poison.log")
	c := newTestClient("ws://example")
	if err := c.InitSpool(spoolPath); err != nil {
		t.Fatal(err)
	}
	defer c.spool.Close()
	c.onRegisterAck(protocol.RegisterAckMessage{
		SupportsEventAck: true,
		Capabilities:     []string{"flow_control", "tool_output_stream_v1"},
		EventWindow:      8,
		MaxEventBytes:    4_096,
		MaxChunkBytes:    128,
	})
	seq, original, ok := c.appendOutbound(&protocol.DaemonEvent{
		Type: "tool_result", SessionID: "session-1",
		EventID: "source-runtime-1", Output: strings.Repeat("x", 2_000),
	})
	if !ok || seq != 1 {
		t.Fatalf("seed seq=%d ok=%v", seq, ok)
	}

	c.onFlowControl(protocol.FlowControlMessage{
		Type: "flow_control", Window: 1, Reason: "event_too_large", BlockedSeq: 1,
	})

	c.outMu.Lock()
	if c.fatalFlowBlockedSeq != 0 || c.flowBackpressured || len(c.outBuf) != 1 {
		blocked, backpressured, count := c.fatalFlowBlockedSeq, c.flowBackpressured, len(c.outBuf)
		c.outMu.Unlock()
		t.Fatalf("runtime repair state: blocked=%d backpressured=%v count=%d", blocked, backpressured, count)
	}
	repaired := append([]byte(nil), c.outBuf[0].data...)
	c.outMu.Unlock()
	if bytes.Equal(repaired, original) {
		t.Fatal("runtime poison frame was not replaced")
	}
	var diagnostic protocol.DaemonEvent
	if err := json.Unmarshal(repaired, &diagnostic); err != nil {
		t.Fatal(err)
	}
	if diagnostic.Type != "event_delivery_error" || diagnostic.Seq != 1 ||
		diagnostic.OriginalBytes != len(original) {
		t.Fatalf("runtime diagnostic=%+v", diagnostic)
	}
}

func TestOversizedAndRateLimitedClosesInstallReconnectFloor(t *testing.T) {
	for _, code := range []int{4003, 4029} {
		c := newTestClient("ws://example")
		c.fastReconnect.Store(true)
		c.handleWebSocketClose(&websocket.CloseError{Code: code, Text: "transport rejected"})
		if got := time.Duration(c.serverRetryAfter.Load()); got < 5*time.Second {
			t.Fatalf("close %d retry floor=%v, want at least 5s", code, got)
		}
		if c.fastReconnect.Load() {
			t.Fatalf("close %d retained fast reconnect mode", code)
		}
		if !c.reconnectStatusPending.Load() {
			t.Fatalf("close %d did not schedule reconnecting status", code)
		}
	}
}

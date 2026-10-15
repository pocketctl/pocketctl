package ws

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

func replayTestClient(t *testing.T, dir string, user int) *Client {
	t.Helper()
	c := newTestClient("ws://relay.test/ws")
	c.token = "e30." + base64.RawURLEncoding.EncodeToString([]byte(fmt.Sprintf(`{"userId":%d}`, user))) + ".signature"
	if err := c.InitReplayACKs(dir); err != nil {
		t.Fatal(err)
	}
	c.onRegisterAck(protocol.RegisterAckMessage{SupportsEventAck: true, Capabilities: []string{"tool_output_stream_v1"}, MaxEventBytes: 1 << 20, MaxChunkBytes: 64 << 10})
	return c
}
func replayFixture(generation int, content string) protocol.DaemonEvent {
	return protocol.DaemonEvent{Type: "tool_result", SessionID: "session", CallID: "cmd", EventID: fmt.Sprintf("codex:%d:command:session:turn:cmd:completed:hash", generation), StreamID: fmt.Sprintf("codex:%d:stream:tool_result:session:turn:cmd", generation), Output: content, Streaming: true, Final: true, TotalBytes: len(content)}
}

func TestReplayACKSkipsWholeLargeFactOnlyAfterCompleteACK(t *testing.T) {
	dir := t.TempDir()
	body := strings.Repeat("synthetic-output\n", 16000)
	first := replayTestClient(t, dir, 1)
	event := replayFixture(3, body)
	frames, ok := first.appendPreparedOutboundUntil(&event, nil)
	if !ok || len(frames) < 3 {
		t.Fatal("fixture did not span several chunks")
	}
	first.handleEventAck(protocol.EventAckMessage{UpToSeq: frames[len(frames)-2].seq})
	partialRestart := replayTestClient(t, dir, 1)
	replay := replayFixture(4, body)
	replay.Resync = true
	again, ok := partialRestart.appendPreparedOutboundUntil(&replay, nil)
	if !ok || len(again) < 3 {
		t.Fatal("partial ACK suppressed unacknowledged final snapshot")
	}
	var reconstructed strings.Builder
	for _, frame := range again {
		var ev protocol.DaemonEvent
		if err := json.Unmarshal(frame.data, &ev); err != nil {
			t.Fatal(err)
		}
		reconstructed.WriteString(ev.Output)
	}
	if reconstructed.String() != body {
		t.Fatal("restart lost prefix bytes")
	}
	first.handleEventAck(protocol.EventAckMessage{UpToSeq: frames[len(frames)-1].seq})
	restored := replayTestClient(t, dir, 1)
	beforeSeq := restored.seqCtr
	skipped, ok := restored.appendPreparedOutboundUntil(&replay, nil)
	if !ok || len(skipped) != 0 || restored.seqCtr != beforeSeq {
		t.Fatalf("acknowledged logical replay expanded into %d new physical frames", len(skipped))
	}
	// A new native fact and a live event still travel through ordinary transport.
	changed := replay
	changed.EventID += "-changed"
	changed.StreamID += "-changed"
	if frames, ok := restored.appendPreparedOutboundUntil(&changed, nil); !ok || len(frames) == 0 {
		t.Fatal("changed content fact suppressed")
	}
	live := replay
	live.Resync = false
	if frames, ok := restored.appendPreparedOutboundUntil(&live, nil); !ok || len(frames) == 0 {
		t.Fatal("live output suppressed")
	}
}

func TestReplayACKSeparatesAccountAndKeepsLegacyReplay(t *testing.T) {
	dir := t.TempDir()
	event := replayFixture(3, "synthetic")
	event.Resync = true
	c := replayTestClient(t, dir, 1)
	frames, _ := c.appendPreparedOutboundUntil(&event, nil)
	c.onRegisterAck(protocol.RegisterAckMessage{}) // legacy best-effort trim is not an ACK
	reopened := replayTestClient(t, dir, 1)
	if got, ok := reopened.appendPreparedOutboundUntil(&event, nil); !ok || len(got) == 0 {
		t.Fatal("legacy trimming advanced ACK cache")
	}
	reopened.handleEventAck(protocol.EventAckMessage{UpToSeq: frames[len(frames)-1].seq})
	same := replayTestClient(t, dir, 1)
	if got, _ := same.appendPreparedOutboundUntil(&event, nil); len(got) != 0 {
		t.Fatal("real ACK was not restored")
	}
	other := replayTestClient(t, dir, 2)
	if got, _ := other.appendPreparedOutboundUntil(&event, nil); len(got) == 0 {
		t.Fatal("account reused another account's ACKs")
	}
}

func TestReplayACKRestoredSpoolAdvancesOnlyOnRealACK(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "spool")
	event := replayFixture(3, "synthetic")
	first := replayTestClient(t, dir, 1)
	if err := first.InitSpool(path); err != nil {
		t.Fatal(err)
	}
	frames, _ := first.appendPreparedOutboundUntil(&event, nil)
	first.spool.Close()
	restored := replayTestClient(t, dir, 1)
	if err := restored.InitSpool(path); err != nil {
		t.Fatal(err)
	}
	defer restored.spool.Close()
	restored.handleEventAck(protocol.EventAckMessage{UpToSeq: frames[len(frames)-1].seq})
	next := replayTestClient(t, dir, 1)
	replay := replayFixture(4, "synthetic")
	replay.Resync = true
	if got, _ := next.appendPreparedOutboundUntil(&replay, nil); len(got) != 0 {
		t.Fatal("restored spool ACK did not suppress complete historical replay")
	}
}

func TestReplayACKJSONLIdentityIsPhysicalRecordNotText(t *testing.T) {
	dir := t.TempDir()
	first := replayTestClient(t, dir, 1)
	event := protocol.DaemonEvent{Type: "agent_text", SessionID: "session", Text: "same text", EventID: "jsonl:source:3:0", Resync: true}
	frames, _ := first.appendPreparedOutboundUntil(&event, nil)
	first.handleEventAck(protocol.EventAckMessage{UpToSeq: frames[0].seq})
	again, _ := first.appendPreparedOutboundUntil(&event, nil)
	if len(again) != 0 {
		t.Fatal("same physical history record replayed")
	}
	event.EventID = "jsonl:source:4:0"
	if different, _ := first.appendPreparedOutboundUntil(&event, nil); len(different) == 0 {
		t.Fatal("legitimate identical record was merged")
	}
}

func TestReplayACKDoesNotTreatQuarantineAsDeliveredFact(t *testing.T) {
	dir := t.TempDir()
	first := replayTestClient(t, dir, 1)
	first.maxOutCount = 1 // Force the negotiated transport to quarantine a multi-frame fact.
	event := replayFixture(3, strings.Repeat("large synthetic output", 10000))
	frames, ok := first.appendPreparedOutboundUntil(&event, nil)
	if !ok || len(frames) != 1 {
		t.Fatal("expected delivery error frame")
	}
	var wire protocol.DaemonEvent
	json.Unmarshal(frames[0].data, &wire)
	if wire.Type != "event_delivery_error" {
		t.Fatal("fixture was not quarantined")
	}
	first.handleEventAck(protocol.EventAckMessage{UpToSeq: frames[0].seq})
	restored := replayTestClient(t, dir, 1)
	event.Resync = true
	if got, ok := restored.appendPreparedOutboundUntil(&event, nil); !ok || len(got) < 2 {
		t.Fatal("delivery error ACK permanently suppressed source fact")
	}
}

func TestReplayACKExcludesProcessLocalDeltas(t *testing.T) {
	for _, id := range []string{"codex:3:part:hash:1:hash", "codex:3:command-output:thread:turn:item:hash", "codex:3:stream:agent_text:thread:turn:item", "codex:error:typed", "unrecognized"} {
		if key := replayFactKey(id); key != "" {
			t.Fatalf("process-local/foreign event was cached: %s", id)
		}
	}
	for _, kind := range []string{"user", "command", "file", "file-change", "tool", "compaction", "usage", "part:hash:final"} {
		first := replayFactKey("codex:3:" + kind + ":native-identity")
		second := replayFactKey("codex:4:" + kind + ":native-identity")
		if first == "" || first != second {
			t.Fatalf("same native fact cannot converge across runtime generation: %s", kind)
		}
		if first == replayFactKey("codex:4:"+kind+":different-identity") {
			t.Fatal("different facts collided")
		}
	}
}

func TestReplayACKScopeSurvivesTokenRotationButChangesWithDestination(t *testing.T) {
	dir := t.TempDir()
	first := replayTestClient(t, dir, 1)
	event := replayFixture(3, "synthetic")
	frames, _ := first.appendPreparedOutboundUntil(&event, nil)
	first.handleEventAck(protocol.EventAckMessage{UpToSeq: frames[0].seq})
	rotated := replayTestClient(t, dir, 1)
	rotated.token = "e30." + base64.RawURLEncoding.EncodeToString([]byte(`{"userId":1,"jti":"rotated","exp":42}`)) + ".signature"
	if err := rotated.InitReplayACKs(dir); err != nil {
		t.Fatal(err)
	}
	if !rotated.replayACKs.contains(event.EventID) {
		t.Fatal("routine refresh lost account's namespace")
	}
	rotated.relayURL = "ws://different-relay.test/ws"
	if err := rotated.InitReplayACKs(dir); err != nil {
		t.Fatal(err)
	}
	if rotated.replayACKs.contains(event.EventID) {
		t.Fatal("different Relay reused ACKs")
	}
}

func TestReplayACKRepairedPrefixCannotConfirmCompleteFact(t *testing.T) {
	dir := t.TempDir()
	first := replayTestClient(t, dir, 1)
	event := replayFixture(3, strings.Repeat("large synthetic output", 10000))
	frames, ok := first.appendPreparedOutboundUntil(&event, nil)
	if !ok || len(frames) < 3 {
		t.Fatal("expected multi-frame source")
	}
	first.outMu.Lock()
	repaired, err := first.repairBufferedEventsLocked(func(frame bufferedEvent) bool { return frame.seq == frames[0].seq })
	first.outMu.Unlock()
	if err != nil || len(repaired) != 1 {
		t.Fatalf("prefix repair failed: %v", err)
	}
	first.handleEventAck(protocol.EventAckMessage{UpToSeq: frames[len(frames)-1].seq})
	restored := replayTestClient(t, dir, 1)
	event.Resync = true
	if got, ok := restored.appendPreparedOutboundUntil(&event, nil); !ok || len(got) < 3 {
		t.Fatal("ACK of quarantined prefix plus final suppressed missing source bytes")
	}
}

func TestReplayACKPersistenceFailureReplaysNormally(t *testing.T) {
	c := replayTestClient(t, t.TempDir(), 1)
	c.replayACKs.path = filepath.Join(t.TempDir(), "missing-parent", "cache")
	event := replayFixture(3, "synthetic")
	frames, _ := c.appendPreparedOutboundUntil(&event, nil)
	c.handleEventAck(protocol.EventAckMessage{UpToSeq: frames[0].seq})
	if c.replayACKs.contains(event.EventID) {
		t.Fatal("failed persistence learned a positive cache entry")
	}
	event.Resync = true
	if again, ok := c.appendPreparedOutboundUntil(&event, nil); !ok || len(again) == 0 {
		t.Fatal("cache persistence error suppressed ordinary replay")
	}
}

func TestReplayACKJournalIsBoundedAndRecoversInterruptedTail(t *testing.T) {
	dir := t.TempDir()
	c := replayTestClient(t, dir, 1)
	id := "codex:3:command:session:turn:cmd:completed:hash"
	var journal strings.Builder
	for i := 0; i < replayACKLimit+10; i++ {
		fmt.Fprintf(&journal, "%064x\n", i)
	}
	journal.WriteString(replayFactKey(id) + "\ninterrupted-tail")
	if err := os.WriteFile(c.replayACKs.path, []byte(journal.String()), 0600); err != nil {
		t.Fatal(err)
	}
	restored := replayTestClient(t, dir, 1)
	if len(restored.replayACKs.keys) > replayACKLimit || !restored.replayACKs.contains(id) {
		t.Fatal("journal lost bounded known ACKs")
	}
	next := "codex:4:command:session:turn:other:completed:hash"
	if err := restored.replayACKs.record([]string{next}); err != nil {
		t.Fatal(err)
	}
	reread := replayTestClient(t, dir, 1)
	if !reread.replayACKs.contains(next) || !reread.replayACKs.contains(id) {
		t.Fatal("interrupted trailing record corrupted later ACKs")
	}
}

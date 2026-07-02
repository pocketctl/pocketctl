package ws

import (
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

// ev builds a buffered event whose wire bytes embed the seq, mirroring what
// appendOutbound writes to the spool.
func ev(seq int64, body string) bufferedEvent {
	data := []byte(fmt.Sprintf(`{"seq":%d,"type":"agent_text","text":%q}`, seq, body))
	return bufferedEvent{seq: seq, data: data}
}

func quietLogger() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

func TestSpoolAppendAndLoad(t *testing.T) {
	path := filepath.Join(t.TempDir(), "d.log")
	s, err := openSpool(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close() // release handle so t.TempDir cleanup works on Windows
	s.append(ev(1, "a").data)
	s.append(ev(2, "b").data)

	got, err := loadSpool(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].seq != 1 || got[1].seq != 2 {
		t.Fatalf("round-trip mismatch: %+v", got)
	}
}

func TestSpoolRewriteShrinksAndReopens(t *testing.T) {
	path := filepath.Join(t.TempDir(), "d.log")
	s, _ := openSpool(path)
	defer s.Close() // release handle so t.TempDir cleanup works on Windows
	s.append(ev(1, "a").data)
	s.append(ev(2, "b").data)
	s.append(ev(3, "c").data)

	// Ack 1 & 2 → only seq 3 remains durable.
	s.rewrite([]bufferedEvent{ev(3, "c")})
	got, _ := loadSpool(path)
	if len(got) != 1 || got[0].seq != 3 {
		t.Fatalf("after rewrite want [3], got %+v", got)
	}

	// Appends must still work after rewrite reopened the append handle.
	s.append(ev(4, "d").data)
	got, _ = loadSpool(path)
	if len(got) != 2 || got[1].seq != 4 {
		t.Fatalf("after post-rewrite append want [3,4], got %+v", got)
	}
}

func TestSpoolLoadSkipsCorruptTail(t *testing.T) {
	path := filepath.Join(t.TempDir(), "d.log")
	// A clean record followed by a truncated one (crash mid-append).
	content := string(ev(1, "a").data) + "\n" + `{"seq":2,"type":"agent_te`
	if err := os.WriteFile(path, []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
	got, _ := loadSpool(path)
	if len(got) != 1 || got[0].seq != 1 {
		t.Fatalf("corrupt tail should be skipped, got %+v", got)
	}
}

func TestLoadSpoolMissingFileIsEmpty(t *testing.T) {
	got, err := loadSpool(filepath.Join(t.TempDir(), "does-not-exist.log"))
	if err != nil || got != nil {
		t.Fatalf("missing file should be (nil,nil), got %+v err=%v", got, err)
	}
}

func TestInitSpoolRestoresBufferAndResumesSeq(t *testing.T) {
	path := filepath.Join(t.TempDir(), "d.log")
	// Pre-seed as if a prior process crashed with two unacked events.
	seed, _ := openSpool(path)
	seed.append(ev(5, "a").data)
	seed.append(ev(6, "b").data)
	seed.Close() // release seed handle before InitSpool reopens the same file

	c := NewClient("", "", "daemon-x", nil, nil, nil, nil, quietLogger())
	if err := c.InitSpool(path); err != nil {
		t.Fatal(err)
	}
	defer c.spool.Close() // release handle so t.TempDir cleanup works on Windows
	if len(c.outBuf) != 2 {
		t.Fatalf("want 2 restored events, got %d", len(c.outBuf))
	}
	if c.seqCtr != 6 {
		t.Fatalf("seqCtr should resume at 6, got %d", c.seqCtr)
	}
	if c.outBytes == 0 {
		t.Fatal("outBytes not accumulated from restored events")
	}

	// A fresh enqueue must continue past the restored seqs (no collision).
	seq, _, ok := c.appendOutbound(&protocol.DaemonEvent{Type: "agent_text"})
	if !ok || seq != 7 {
		t.Fatalf("next seq want 7, got %d (ok=%v)", seq, ok)
	}

	// And that new event is now durable too.
	got, _ := loadSpool(path)
	if len(got) != 3 || got[2].seq != 7 {
		t.Fatalf("spool should hold restored+new = [5,6,7], got %+v", got)
	}
}

// TestCapRestoredSpoolDropsOldest verifies that a spool holding more events
// than the restore cap is trimmed to the newest tail (oldest dropped), and that
// a small spool is returned unchanged. This guards against a reconnect storm
// re-arming itself on the next start from a huge accumulated spool.
func TestCapRestoredSpoolDropsOldest(t *testing.T) {
	// Build 250 events (seq 1..250), exceeding spoolRestoreMaxCount (200).
	var events []bufferedEvent
	for i := int64(1); i <= 250; i++ {
		events = append(events, ev(i, "x"))
	}
	got := capRestoredSpool(events)
	// Expect the newest 200 kept (seq 51..250), oldest 50 dropped.
	if len(got) != 200 {
		t.Fatalf("want 200 kept, got %d", len(got))
	}
	if got[0].seq != 51 {
		t.Fatalf("oldest kept want seq 51, got %d", got[0].seq)
	}
	if got[199].seq != 250 {
		t.Fatalf("newest kept want seq 250, got %d", got[199].seq)
	}

	// A small spool (under both caps) is returned unchanged.
	small := []bufferedEvent{ev(1, "a"), ev(2, "b")}
	gotSmall := capRestoredSpool(small)
	if len(gotSmall) != 2 || gotSmall[0].seq != 1 || gotSmall[1].seq != 2 {
		t.Fatalf("small spool should be unchanged, got %+v", gotSmall)
	}
}

// TestInitSpoolTrimsOversizedRestore verifies InitSpool persists the cap trim:
// after restoring from an oversized spool, the on-disk file is rewritten to
// match the trimmed in-memory buffer (so a crash right after start doesn't
// reload the full set again).
func TestInitSpoolTrimsOversizedRestore(t *testing.T) {
	path := filepath.Join(t.TempDir(), "d.log")
	seed, _ := openSpool(path)
	// Write 210 events — exceeds the 200 cap.
	for i := int64(1); i <= 210; i++ {
		seed.append(ev(i, "x").data)
	}
	seed.Close()

	c := NewClient("", "", "daemon-x", nil, nil, nil, nil, quietLogger())
	if err := c.InitSpool(path); err != nil {
		t.Fatal(err)
	}
	defer c.spool.Close()

	if len(c.outBuf) != 200 {
		t.Fatalf("want 200 restored after trim, got %d", len(c.outBuf))
	}
	if c.outBuf[0].seq != 11 {
		t.Fatalf("oldest kept want seq 11, got %d", c.outBuf[0].seq)
	}

	// The on-disk spool must now hold only the trimmed set.
	reloaded, _ := loadSpool(path)
	if len(reloaded) != 200 || reloaded[0].seq != 11 {
		t.Fatalf("disk spool should match trimmed buffer, got %d events from seq %d",
			len(reloaded), func() int64 {
				if len(reloaded) > 0 {
					return reloaded[0].seq
				}
				return 0
			}())
	}
}

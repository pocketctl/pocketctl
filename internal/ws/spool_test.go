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

	c := NewClient("", "", "daemon-x", nil, nil, nil, nil, quietLogger())
	if err := c.InitSpool(path); err != nil {
		t.Fatal(err)
	}
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

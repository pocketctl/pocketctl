package update

import (
	"io"
	"os"
	"strings"
	"testing"
)

func captureProgress(t *testing.T, run func()) string {
	t.Helper()
	f, err := os.CreateTemp(t.TempDir(), "stderr")
	if err != nil {
		t.Fatal(err)
	}
	old := os.Stderr
	os.Stderr = f
	defer func() { os.Stderr = old; f.Close() }()
	run()
	data, err := os.ReadFile(f.Name())
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func TestProgressClearsShrinkingTerminalFrames(t *testing.T) {
	p := &progressBar{total: 20 * 1024 * 1024, width: 22, isTTY: true}
	out := captureProgress(t, func() {
		p.read = 1023 * 1024
		p.render()
		p.read = 1024 * 1024
		p.render()
	})
	frames := strings.Split(out, "\r")[1:]
	for _, frame := range frames {
		if !strings.Contains(frame, "\x1b[K") {
			t.Fatalf("terminal frame does not clear old tail: %q", frame)
		}
	}
}

func TestProgressCompletionNeverFabricatesDownloadedBytes(t *testing.T) {
	p := &progressBar{total: 1000, read: 160, width: 22, isTTY: true}
	out := captureProgress(t, p.Done)
	if strings.Contains(out, "100%") || !strings.Contains(out, "160 B") {
		t.Fatalf("partial transfer falsely reported complete: %q", out)
	}
}

func TestHumanBytes(t *testing.T) {
	cases := []struct {
		in   int64
		want string
	}{
		{0, "0 B"},
		{512, "512 B"},
		{1023, "1023 B"},
		{1024, "1.0 KB"},
		{1536, "1.5 KB"},
		{10_485_760, "10.0 MB"}, // 10 MiB
		{18_874_317, "18.0 MB"}, // ~18 MiB
		{1 << 30, "1.0 GB"},
	}
	for _, c := range cases {
		if got := humanBytes(c.in); got != c.want {
			t.Errorf("humanBytes(%d) = %q, want %q", c.in, got, c.want)
		}
	}
}

// progressBar accumulates bytes correctly and clamps past 100% without panicking.
func TestProgressBarAccumulatesAndClamps(t *testing.T) {
	p := newProgressBar(1000) // isTTY=false under `go test` (no char device on stderr)
	p.Add(300)
	if p.read != 300 {
		t.Fatalf("after Add(300): read=%d, want 300", p.read)
	}
	// Add over total should not panic and should clamp during render (read can
	// exceed, but render path tolerates it).
	p.Add(900)
	if p.read != 1200 {
		t.Fatalf("read=%d, want 1200", p.read)
	}
	// Done() prints a summary to stderr for non-TTY; ensure it returns cleanly.
	p.Done()
}

// progressReader forwards reads and drives the bar.
func TestProgressReaderDrivesBar(t *testing.T) {
	src := make([]byte, 2048)
	p := newProgressBar(int64(len(src)))
	pr := &progressReader{r: readerOf(src), bar: p}
	buf := make([]byte, 512)
	var total int
	for {
		n, err := pr.Read(buf)
		total += n
		if err != nil {
			break
		}
	}
	if total != len(src) {
		t.Errorf("read %d bytes, want %d", total, len(src))
	}
	if p.read != int64(len(src)) {
		t.Errorf("bar tracked %d bytes, want %d", p.read, len(src))
	}
}

type byteReader struct {
	data []byte
	pos  int
}

func (b *byteReader) Read(p []byte) (int, error) {
	if b.pos >= len(b.data) {
		return 0, io.EOF
	}
	n := copy(p, b.data[b.pos:])
	b.pos += n
	return n, nil
}

func readerOf(data []byte) *byteReader { return &byteReader{data: data} }

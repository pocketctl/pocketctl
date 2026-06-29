package update

import (
	"fmt"
	"io"
	"os"
	"strings"
	"time"
)

// progressBar renders an in-place percentage download bar to stderr.
//
// It only animates when stderr is a terminal (ModeCharDevice) — under a pipe
// or redirected output it stays silent during the transfer and prints a single
// final summary line on Done(), so logs aren't polluted with hundreds of \r
// frames. Updates are throttled (~12fps) to avoid flicker.
type progressBar struct {
	total   int64 // Content-Length; -1 if unknown (chunked) → bytes-only + spinner
	read    int64
	width   int
	isTTY   bool
	started bool
	last    time.Time
	spin    int
}

// newProgressBar builds a bar for the given total byte count (-1 = unknown).
func newProgressBar(total int64) *progressBar {
	isTTY := false
	if fi, err := os.Stderr.Stat(); err == nil {
		isTTY = fi.Mode()&os.ModeCharDevice != 0
	}
	return &progressBar{total: total, width: 22, isTTY: isTTY}
}

// Add advances the byte counter and redraws (throttled). Safe to call with n<=0.
func (p *progressBar) Add(n int) {
	if n <= 0 {
		return
	}
	p.read += int64(n)
	if !p.isTTY {
		return
	}
	now := time.Now()
	// Throttle redraws except at completion so the final 100% frame always shows.
	if p.started && p.read != p.total && now.Sub(p.last) < 80*time.Millisecond {
		return
	}
	p.last = now
	p.started = true
	p.render()
}

func (p *progressBar) render() {
	const label = "  ⬇️  " // "  ⬇️  "
	if p.total > 0 {
		frac := float64(p.read) / float64(p.total)
		if frac > 1 {
			frac = 1
		}
		filled := int(frac * float64(p.width))
		bar := strings.Repeat("█", filled) + strings.Repeat("░", p.width-filled)
		pct := int(frac * 100)
		fmt.Fprintf(os.Stderr, "\r%s[%s] %3d%%  %s / %s ", label, bar, pct, humanBytes(p.read), humanBytes(p.total))
		return
	}
	// Unknown total: pulsing spinner + running byte count (no percentage).
	spinners := []string{"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"}
	s := spinners[p.spin%len(spinners)]
	p.spin++
	fmt.Fprintf(os.Stderr, "\r%s%s %s ", label, s, humanBytes(p.read))
}

// Done finalizes the bar: on a TTY it snaps to 100% and prints a newline so the
// cursor lands on a fresh line; off a TTY it emits a one-line summary.
func (p *progressBar) Done() {
	if !p.isTTY {
		if p.total > 0 {
			fmt.Fprintf(os.Stderr, "  ⬇️  downloaded %s / %s\n", humanBytes(p.read), humanBytes(p.total))
		} else if p.read > 0 {
			fmt.Fprintf(os.Stderr, "  ⬇️  downloaded %s\n", humanBytes(p.read))
		}
		return
	}
	if p.total > 0 {
		p.read = p.total
		p.render()
	}
	fmt.Fprint(os.Stderr, "\n")
}

// progressReader wraps an io.Reader, forwarding every Read to a progressBar so
// io.Copy(dst, &progressReader{r: body, bar: bar}) drives a live download bar.
type progressReader struct {
	r   io.Reader
	bar *progressBar
}

func (pr *progressReader) Read(p []byte) (int, error) {
	n, err := pr.r.Read(p)
	if n > 0 {
		pr.bar.Add(n)
	}
	return n, err
}

// humanBytes formats a byte count as e.g. "10.8 MB" / "512 B".
func humanBytes(b int64) string {
	const unit = 1024.0
	if b < 1024 {
		return fmt.Sprintf("%d B", b)
	}
	div, exp := unit, 0
	for n := float64(b) / unit; n >= unit; n /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %cB", float64(b)/div, "KMGTPE"[exp])
}

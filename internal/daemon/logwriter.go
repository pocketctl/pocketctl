package daemon

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// RotatingLogWriter is an io.WriteCloser that writes to a per-day log file
// (<prefix>-YYYY-MM-DD.log) under a directory, switching to a new file when the
// calendar date changes. It is safe for concurrent use by multiple goroutines.
//
// The daemon uses it so logs live under ~/.pocketctl/logs split by date, which
// keeps each file bounded and makes "what happened on day X" easy to find. The
// rotation check runs on every Write, so a long-lived daemon that crosses
// midnight transparently begins a new day's file with no restart required.
type RotatingLogWriter struct {
	dir    string
	prefix string

	mu      sync.Mutex
	curDate string
	file    *os.File
}

// NewRotatingLogWriter creates the directory if needed, opens today's file, and
// returns a writer that rotates daily. The initial open error is returned so
// the caller can fail fast; later rotation errors degrade gracefully (see Write).
func NewRotatingLogWriter(dir, prefix string) (*RotatingLogWriter, error) {
	w := &RotatingLogWriter{dir: dir, prefix: prefix}
	w.mu.Lock()
	defer w.mu.Unlock()
	if err := w.rotateLocked(time.Now()); err != nil {
		return nil, err
	}
	return w, nil
}

func (w *RotatingLogWriter) pathFor(date string) string {
	return filepath.Join(w.dir, fmt.Sprintf("%s-%s.log", w.prefix, date))
}

// rotateLocked ensures w.file points at the file for now's date. Caller holds mu.
func (w *RotatingLogWriter) rotateLocked(now time.Time) error {
	date := now.Format("2006-01-02")
	if date == w.curDate && w.file != nil {
		return nil
	}
	if err := os.MkdirAll(w.dir, 0755); err != nil {
		return err
	}
	f, err := os.OpenFile(w.pathFor(date), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err != nil {
		return err
	}
	if w.file != nil {
		_ = w.file.Close()
	}
	w.file = f
	w.curDate = date
	return nil
}

// Write rotates if the date changed, then writes p to the current day's file.
// If rotation fails but a previous handle is still open, it keeps writing to it
// so logging degrades rather than breaks.
func (w *RotatingLogWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if err := w.rotateLocked(time.Now()); err != nil && w.file == nil {
		return 0, err
	}
	return w.file.Write(p)
}

// Close closes the currently open file.
func (w *RotatingLogWriter) Close() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.file == nil {
		return nil
	}
	err := w.file.Close()
	w.file = nil
	return err
}

// File returns the file currently open for writing, for OS-level fd duplication
// of raw runtime panic traces. The handle is valid until the next rotation.
func (w *RotatingLogWriter) File() *os.File {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.file
}

// CurrentPath returns the path of the file currently being written.
func (w *RotatingLogWriter) CurrentPath() string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.pathFor(w.curDate)
}

// LatestLogPath returns the path of the most recent dated daemon log file in
// LogDir, or "" if none exist. Because the date format (YYYY-MM-DD) sorts
// lexically in chronological order, the lexically-greatest matching name is the
// newest day.
func LatestLogPath() string {
	dir := LogDir()
	entries, err := os.ReadDir(dir)
	if err != nil {
		return ""
	}
	pattern := logPrefix + "-"
	var newest string
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasPrefix(name, pattern) || !strings.HasSuffix(name, ".log") {
			continue
		}
		if name > newest {
			newest = name
		}
	}
	if newest == "" {
		return ""
	}
	return filepath.Join(dir, newest)
}

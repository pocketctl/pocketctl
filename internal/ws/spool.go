package ws

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
)

// spool persists the daemon's unacked outbound events to a local file so a
// daemon *process* crash/restart doesn't lose them. The in-memory outBuf already
// gives at-least-once delivery across a relay reconnect, but it evaporates if the
// daemon process dies; the spool is its durable mirror.
//
// Layout: newline-delimited JSON — one buffered event per line (the exact bytes
// that go on the wire, which already embed the seq). Appends happen per enqueue
// (no fsync: a process crash leaves the OS page cache intact, which is all we
// need; we are not guarding against power loss). On trim the file is atomically
// rewritten with the remaining unacked events, so it can't grow unbounded.
//
// All spool methods are nil-safe: when spooling is disabled (c.spool == nil) the
// client degrades to the previous in-memory-only behaviour.
type spool struct {
	mu   sync.Mutex
	path string
	f    *os.File
}

// openSpool opens (creating parent dirs + file) the append handle for path.
func openSpool(path string) (*spool, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		return nil, err
	}
	return &spool{path: path, f: f}, nil
}

// append writes one event's wire bytes as a line. Best-effort: I/O errors are
// swallowed (the in-memory buffer remains the source of truth this session).
func (s *spool) append(data []byte) {
	if s == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.f == nil {
		return
	}
	_, _ = s.f.Write(data)
	_, _ = s.f.Write([]byte{'\n'})
}

// quarantine preserves an original frame before the ordered spool replaces it
// with a bounded diagnostic event. The append-only sidecar is deliberately not
// replayed; it exists for local diagnosis and manual recovery only.
func (s *spool) quarantine(data []byte) error {
	if s == nil {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	qf, err := os.OpenFile(s.path+".quarantine", os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		return err
	}
	if _, err = qf.Write(data); err == nil {
		_, err = qf.Write([]byte{'\n'})
	}
	if closeErr := qf.Close(); err == nil {
		err = closeErr
	}
	return err
}

// rewrite atomically replaces the spool file with exactly the given (remaining
// unacked) events. Called from trimOutbound after acked events are dropped.
func (s *spool) rewrite(events []bufferedEvent) {
	if s == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	_ = s.rewriteLocked(events, false)
}

// quarantineAndRewrite preserves rejected originals, then atomically replaces
// the replay spool with their same-sequence bounded diagnostics.
func (s *spool) quarantineAndRewrite(originals [][]byte, events []bufferedEvent) error {
	if s == nil {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	qf, err := os.OpenFile(s.path+".quarantine", os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		return err
	}
	for _, original := range originals {
		if _, err = qf.Write(original); err != nil {
			break
		}
		if _, err = qf.Write([]byte{'\n'}); err != nil {
			break
		}
	}
	if err == nil {
		err = qf.Sync()
	}
	if closeErr := qf.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	return s.rewriteLocked(events, true)
}

func (s *spool) rewriteLocked(events []bufferedEvent, syncBeforeRename bool) error {
	tmp := s.path + ".tmp"
	tf, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0600)
	if err != nil {
		return err
	}
	for _, be := range events {
		if _, err = tf.Write(be.data); err != nil {
			break
		}
		if _, err = tf.Write([]byte{'\n'}); err != nil {
			break
		}
	}
	if err == nil && syncBeforeRename {
		err = tf.Sync()
	}
	if closeErr := tf.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if s.f != nil {
		_ = s.f.Close()
	}
	if err := os.Rename(tmp, s.path); err != nil {
		_ = os.Remove(tmp)
		if nf, openErr := os.OpenFile(s.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600); openErr == nil {
			s.f = nf
		} else {
			s.f = nil
		}
		return err
	}
	if nf, err := os.OpenFile(s.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600); err == nil {
		s.f = nf
	} else {
		s.f = nil
	}
	return nil
}

// Close releases the spool's append handle. Nil-safe (matches append/rewrite).
// PR5: added so callers can release the file handle — required on Windows where
// an open handle blocks file deletion (TempDir cleanup). Was a prod gap found
// during C+D test-debt cleanup.
func (s *spool) Close() error {
	if s == nil {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.f == nil {
		return nil
	}
	err := s.f.Close()
	s.f = nil
	return err
}

// loadSpool reads any previously-spooled unacked events from path, in seq order.
// Unparseable lines (e.g. a partial final record from a crash mid-append) are
// skipped. A missing file is not an error.
func loadSpool(path string) ([]bufferedEvent, error) {
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var out []bufferedEvent
	for _, line := range bytes.Split(raw, []byte{'\n'}) {
		if len(bytes.TrimSpace(line)) == 0 {
			continue
		}
		var probe struct {
			Seq int64 `json:"seq"`
		}
		if json.Unmarshal(line, &probe) != nil || probe.Seq <= 0 {
			continue
		}
		cp := make([]byte, len(line)) // bytes.Split aliases the backing array
		copy(cp, line)
		out = append(out, bufferedEvent{seq: probe.Seq, data: cp})
	}
	return out, nil
}

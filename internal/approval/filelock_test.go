package approval

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/filelock"
)

// shortSockDir returns a temp directory under /tmp whose path is short enough
// for macOS's ~104-char Unix socket path limit (t.TempDir lives deep under
// /var/folders and can exceed it).
func shortSockDir(t *testing.T) string {
	t.Helper()
	d, err := os.MkdirTemp("/tmp", "pcfl")
	if err != nil {
		t.Fatalf("mkdtemp: %v", err)
	}
	t.Cleanup(func() { os.RemoveAll(d) })
	return d
}

func sockFor(t *testing.T, name string) string {
	return filepath.Join(shortSockDir(t), fmt.Sprintf("%s.sock", name))
}

// dialServer opens a connection, sends one JSON line, reads one response line.
func dialServer(t *testing.T, sockPath string, req hookRequest) hookResponse {
	t.Helper()
	conn, err := net.DialTimeout("unix", sockPath, 2*time.Second)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()

	body, _ := json.Marshal(req)
	body = append(body, '\n')
	_ = conn.SetWriteDeadline(time.Now().Add(2 * time.Second))
	if _, err := conn.Write(body); err != nil {
		t.Fatalf("write: %v", err)
	}

	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	reader := bufio.NewReader(conn)
	line, err := reader.ReadBytes('\n')
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	var resp hookResponse
	if err := json.Unmarshal(line, &resp); err != nil {
		t.Fatalf("parse: %v", err)
	}
	return resp
}

// TestBypassLockConflict verifies that in bypassPermissions mode, a second
// session writing the same file is denied due to the file lock held by the
// first session.
func TestBypassLockConflict(t *testing.T) {
	dir := t.TempDir()
	sockPath := sockFor(t, "conflict")

	srv := NewServer(sockPath, nil)
	if err := srv.Start(); err != nil {
		t.Fatalf("start: %v", err)
	}
	defer srv.Close()

	fl := filelock.New()
	srv.SetFileLockManager(fl)

	// Session A locks the file via the bypass fast-path.
	input := json.RawMessage(`{"file_path":"main.go"}`)
	resp := dialServer(t, sockPath, hookRequest{
		SessionID: "sessA", Tool: "Write", Input: input, Cwd: dir, PermMode: "bypassPermissions",
	})
	if !resp.Allow {
		t.Fatalf("sessA bypass should succeed (no conflict): %+v", resp)
	}

	// Session B tries to write the same file → denied by lock conflict.
	resp = dialServer(t, sockPath, hookRequest{
		SessionID: "sessB", Tool: "Write", Input: input, Cwd: dir, PermMode: "bypassPermissions",
	})
	if resp.Allow {
		t.Fatal("sessB should be denied due to lock conflict")
	}
	if !resp.LockConflict {
		t.Error("resp.LockConflict should be true")
	}
	if resp.Reason == "" {
		t.Error("resp.Reason should explain the conflict")
	}

	// Session A can still write (lock holder).
	resp = dialServer(t, sockPath, hookRequest{
		SessionID: "sessA", Tool: "Write", Input: input, Cwd: dir, PermMode: "bypassPermissions",
	})
	if !resp.Allow {
		t.Fatal("sessA re-write should succeed (lock holder)")
	}
}

// TestBypassNoLockConflictForNonFileTools verifies bypass mode allows
// non-file tools without acquiring any lock.
func TestBypassNoLockConflictForNonFileTools(t *testing.T) {
	dir := t.TempDir()
	sockPath := sockFor(t, "nofile")

	srv := NewServer(sockPath, nil)
	if err := srv.Start(); err != nil {
		t.Fatalf("start: %v", err)
	}
	defer srv.Close()

	fl := filelock.New()
	srv.SetFileLockManager(fl)

	// Bash tool → no file path → bypass fast-path allow, no lock.
	resp := dialServer(t, sockPath, hookRequest{
		SessionID: "sessA", Tool: "Bash", Input: json.RawMessage(`{"command":"ls"}`), Cwd: dir, PermMode: "bypassPermissions",
	})
	if !resp.Allow {
		t.Fatal("Bash in bypass should be allowed (no lock check)")
	}
	if resp.LockConflict {
		t.Error("Bash should not set LockConflict")
	}
}

// TestBypassLockConflictAfterRelease verifies that after the holder releases,
// another session can acquire the lock.
func TestBypassLockConflictAfterRelease(t *testing.T) {
	dir := t.TempDir()
	sockPath := sockFor(t, "release")

	srv := NewServer(sockPath, nil)
	if err := srv.Start(); err != nil {
		t.Fatalf("start: %v", err)
	}
	defer srv.Close()

	fl := filelock.New()
	srv.SetFileLockManager(fl)

	input := json.RawMessage(`{"file_path":"app.go"}`)

	// A acquires.
	dialServer(t, sockPath, hookRequest{
		SessionID: "sessA", Tool: "Edit", Input: input, Cwd: dir, PermMode: "bypassPermissions",
	})

	// B conflicts.
	resp := dialServer(t, sockPath, hookRequest{
		SessionID: "sessB", Tool: "Edit", Input: input, Cwd: dir, PermMode: "bypassPermissions",
	})
	if resp.Allow {
		t.Fatal("B should conflict before release")
	}

	// A releases; B succeeds.
	fl.ReleaseAll("sessA")
	resp = dialServer(t, sockPath, hookRequest{
		SessionID: "sessB", Tool: "Edit", Input: input, Cwd: dir, PermMode: "bypassPermissions",
	})
	if !resp.Allow {
		t.Fatal("B should succeed after A releases the lock")
	}
}

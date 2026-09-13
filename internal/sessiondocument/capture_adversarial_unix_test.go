//go:build !windows

package sessiondocument

import (
	"io"
	"net"
	"os"
	"path/filepath"
	"testing"

	"github.com/pocketctl/pocketctl/internal/protocol"
	"golang.org/x/sys/unix"
)

func TestSecureOpenHandleDoesNotFollowAReplacementAfterOpen(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	target := filepath.Join(root, "report.md")
	if err := os.WriteFile(target, []byte("authorized snapshot"), 0o600); err != nil {
		t.Fatal(err)
	}
	outsideFile := filepath.Join(outside, "secret.md")
	if err := os.WriteFile(outsideFile, []byte("outside secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	file, err := secureOpenRegular(root, "report.md")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if err := os.Rename(target, filepath.Join(root, "old.md")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outsideFile, target); err != nil {
		t.Fatal(err)
	}
	bytes, err := io.ReadAll(file)
	if err != nil {
		t.Fatal(err)
	}
	if string(bytes) != "authorized snapshot" {
		t.Fatalf("opened handle followed replacement: %q", bytes)
	}
}

func TestCaptureRejectsFIFOsSocketsAndUnreadableFilesWithoutReadingBodies(t *testing.T) {
	root, err := os.MkdirTemp("/tmp", "pcd-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	if err := unix.Mkfifo(filepath.Join(root, "pipe.md"), 0o600); err != nil {
		t.Fatal(err)
	}
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: filepath.Join(root, "socket.md"), Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	if err := os.WriteFile(filepath.Join(root, "unreadable.md"), []byte("secret"), 0o000); err != nil {
		t.Fatal(err)
	}
	defer os.Chmod(filepath.Join(root, "unreadable.md"), 0o600)

	for _, name := range []string{"pipe.md", "socket.md", "unreadable.md"} {
		candidate := Candidate{
			SessionID: "session-1", TurnID: "turn-1", ChangeSetID: "changes-1",
			SourceEventID: "event-1", RelativePath: name, DisplayName: name,
			Format: protocol.SessionDocumentFormatMarkdown,
		}
		result := Capture(root, candidate, 100)
		if name == "unreadable.md" && os.Geteuid() == 0 {
			continue
		}
		if result.Reason == "" || len(result.Bytes) != 0 {
			t.Fatalf("%s captured as body: reason=%q bytes=%d", name, result.Reason, len(result.Bytes))
		}
	}
}

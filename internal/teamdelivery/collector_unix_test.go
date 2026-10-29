//go:build !windows

package teamdelivery

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/protocol"
	"golang.org/x/sys/unix"
)

func TestCollectRejectsSymlinksAndFIFO(t *testing.T) {
	for _, kind := range []string{"file", "directory", "manifest", "fifo"} {
		t.Run(kind, func(t *testing.T) {
			root := fixtureWorkspace(t)
			dir := filepath.Join(root, protocol.TeamDeliveryDirectory("call-1"))
			file := filepath.Join(dir, "report.pdf")
			target := filepath.Join(t.TempDir(), "private.pdf")
			if err := os.WriteFile(target, []byte("private"), 0600); err != nil {
				t.Fatal(err)
			}
			switch kind {
			case "file", "fifo":
				if err := os.Remove(file); err != nil {
					t.Fatal(err)
				}
				if kind == "fifo" {
					if err := unix.Mkfifo(file, 0600); err != nil {
						t.Fatal(err)
					}
				} else if err := os.Symlink(target, file); err != nil {
					t.Fatal(err)
				}
			case "directory":
				moved := dir + "-moved"
				if err := os.Rename(dir, moved); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(moved, dir); err != nil {
					t.Fatal(err)
				}
			case "manifest":
				file = filepath.Join(dir, "submission.json")
				if err := os.Rename(file, file+"-moved"); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(file+"-moved", file); err != nil {
					t.Fatal(err)
				}
			}
			result := make(chan error, 1)
			go func() { _, err := Collect(root, fixtureJob()); result <- err }()
			select {
			case err := <-result:
				if err == nil {
					t.Fatal("unsafe file accepted")
				}
			case <-time.After(2 * time.Second):
				t.Fatal("special file blocked collection")
			}
		})
	}
}

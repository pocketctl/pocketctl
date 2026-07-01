//go:build !windows

package platform

import (
	"io"
	"os/exec"
	"testing"
)

func TestPTYProvider_StartReadWrite(t *testing.T) {
	cmd := exec.Command("cat") // PTY 内回显 stdin
	p := NewPTYProvider()
	pty, err := p.Start(cmd, &Size{Rows: 24, Cols: 80})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer pty.Close()

	if _, err := pty.Write([]byte("hi\n")); err != nil {
		t.Fatalf("Write: %v", err)
	}
	buf := make([]byte, 64)
	n, err := pty.Read(buf)
	if err != nil && err != io.EOF {
		t.Fatalf("Read: %v", err)
	}
	if n == 0 {
		t.Fatal("Read returned no data (PTY echo expected)")
	}
}

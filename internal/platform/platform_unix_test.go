//go:build !windows

package platform

import (
	"io"
	"net"
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

func TestIPCListener_ListenAccept(t *testing.T) {
	dir := t.TempDir()
	path := dir + "/test.sock"
	l := NewIPCListener()

	ln, err := l.Listen(path)
	if err != nil {
		t.Fatalf("Listen: %v", err)
	}
	defer ln.Close()

	done := make(chan error, 1)
	go func() {
		c, err := net.Dial("unix", path)
		if err != nil {
			done <- err
			return
		}
		c.Close()
		done <- nil
	}()
	conn, err := ln.Accept()
	if err != nil {
		t.Fatalf("Accept: %v", err)
	}
	conn.Close()
	if err := <-done; err != nil {
		t.Fatalf("Dial: %v", err)
	}
}

func TestIPCListener_DefaultPath(t *testing.T) {
	l := NewIPCListener()
	p := l.DefaultPath("approval")
	if p == "" {
		t.Fatal("DefaultPath returned empty")
	}
}

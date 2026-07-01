//go:build !windows

package platform

import (
	"io"
	"net"
	"os"
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

func TestInstanceLocker_Exclusion(t *testing.T) {
	dir := t.TempDir()
	path := dir + "/test.lock"
	locker := NewInstanceLocker()

	l1, err := locker.Acquire(path)
	if err != nil {
		t.Fatalf("first Acquire: %v", err)
	}
	defer l1.Close()

	if _, err := locker.Acquire(path); err == nil {
		t.Fatal("second Acquire should fail (lock already held)")
	}
}

func TestProcessController_IsAlive(t *testing.T) {
	pc := NewProcessController()
	if !pc.IsAlive(os.Getpid()) {
		t.Fatal("current process should be alive")
	}
	// 999999 几乎不可能是真实 pid；仅作「不存在」判据。
	if pc.IsAlive(999999) {
		t.Fatal("pid 999999 should not be alive")
	}
}

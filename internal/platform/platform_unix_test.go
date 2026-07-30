//go:build !windows

package platform

import (
	"errors"
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
	} else if !errors.Is(err, ErrInstanceLockHeld) {
		t.Fatalf("second Acquire error=%v, want ErrInstanceLockHeld", err)
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
	for _, pid := range []int{0, -1} {
		if pc.IsAlive(pid) {
			t.Fatalf("invalid pid %d should not be alive", pid)
		}
	}
}

func TestProcessInspectorListsCurrentProcess(t *testing.T) {
	processes, err := NewProcessInspector().List()
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, process := range processes {
		if process.PID == os.Getpid() {
			found = true
			if len(process.Args) == 0 || process.CWD == "" {
				t.Fatalf("current process snapshot incomplete: %+v", process)
			}
		}
	}
	if !found {
		t.Fatal("current process missing from snapshot")
	}
}

func TestDaemonizer_ForkDetached(t *testing.T) {
	if _, err := os.Stat("/bin/sleep"); err != nil {
		t.Skip("/bin/sleep 不可用，跳过 detached 测试")
	}
	d := NewDaemonizer()
	proc, err := d.ForkDetached("/bin/sleep", []string{"2"}, os.Environ())
	if err != nil {
		t.Fatalf("ForkDetached: %v", err)
	}
	if proc.Pid <= 0 {
		t.Fatal("返回的 pid 无效")
	}
	// 清理：杀掉 detached sleep，避免泄漏。
	_ = proc.Kill()
}

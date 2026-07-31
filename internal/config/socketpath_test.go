package config

import (
	"path/filepath"
	"testing"
)

// controlSocketPathFor / approvalSocketPathFor 是路径计算的纯函数核心（可注入
// GOOS），让 Windows named-pipe 分支能在任意平台单测——否则 runtime.GOOS 编译期
// 固定，Windows 路径在 macOS 上无法覆盖。这两个 socket 的路径契约：
//   - Unix:   ~/.pocketctl/<name>.sock（user-global 文件，daemon 与 hook/CLI 共享）
//   - Windows: \\.\pipe\pocketctl-<name>（winio CreateNamedPipe 要求的 pipe 名）
// 之前无平台分支，Windows 上把文件路径喂给 winio.ListenPipe/DialPipe → 必然失败
// （这正是 keep-awake 与 approval server 在 Windows 报 "Incorrect function" 的根因）。

func TestControlSocketPathForWindowsIsNamedPipe(t *testing.T) {
	got := controlSocketPathFor("windows", `C:\Users\foo`)
	want := `\\.\pipe\pocketctl-control`
	if got != want {
		t.Errorf("windows control path = %q, want %q", got, want)
	}
}

func TestControlSocketPathForUnixIsFilePath(t *testing.T) {
	got := controlSocketPathFor("darwin", "/Users/foo")
	want := filepath.Join("/Users/foo", ".pocketctl", "control.sock")
	if got != want {
		t.Errorf("unix control path = %q, want %q", got, want)
	}
}

func TestAgentControlSocketPathForWindowsIsNamedPipe(t *testing.T) {
	got := agentControlSocketPathFor("windows", `C:\Users\foo`)
	want := `\\.\pipe\pocketctl-agent-control`
	if got != want {
		t.Errorf("windows agent control path = %q, want %q", got, want)
	}
}

func TestAgentControlSocketPathForUnixIsFilePath(t *testing.T) {
	got := agentControlSocketPathFor("linux", "/home/foo")
	want := filepath.Join("/home/foo", ".pocketctl", "agent-control.sock")
	if got != want {
		t.Errorf("unix agent control path = %q, want %q", got, want)
	}
}

func TestApprovalSocketPathForWindowsIsNamedPipe(t *testing.T) {
	got := approvalSocketPathFor("windows", `C:\Users\foo`)
	want := `\\.\pipe\pocketctl-approval`
	if got != want {
		t.Errorf("windows approval path = %q, want %q", got, want)
	}
}

func TestApprovalSocketPathForUnixIsFilePath(t *testing.T) {
	got := approvalSocketPathFor("darwin", "/Users/foo")
	want := filepath.Join("/Users/foo", ".pocketctl", "approval.sock")
	if got != want {
		t.Errorf("unix approval path = %q, want %q", got, want)
	}
}

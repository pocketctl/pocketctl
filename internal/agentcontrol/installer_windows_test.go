//go:build windows

package agentcontrol

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestOpenCodeInstallerWindowsWrapperRoundTrip(t *testing.T) {
	dir := t.TempDir()
	shim := filepath.Join(dir, "opencode.cmd")
	pocketctl := filepath.Join(dir, "Pocketctl Program", "pocketctl.exe")

	if err := installPlatformShim(shim, pocketctl, AgentOpenCode); err != nil {
		t.Fatal(err)
	}
	want := windowsShimMarker + "-v3\r\n" +
		"@setlocal\r\n" +
		"@if not \"%POCKETCTL_AGENT_LAUNCH_DEPTH%\"==\"\" goto fallback\r\n" +
		"@if not exist \"" + pocketctl + "\" goto fallback\r\n" +
		"@set \"POCKETCTL_AGENT_LAUNCH_DEPTH=1\"\r\n" +
		"@\"" + pocketctl + "\" __agent-launch opencode %*\r\n" +
		"@endlocal & exit /b %errorlevel%\r\n" +
		":fallback\r\n" +
		"@set \"POCKETCTL_AGENT_LAUNCH_DEPTH=\"\r\n" +
		"@set \"POCKETCTL_AGENT_REAL_BINARY=\"\r\n" +
		"@exit /b 9009\r\n"
	data, err := os.ReadFile(shim)
	if err != nil || string(data) != want {
		t.Fatalf("wrapper=%q err=%v, want %q", data, err, want)
	}
	if err := installPlatformShim(shim, pocketctl, AgentOpenCode); err != nil {
		t.Fatalf("idempotent wrapper install: %v", err)
	}
	if err := removePlatformShim(shim, pocketctl); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(shim); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("wrapper remains after disable: %v", err)
	}
}

func TestWindowsShimV3WrapperContract(t *testing.T) {
	dir := t.TempDir()
	shim := filepath.Join(dir, "claude.cmd")
	pocketctl := filepath.Join(dir, "pocketctl.exe")
	realBinary := filepath.Join(dir, "real-claude.exe")

	if err := installPlatformShim(shim, pocketctl, AgentClaudeCode, realBinary); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(shim)
	if err != nil {
		t.Fatal(err)
	}
	content := string(data)

	if count := strings.Count(content, launcherMarkerWindowsV3); count != 1 {
		t.Fatalf("v3 marker count=%d content=%q", count, content)
	}
	if strings.Contains(content, "@rem pocketctl-agent-launcher\r\n") {
		t.Fatalf("wrapper still emits legacy marker line: %q", content)
	}
	if !strings.Contains(content, "@setlocal") {
		t.Fatalf("wrapper must use setlocal: %q", content)
	}
	depthCheck := strings.Index(content, "POCKETCTL_AGENT_LAUNCH_DEPTH")
	pocketctlHop := strings.Index(content, "__agent-launch")
	if depthCheck < 0 || pocketctlHop < 0 || depthCheck > pocketctlHop {
		t.Fatalf("depth fuse must be checked before the PocketCtl hop: %q", content)
	}
	if !strings.Contains(content, "@set \"POCKETCTL_AGENT_LAUNCH_DEPTH=\"") || !strings.Contains(content, "@set \"POCKETCTL_AGENT_REAL_BINARY=\"") {
		t.Fatalf("wrapper must clear both internal env variables on fallback: %q", content)
	}
	if !strings.Contains(content, "@set \"POCKETCTL_AGENT_REAL_BINARY="+realBinary+"\"") {
		t.Fatalf("wrapper must record the real binary hint: %q", content)
	}
	if !strings.Contains(content, "__agent-launch claude-code %*") {
		t.Fatalf("wrapper must forward %%* to PocketCtl: %q", content)
	}
	if !strings.Contains(content, "@\""+realBinary+"\" %*") {
		t.Fatalf("wrapper must forward %%* to the real binary on fallback: %q", content)
	}
}

func TestOpenCodeInstallerWindowsWrapperRefusesForeignFile(t *testing.T) {
	shim := filepath.Join(t.TempDir(), "opencode.cmd")
	if err := os.WriteFile(shim, []byte("@echo foreign\r\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := installPlatformShim(shim, `C:\Pocketctl\pocketctl.exe`, AgentOpenCode); !errors.Is(err, ErrForeignShim) {
		t.Fatalf("install error=%v, want ErrForeignShim", err)
	}
	if err := removePlatformShim(shim, `C:\Pocketctl\pocketctl.exe`); !errors.Is(err, ErrForeignShim) {
		t.Fatalf("remove error=%v, want ErrForeignShim", err)
	}
	data, err := os.ReadFile(shim)
	if err != nil || string(data) != "@echo foreign\r\n" {
		t.Fatalf("foreign wrapper changed: %q err=%v", data, err)
	}
}

func TestCodexInstallerWindowsWrapperRoutesCodexAgent(t *testing.T) {
	dir := t.TempDir()
	shim := filepath.Join(dir, "codex.cmd")
	pocketctl := filepath.Join(dir, "pocketctl.exe")
	if err := installPlatformShim(shim, pocketctl, AgentCodex); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(shim)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), "__agent-launch codex %*") {
		t.Fatalf("wrapper does not route Codex: %q", data)
	}
}

func TestOpenCodeInstallerWindowsPathValueIsIdempotentAndReversible(t *testing.T) {
	original := `C:\Windows;C:\Tools`
	binDir := `C:\Users\Alice\.pocketctl\bin`
	added, changed := addWindowsPathEntry(original, binDir)
	if !changed || added != original+";"+binDir {
		t.Fatalf("added=%q changed=%v", added, changed)
	}
	if repeated, changed := addWindowsPathEntry(added, strings.ToLower(binDir)); changed || repeated != added {
		t.Fatalf("case-insensitive duplicate changed PATH: %q changed=%v", repeated, changed)
	}
	if removed := removeWindowsPathEntry(added, strings.ToUpper(binDir)); removed != original {
		t.Fatalf("removed=%q, want %q", removed, original)
	}
}

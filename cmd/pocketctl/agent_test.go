package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// withTempHome sets HOME to a fresh temp dir for the test, so zcode-sync.json
// lands in an isolated ~/.pocketctl.
func withTempHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	return home
}

// makeFakeZcodeStorage creates a storage dir containing db/db.sqlite so the
// enable probe succeeds.
func makeFakeZcodeStorage(t *testing.T) string {
	t.Helper()
	storage := t.TempDir()
	dbDir := filepath.Join(storage, "db")
	if err := os.MkdirAll(dbDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dbDir, "db.sqlite"), []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}
	return storage
}

func TestZcodeSyncHelpDoesNotInvokeLauncherManager(t *testing.T) {
	withTempHome(t)
	var stdout, stderr bytes.Buffer
	if err := runAgentCommand([]string{"zcode", "sync", "help"}, &stdout, &stderr, nil); err != nil {
		t.Fatalf("help err = %v", err)
	}
	if !strings.Contains(stdout.String(), "read-only") && !strings.Contains(stdout.String(), "只读") {
		t.Fatalf("help output missing read-only note:\n%s", stdout.String())
	}
}

func TestZcodeSyncEnableThenStatusRoundTrip(t *testing.T) {
	withTempHome(t)
	storage := makeFakeZcodeStorage(t)
	var stdout, stderr bytes.Buffer
	err := runAgentCommand([]string{
		"zcode", "sync", "enable",
		"--history", "recent", "--lookback-days", "7", "--storage-dir", storage,
	}, &stdout, &stderr, nil)
	if err != nil {
		t.Fatalf("enable err = %v (stderr=%s)", err, stderr.String())
	}
	out := stdout.String()
	if !strings.Contains(out, "restart") && !strings.Contains(out, "重启") {
		t.Fatalf("enable must prompt daemon restart:\n%s", out)
	}

	// status reflects enabled=true and resolved storage.
	var sOut, sErr bytes.Buffer
	if err := runAgentCommand([]string{"zcode", "sync", "status"}, &sOut, &sErr, nil); err != nil {
		t.Fatalf("status err = %v", err)
	}
	statusOut := sOut.String()
	for _, want := range []string{"recent", storage} {
		if !strings.Contains(statusOut, want) {
			t.Fatalf("status missing %q:\n%s", want, statusOut)
		}
	}
	// status must NOT print session content.
	if strings.Contains(strings.ToLower(statusOut), "title:") {
		t.Fatalf("status must not print session info:\n%s", statusOut)
	}
}

func TestZcodeSyncEnableFailsClosedWhenStorageMissing(t *testing.T) {
	withTempHome(t)
	missing := filepath.Join(t.TempDir(), "does-not-exist")
	var stdout, stderr bytes.Buffer
	err := runAgentCommand([]string{
		"zcode", "sync", "enable", "--storage-dir", missing,
	}, &stdout, &stderr, nil)
	if err == nil {
		t.Fatal("enable against missing storage must fail")
	}
	// Config must remain disabled.
	if cfgIsEnabled(t) {
		t.Fatal("enable against missing storage must not write enabled=true")
	}
}

func TestZcodeSyncEnableRejectsBadHistoryAndLookback(t *testing.T) {
	withTempHome(t)
	storage := makeFakeZcodeStorage(t)
	tests := []struct {
		name string
		args []string
	}{
		{"bad history", []string{"zcode", "sync", "enable", "--history", "yesterday", "--storage-dir", storage}},
		{"lookback zero", []string{"zcode", "sync", "enable", "--lookback-days", "0", "--storage-dir", storage}},
		{"lookback too large", []string{"zcode", "sync", "enable", "--lookback-days", "99999", "--storage-dir", storage}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var stdout, stderr bytes.Buffer
			if err := runAgentCommand(tt.args, &stdout, &stderr, nil); err == nil {
				t.Fatalf("expected error for %v", tt.args)
			}
		})
	}
}

func TestZcodeSyncDisableMessageAndKeepsDisabled(t *testing.T) {
	withTempHome(t)
	storage := makeFakeZcodeStorage(t)
	// Enable first.
	var eOut, eErr bytes.Buffer
	if err := runAgentCommand([]string{"zcode", "sync", "enable", "--storage-dir", storage}, &eOut, &eErr, nil); err != nil {
		t.Fatalf("enable err = %v", err)
	}
	// Disable.
	var dOut, dErr bytes.Buffer
	if err := runAgentCommand([]string{"zcode", "sync", "disable"}, &dOut, &dErr, nil); err != nil {
		t.Fatalf("disable err = %v", err)
	}
	disabledOut := dOut.String()
	// disable message must mention 5-second stop and NOT deleting remote.
	if !strings.Contains(disabledOut, "5") {
		t.Fatalf("disable must mention ~5 second stop:\n%s", disabledOut)
	}
	if !strings.Contains(disabledOut, "not ") && !strings.Contains(disabledOut, "不会被删除") && !strings.Contains(strings.ToLower(disabledOut), "not deleted") && !strings.Contains(disabledOut, "不删除") {
		t.Fatalf("disable must state remote content is not deleted:\n%s", disabledOut)
	}
	if cfgIsEnabled(t) {
		t.Fatal("config must be disabled after disable")
	}
}

func TestZcodeSyncDoesNotRouteThroughManagedAgentGate(t *testing.T) {
	withTempHome(t)
	// The opencode/codex gate rejects unknown agents. zcode must be dispatched
	// before it; verify no "unknown agent" error surfaces for zcode.
	var stdout, stderr bytes.Buffer
	err := runAgentCommand([]string{"zcode", "sync", "status"}, &stdout, &stderr, nil)
	if err != nil {
		t.Fatalf("zcode status should not error even with no config: %v", err)
	}
	if strings.Contains(stderr.String(), "unknown") && strings.Contains(stderr.String(), "zcode") {
		t.Fatalf("zcode routed through managed-agent gate: stderr=%s", stderr.String())
	}
}

// cfgIsEnabled reads the persisted config from HOME/.pocketctl/zcode-sync.json.
// It relies on HOME being set by withTempHome; because zcode.configHomeOverride
// is empty in cmd tests, zcode.LoadConfig uses config.ConfigDir() → HOME.
func cfgIsEnabled(t *testing.T) bool {
	t.Helper()
	home := os.Getenv("HOME")
	data, err := os.ReadFile(filepath.Join(home, ".pocketctl", "zcode-sync.json"))
	if err != nil {
		return false
	}
	return strings.Contains(string(data), `"enabled": true`)
}

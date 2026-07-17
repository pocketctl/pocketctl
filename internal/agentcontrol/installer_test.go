package agentcontrol

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestOpenCodeInstallerEnableDisableRoundTrip(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix symlink/profile behavior")
	}
	home := t.TempDir()
	t.Setenv("HOME", home)
	realBinary := testExecutable(t, "real-opencode")
	pocketctlBinary := testExecutable(t, "pocketctl")
	now := time.Unix(1234, 0).UTC()
	installer := Installer{
		PocketctlPath: pocketctlBinary,
		Shell:         "/bin/zsh",
		Now:           func() time.Time { return now },
		ResolveOpenCode: func(context.Context) (string, string, error) {
			return realBinary, "1.17.11", nil
		},
	}

	status, err := installer.Enable(context.Background(), EnableOptions{})
	if err != nil {
		t.Fatal(err)
	}
	wantShim := filepath.Join(home, ".pocketctl", "bin", "opencode")
	if status.State != StateEnabled || status.ShimPath != wantShim || status.RealBinary != realBinary {
		t.Fatalf("enable status=%+v", status)
	}
	target, err := filepath.EvalSymlinks(wantShim)
	if err != nil {
		t.Fatal(err)
	}
	if !sameFile(target, pocketctlBinary) {
		t.Fatalf("shim target=%q want pocketctl %q", target, pocketctlBinary)
	}
	profile := filepath.Join(home, ".zshrc")
	profileData, err := os.ReadFile(profile)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Count(string(profileData), launcherBlockStart) != 1 || !strings.Contains(string(profileData), `.pocketctl/bin`) {
		t.Fatalf("profile block=%q", profileData)
	}
	if _, err := installer.Enable(context.Background(), EnableOptions{}); err != nil {
		t.Fatalf("idempotent enable: %v", err)
	}
	profileData, _ = os.ReadFile(profile)
	if strings.Count(string(profileData), launcherBlockStart) != 1 {
		t.Fatalf("enable duplicated profile block: %q", profileData)
	}

	if err := installer.Disable(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(wantShim); !os.IsNotExist(err) {
		t.Fatalf("shim remains after disable: %v", err)
	}
	if _, err := os.Stat(realBinary); err != nil {
		t.Fatalf("disable removed real opencode: %v", err)
	}
	profileData, err = os.ReadFile(profile)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(profileData), launcherBlockStart) {
		t.Fatalf("disable left managed profile block: %q", profileData)
	}
	cfg, err := LoadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.OpenCode.State != StateDisabled || cfg.OpenCode.DecisionSource != SourceCommand || !cfg.OpenCode.DecidedAt.Equal(now) {
		t.Fatalf("disable config=%+v", cfg.OpenCode)
	}
	if status := installer.Status(context.Background()); status.ShimPath != "" || status.PathActive {
		t.Fatalf("disabled status reports a launcher that no longer exists: %+v", status)
	}
}

func TestOpenCodeInstallerRefusesForeignShim(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix symlink behavior")
	}
	home := t.TempDir()
	t.Setenv("HOME", home)
	shim := filepath.Join(home, ".pocketctl", "bin", "opencode")
	if err := os.MkdirAll(filepath.Dir(shim), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(shim, []byte("foreign"), 0o755); err != nil {
		t.Fatal(err)
	}
	installer := Installer{
		PocketctlPath: testExecutable(t, "pocketctl"),
		Shell:         "/bin/zsh",
		ResolveOpenCode: func(context.Context) (string, string, error) {
			return testExecutable(t, "real-opencode"), "1.17.11", nil
		},
	}
	if _, err := installer.Enable(context.Background(), EnableOptions{}); !errors.Is(err, ErrForeignShim) {
		t.Fatalf("enable error=%v want ErrForeignShim", err)
	}
	data, err := os.ReadFile(shim)
	if err != nil || string(data) != "foreign" {
		t.Fatalf("foreign shim changed: %q err=%v", data, err)
	}
}

func TestOpenCodeInstallerNoShellProfile(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix profile behavior")
	}
	home := t.TempDir()
	t.Setenv("HOME", home)
	installer := Installer{
		PocketctlPath: testExecutable(t, "pocketctl"),
		Shell:         "/bin/zsh",
		ResolveOpenCode: func(context.Context) (string, string, error) {
			return testExecutable(t, "real-opencode"), "1.17.11", nil
		},
	}
	if _, err := installer.Enable(context.Background(), EnableOptions{NoShellProfile: true}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(home, ".zshrc")); !os.IsNotExist(err) {
		t.Fatalf("--no-shell-profile changed profile: %v", err)
	}
}

func TestOpenCodeInstallerDoesNotTruncateMalformedProfileBlock(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix profile behavior")
	}
	home := t.TempDir()
	t.Setenv("HOME", home)
	profile := filepath.Join(home, ".zshrc")
	original := "export KEEP_ME=1\n" + launcherBlockStart + "\nuser content without end marker\n"
	if err := os.WriteFile(profile, []byte(original), 0o600); err != nil {
		t.Fatal(err)
	}
	installer := Installer{
		PocketctlPath: testExecutable(t, "pocketctl"),
		Shell:         "/bin/zsh",
		ResolveOpenCode: func(context.Context) (string, string, error) {
			return testExecutable(t, "real-opencode"), "1.17.11", nil
		},
	}
	if _, err := installer.Enable(context.Background(), EnableOptions{}); !errors.Is(err, ErrMalformedProfileBlock) {
		t.Fatalf("enable error=%v want ErrMalformedProfileBlock", err)
	}
	got, err := os.ReadFile(profile)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != original {
		t.Fatalf("malformed profile was changed:\n%s", got)
	}
}

func TestOpenCodeInstallerStatusDoesNotRequireDaemon(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	real := testExecutable(t, "real-opencode")
	installer := Installer{
		ResolveOpenCode: func(context.Context) (string, string, error) { return real, "1.17.11", nil },
	}
	status := installer.Status(context.Background())
	if !status.Detected || status.State != StateUndecided || status.RealBinary != real || status.RuntimeReachable {
		t.Fatalf("status=%+v", status)
	}
}

func TestOpenCodeInstallerStatusReportsReachableManagedRuntime(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	real := testExecutable(t, "real-opencode")
	installer := Installer{
		ResolveOpenCode: func(context.Context) (string, string, error) { return real, "1.17.11", nil },
		RuntimeStatus: func(context.Context) (RuntimeStatusResult, error) {
			return RuntimeStatusResult{Mode: string(LaunchManaged), Generation: 3}, nil
		},
	}
	status := installer.Status(context.Background())
	if !status.RuntimeReachable {
		t.Fatalf("managed runtime was reported unreachable: %+v", status)
	}
}

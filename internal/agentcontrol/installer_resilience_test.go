//go:build !windows

package agentcontrol

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestEnsureLauncherPathConfiguresZshAndBashProfiles(t *testing.T) {
	home := t.TempDir()
	profiles := []string{".zshrc", ".bash_profile", ".bashrc"}
	for _, name := range profiles {
		if err := os.WriteFile(filepath.Join(home, name), []byte("# user config\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	if err := ensureLauncherPath(home, filepath.Join(home, ".pocketctl", "bin"), "/bin/zsh"); err != nil {
		t.Fatal(err)
	}
	if err := ensureLauncherPath(home, filepath.Join(home, ".pocketctl", "bin"), "/bin/zsh"); err != nil {
		t.Fatal(err)
	}

	for _, name := range profiles {
		data, err := os.ReadFile(filepath.Join(home, name))
		if err != nil {
			t.Fatal(err)
		}
		content := string(data)
		if strings.Count(content, launcherBlockStart) != 1 {
			t.Fatalf("%s launcher block count=%d content=%q", name, strings.Count(content, launcherBlockStart), content)
		}
		if !strings.Contains(content, `. "$HOME/.pocketctl/shell/path.sh"`) {
			t.Fatalf("%s does not source shared launcher PATH: %q", name, content)
		}
	}
	pathFile := filepath.Join(home, ".pocketctl", "shell", "path.sh")
	pathData, err := os.ReadFile(pathFile)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(pathData), `export PATH="$HOME/.pocketctl/bin:$PATH"`) {
		t.Fatalf("path.sh=%q", pathData)
	}

	if err := removeLauncherPath(home, filepath.Join(home, ".pocketctl", "bin"), "/bin/zsh"); err != nil {
		t.Fatal(err)
	}
	for _, name := range profiles {
		data, err := os.ReadFile(filepath.Join(home, name))
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(data), launcherBlockStart) {
			t.Fatalf("%s still contains launcher block: %q", name, data)
		}
	}
	if _, err := os.Stat(pathFile); !os.IsNotExist(err) {
		t.Fatalf("shared path file still exists: %v", err)
	}
}

func TestEnsureLauncherPathMovesExistingBinDirectoryToFront(t *testing.T) {
	home := t.TempDir()
	realBinDir := filepath.Join(home, "real-bin")
	launcherBinDir := filepath.Join(home, ".pocketctl", "bin")
	if err := os.MkdirAll(realBinDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(launcherBinDir, 0o700); err != nil {
		t.Fatal(err)
	}
	realCodex := writeInstallerTestExecutable(t, realBinDir, "codex", "exit 0")
	launcherCodex := writeInstallerTestExecutable(t, launcherBinDir, "codex", "exit 0")

	if err := ensureLauncherPath(home, launcherBinDir, "/bin/zsh"); err != nil {
		t.Fatal(err)
	}

	cmd := exec.Command("/bin/sh", "-c", `. "$HOME/.pocketctl/shell/path.sh"; command -v codex`)
	cmd.Env = []string{
		"HOME=" + home,
		"PATH=" + filepath.Dir(realCodex) + ":" + filepath.Dir(launcherCodex) + ":/usr/bin:/bin",
	}
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("source launcher PATH: %v output=%s", err, out)
	}
	if got := strings.TrimSpace(string(out)); got != launcherCodex {
		t.Fatalf("command -v codex=%q want launcher %q", got, launcherCodex)
	}
}

func TestInstalledShimFallsBackWhenPocketctlIsMissing(t *testing.T) {
	home := t.TempDir()
	shim := filepath.Join(home, "bin", "opencode")
	if err := os.MkdirAll(filepath.Dir(shim), 0o700); err != nil {
		t.Fatal(err)
	}
	realBinary := writeInstallerTestExecutable(t, home, "real-opencode", "printf 'real:%s\\n' \"$1\"")
	missingPocketctl := filepath.Join(home, "missing-pocketctl")

	if err := installPlatformShim(shim, missingPocketctl, AgentOpenCode, realBinary); err != nil {
		t.Fatal(err)
	}
	if info, err := os.Lstat(shim); err != nil || info.Mode()&os.ModeSymlink != 0 {
		t.Fatalf("shim should be a standalone wrapper: info=%v err=%v", info, err)
	}
	out, err := exec.Command(shim, "hello").CombinedOutput()
	if err != nil {
		t.Fatalf("fallback failed: %v output=%s", err, out)
	}
	if got := strings.TrimSpace(string(out)); got != "real:hello" {
		t.Fatalf("fallback output=%q", got)
	}
}

func TestStatusRequiresActiveLauncherPathForManagedMode(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	realBinary := writeInstallerTestExecutable(t, home, "real-opencode", "echo 1.17.11")
	pocketctl := writeInstallerTestExecutable(t, home, "pocketctl", "exit 0")
	shim := filepath.Join(home, ".pocketctl", "bin", "opencode")
	if err := os.MkdirAll(filepath.Dir(shim), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := installPlatformShim(shim, pocketctl, AgentOpenCode, realBinary); err != nil {
		t.Fatal(err)
	}
	cfg := DefaultConfig()
	cfg.OpenCode = AgentConfig{State: StateEnabled, RealBinary: realBinary, ShimPath: shim}
	if err := SaveConfig(cfg); err != nil {
		t.Fatal(err)
	}
	installer := Installer{
		ResolveOpenCode: func(context.Context) (string, string, error) { return realBinary, "1.17.11", nil },
		RuntimeStatus: func(context.Context) (RuntimeStatusResult, error) {
			return RuntimeStatusResult{Mode: string(LaunchManaged)}, nil
		},
	}

	t.Setenv("PATH", "/usr/bin:/bin")
	status := installer.Status(context.Background())
	if !status.RuntimeReachable || status.PathActive || status.EffectiveMode != string(LaunchNative) {
		t.Fatalf("inactive PATH status=%+v", status)
	}

	t.Setenv("PATH", filepath.Dir(shim)+":/usr/bin:/bin")
	status = installer.Status(context.Background())
	if !status.PathActive || status.EffectiveMode != string(LaunchManaged) {
		t.Fatalf("active PATH status=%+v", status)
	}
}

func writeInstallerTestExecutable(t *testing.T, dir, name, body string) string {
	t.Helper()
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+body+"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

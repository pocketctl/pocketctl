package agentcontrol

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	appconfig "github.com/pocketctl/pocketctl/internal/config"
)

func TestClaudeChannelMCPConfigIsPrivateAndPocketctlOwned(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	pocketctlBinary := testExecutable(t, "pocketctl")
	path, err := ensureClaudeChannelMCPConfig(pocketctlBinary)
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
		t.Fatalf("mode=%o want 600", info.Mode().Perm())
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var config struct {
		MCPServers map[string]struct {
			Type    string   `json:"type"`
			Command string   `json:"command"`
			Args    []string `json:"args"`
		} `json:"mcpServers"`
	}
	if err := json.Unmarshal(raw, &config); err != nil {
		t.Fatal(err)
	}
	pocketctl, ok := config.MCPServers["pocketctl"]
	if !ok || pocketctl.Type != "stdio" || pocketctl.Command != pocketctlBinary ||
		len(pocketctl.Args) != 1 || pocketctl.Args[0] != "__claude_channel" {
		t.Fatalf("unexpected MCP config: %s", raw)
	}
}

func TestClaudeInstallerEnableCreatesMCPConfig(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("wrapper assertions are Unix-specific")
	}
	home := t.TempDir()
	t.Setenv("HOME", home)
	realClaude := testExecutable(t, "claude")
	pocketctlBinary := testExecutable(t, "pocketctl")
	installer := Installer{
		PocketctlPath: pocketctlBinary,
		ResolveClaude: func(context.Context) (string, string, error) {
			return realClaude, MinimumClaudeChannelVersion, nil
		},
	}
	status, err := installer.EnableAgent(context.Background(), AgentClaudeCode, EnableOptions{NoShellProfile: true})
	if err != nil {
		t.Fatal(err)
	}
	if status.State != StateEnabled || status.RealBinary != realClaude {
		t.Fatalf("status=%+v", status)
	}
	mcpPath, err := appconfig.ClaudeChannelMCPConfigPath()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(mcpPath); err != nil {
		t.Fatalf("MCP config not created: %v", err)
	}
}

func TestClaudeStatusDoesNotReportChannelWhenRolloutIsOff(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("POCKETCTL_CLAUDE_CHANNEL_APPROVAL", "0")
	shimDir := filepath.Join(home, ".pocketctl", "bin")
	if err := os.MkdirAll(shimDir, 0o700); err != nil {
		t.Fatal(err)
	}
	shim := defaultClaudeShimPath()
	if err := os.WriteFile(shim, []byte("shim"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", shimDir)
	realClaude := testExecutable(t, "real-claude")
	cfg := DefaultConfig()
	cfg.Claude = AgentConfig{State: StateEnabled, RealBinary: realClaude, ShimPath: shim}
	if err := SaveConfig(cfg); err != nil {
		t.Fatal(err)
	}
	installer := Installer{ResolveClaude: func(context.Context) (string, string, error) {
		return realClaude, MinimumClaudeChannelVersion, nil
	}}
	status := installer.StatusAgent(context.Background(), AgentClaudeCode)
	if status.EffectiveMode != string(LaunchNative) {
		t.Fatalf("rollout-off status falsely reports active Channel: %+v", status)
	}
	if status.CapabilityReason != StatusClaudeChannelRolloutDisabled {
		t.Fatalf("rollout-off status reason=%q", status.CapabilityReason)
	}
}

func TestClaudeStatusSocketReachabilityDoesNotClaimChannelConfirmation(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("POCKETCTL_CLAUDE_CHANNEL_APPROVAL", "1")
	t.Setenv("POCKETCTL_CLAUDE_CHANNEL_DEVELOPMENT", "1")
	shimDir := filepath.Join(home, ".pocketctl", "bin")
	if err := os.MkdirAll(shimDir, 0o700); err != nil {
		t.Fatal(err)
	}
	shim := defaultClaudeShimPath()
	if err := os.WriteFile(shim, []byte("shim"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", shimDir)
	realClaude := testExecutable(t, "real-claude")
	pocketctlBinary := testExecutable(t, "pocketctl")
	if _, err := ensureClaudeChannelMCPConfig(pocketctlBinary); err != nil {
		t.Fatal(err)
	}
	cfg := DefaultConfig()
	cfg.Claude = AgentConfig{State: StateEnabled, RealBinary: realClaude, ShimPath: shim}
	if err := SaveConfig(cfg); err != nil {
		t.Fatal(err)
	}
	installer := Installer{
		ResolveClaude: func(context.Context) (string, string, error) {
			return realClaude, MinimumClaudeChannelVersion, nil
		},
		ClaudeChannelReachable: func(context.Context) bool { return true },
	}
	status := installer.StatusAgent(context.Background(), AgentClaudeCode)
	if status.EffectiveMode != string(LaunchNative) || status.CapabilityReason != StatusClaudeChannelDevelopmentChannelNotConfirmed {
		t.Fatalf("unconfirmed development channel was reported active: %+v", status)
	}
	if !status.RuntimeReachable {
		t.Fatal("socket reachability should remain separately observable")
	}
}

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
	shimInfo, err := os.Lstat(wantShim)
	if err != nil {
		t.Fatal(err)
	}
	if shimInfo.Mode()&os.ModeSymlink != 0 || shimInfo.Mode().Perm()&0o111 == 0 {
		t.Fatalf("shim must be an executable standalone wrapper: mode=%v", shimInfo.Mode())
	}
	shimData, err := os.ReadFile(wantShim)
	if err != nil {
		t.Fatal(err)
	}
	shimContent := string(shimData)
	if !strings.Contains(shimContent, testShimMarker()) || !strings.Contains(shimContent, pocketctlBinary) || !strings.Contains(shimContent, realBinary) {
		t.Fatalf("shim does not preserve launcher and fallback paths: %q", shimContent)
	}
	profile := filepath.Join(home, ".zshrc")
	profileData, err := os.ReadFile(profile)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Count(string(profileData), launcherBlockStart) != 1 || !strings.Contains(string(profileData), `.pocketctl/shell/path.sh`) {
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

func TestCodexInstallerEnableDisableRoundTrip(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix symlink/profile behavior")
	}
	home := t.TempDir()
	t.Setenv("HOME", home)
	realBinary := testExecutable(t, "real-codex")
	installer := Installer{
		PocketctlPath: testExecutable(t, "pocketctl"),
		Shell:         "/bin/zsh",
		ResolveCodex: func(context.Context) (string, string, error) {
			return realBinary, "0.144.1", nil
		},
		ProbeCodex: func(context.Context, string, string) (CodexCapabilities, error) {
			return CodexCapabilities{Core: true, TerminalRemote: true}, nil
		},
	}
	status, err := installer.EnableAgent(context.Background(), AgentCodex, EnableOptions{})
	if err != nil {
		t.Fatal(err)
	}
	wantShim := filepath.Join(home, ".pocketctl", "bin", "codex")
	if status.Agent != AgentCodex || status.State != StateEnabled || status.ShimPath != wantShim || status.RealBinary != realBinary {
		t.Fatalf("enable status=%+v", status)
	}
	if err := installer.DisableAgent(context.Background(), AgentCodex); err != nil {
		t.Fatal(err)
	}
	cfg, err := LoadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Codex.State != StateDisabled || cfg.OpenCode.State != StateUndecided {
		t.Fatalf("config=%+v", cfg)
	}
}

func TestCodexInstallerRejectsOldVersionBeforeInstallingShim(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	installer := Installer{
		PocketctlPath: testExecutable(t, "pocketctl"),
		ResolveCodex: func(context.Context) (string, string, error) {
			return testExecutable(t, "old-codex"), "0.144.0", nil
		},
	}
	if _, err := installer.EnableAgent(context.Background(), AgentCodex, EnableOptions{}); !errors.Is(err, ErrCodexVersionUnsupported) {
		t.Fatalf("error=%v, want ErrCodexVersionUnsupported", err)
	}
	if _, err := os.Lstat(filepath.Join(home, ".pocketctl", "bin", "codex")); !os.IsNotExist(err) {
		t.Fatalf("old Codex installed shim: %v", err)
	}
}

func writeShimV3TestExecutable(t *testing.T, path, body string) {
	t.Helper()
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+body+"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
}

func TestUnixShimV3WrapperContract(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix shell wrapper behavior")
	}
	dir := t.TempDir()
	shim := filepath.Join(dir, "opencode")
	pocketctl := filepath.Join(dir, "pocketctl")
	realBinary := filepath.Join(dir, "real-opencode")
	writeShimV3TestExecutable(t, pocketctl, "exit 0")
	writeShimV3TestExecutable(t, realBinary, "exit 0")

	if err := installPlatformShim(shim, pocketctl, AgentOpenCode, realBinary); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(shim)
	if err != nil {
		t.Fatal(err)
	}
	content := string(data)

	if count := strings.Count(content, launcherMarkerV3Unix); count != 1 {
		t.Fatalf("v3 marker count=%d content=%q", count, content)
	}
	if strings.Contains(content, launcherMarkerV2Unix) {
		t.Fatalf("wrapper still emits legacy v2 marker: %q", content)
	}
	if !strings.Contains(content, testShellQuote(realBinary)) {
		t.Fatalf("wrapper does not record quoted real binary: %q", content)
	}

	depthCheck := strings.Index(content, "POCKETCTL_AGENT_LAUNCH_DEPTH")
	pocketctlHop := strings.Index(content, "__agent-launch")
	if depthCheck < 0 || pocketctlHop < 0 || depthCheck > pocketctlHop {
		t.Fatalf("depth fuse must be checked before the PocketCtl hop: %q", content)
	}
	if !strings.Contains(content, "unset POCKETCTL_AGENT_LAUNCH_DEPTH POCKETCTL_AGENT_REAL_BINARY") {
		t.Fatalf("wrapper must unset both internal env variables on fallback: %q", content)
	}
	if count := strings.Count(content, "POCKETCTL_AGENT_LAUNCH_DEPTH=1"); count != 1 {
		t.Fatalf("depth assignment count=%d content=%q", count, content)
	}
	if count := strings.Count(content, "POCKETCTL_AGENT_REAL_BINARY="); count != 1 {
		t.Fatalf("real-binary hint assignment count=%d content=%q", count, content)
	}
	if !strings.Contains(content, "exec "+testShellQuote(pocketctl)+" ") {
		t.Fatalf("wrapper must exec PocketCtl: %q", content)
	}
	if !strings.Contains(content, "exec "+testShellQuote(realBinary)) {
		t.Fatalf("wrapper must exec the real binary directly: %q", content)
	}
	if count := strings.Count(content, " \"$@\""); count != 3 {
		t.Fatalf("wrapper must preserve \"$@\" on every exec, count=%d content=%q", count, content)
	}
}

func TestUnixShimV3WrapperRefusesForeignFileAndKeepsContent(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix shell wrapper behavior")
	}
	dir := t.TempDir()
	shim := filepath.Join(dir, "opencode")
	pocketctl := filepath.Join(dir, "pocketctl")
	realBinary := filepath.Join(dir, "real-opencode")
	writeShimV3TestExecutable(t, pocketctl, "exit 0")
	writeShimV3TestExecutable(t, realBinary, "exit 0")
	foreign := "#!/bin/sh\nexec /usr/local/bin/opencode \"$@\"\n"
	if err := os.WriteFile(shim, []byte(foreign), 0o755); err != nil {
		t.Fatal(err)
	}

	if err := installPlatformShim(shim, pocketctl, AgentOpenCode, realBinary); err == nil {
		t.Fatal("installPlatformShim overwrote a foreign wrapper")
	}
	data, err := os.ReadFile(shim)
	if err != nil || string(data) != foreign {
		t.Fatalf("foreign wrapper changed: %q err=%v", data, err)
	}
}

func TestUnixShimV3UpgradesLegacyV2Wrapper(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix shell wrapper behavior")
	}
	dir := t.TempDir()
	shim := filepath.Join(dir, "opencode")
	pocketctl := filepath.Join(dir, "pocketctl")
	realBinary := filepath.Join(dir, "real-opencode")
	writeShimV3TestExecutable(t, pocketctl, "exit 0")
	writeShimV3TestExecutable(t, realBinary, "exit 0")

	legacy := "#!/bin/sh\n" + launcherMarkerV2Unix + "\n" +
		"if [ -x " + testShellQuote(pocketctl) + " ]; then\n" +
		"  exec " + testShellQuote(pocketctl) + " __agent-launch " + testShellQuote(AgentOpenCode) + " \"$@\"\n" +
		"fi\n" +
		"exec " + testShellQuote(realBinary) + " \"$@\"\n"
	if err := os.WriteFile(shim, []byte(legacy), 0o755); err != nil {
		t.Fatal(err)
	}

	if err := installPlatformShim(shim, pocketctl, AgentOpenCode, realBinary); err != nil {
		t.Fatalf("v2 wrapper upgrade failed: %v", err)
	}
	data, err := os.ReadFile(shim)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), launcherMarkerV3Unix) {
		t.Fatalf("upgraded wrapper is not v3: %q", data)
	}
}

func TestUnixShimSecondHopFallsBackToRecordedRealBinary(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix shell wrapper behavior")
	}
	dir := t.TempDir()
	t.Setenv("PATH", dir) // isolated PATH: only fixtures created by this test resolve

	shim := filepath.Join(dir, "opencode")
	pocketctlRuns := filepath.Join(dir, "pocketctl-runs")
	realRuns := filepath.Join(dir, "real-runs")
	realLeak := filepath.Join(dir, "real-leak")
	realArgv := filepath.Join(dir, "real-argv")

	// Fake real binary records argv and internal-env leakage once per run.
	// PATH is isolated, so detection uses shell parameter expansion and
	// builtins only.
	realBinary := filepath.Join(dir, "real-opencode")
	writeShimV3TestExecutable(t, realBinary,
		"echo run >> "+testShellQuote(realRuns)+
			"; printf '%s\\n' \"$@\" > "+testShellQuote(realArgv)+
			"; if [ -n \"${POCKETCTL_AGENT_LAUNCH_DEPTH:-}\" ] || [ -n \"${POCKETCTL_AGENT_REAL_BINARY:-}\" ]; then touch "+testShellQuote(realLeak)+"; fi")

	// Fake PocketCtl reinvokes the wrapper once while preserving env and the
	// user argv (after stripping its own __agent-launch arguments), simulating
	// a launcher that re-enters the shim.
	pocketctl := filepath.Join(dir, "pocketctl")
	writeShimV3TestExecutable(t, pocketctl,
		"echo run >> "+testShellQuote(pocketctlRuns)+
			" && shift 2 && exec "+testShellQuote(shim)+" \"$@\"")

	if err := installPlatformShim(shim, pocketctl, AgentOpenCode, realBinary); err != nil {
		t.Fatal(err)
	}

	out, err := exec.Command(shim, "resume", "--flag", "arg with spaces").CombinedOutput()
	if err != nil {
		t.Fatalf("wrapper execution failed: %v output=%s", err, out)
	}

	pocketctlData, err := os.ReadFile(pocketctlRuns)
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Count(string(pocketctlData), "run"); got != 1 {
		t.Fatalf("PocketCtl hop count=%d, want exactly one (output=%s)", got, out)
	}
	realData, err := os.ReadFile(realRuns)
	if err != nil {
		t.Fatalf("real binary never ran: %v", err)
	}
	if got := strings.Count(string(realData), "run"); got != 1 {
		t.Fatalf("real binary run count=%d, want exactly one", got)
	}
	argvData, err := os.ReadFile(realArgv)
	if err != nil {
		t.Fatal(err)
	}
	argv := strings.Split(strings.TrimRight(string(argvData), "\n"), "\n")
	wantArgv := []string{"resume", "--flag", "arg with spaces"}
	if strings.Join(argv, "\x00") != strings.Join(wantArgv, "\x00") {
		t.Fatalf("real argv=%q, want %q", argv, wantArgv)
	}
	if _, err := os.Lstat(realLeak); !os.IsNotExist(err) {
		t.Fatalf("internal launcher env leaked into the real binary: %v", err)
	}
}

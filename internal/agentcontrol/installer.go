package agentcontrol

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const (
	launcherBlockStart = "# >>> pocketctl agent launcher >>>"
	launcherBlockEnd   = "# <<< pocketctl agent launcher <<<"
)

var (
	ErrForeignShim           = errors.New("opencode launcher path is owned by another file")
	ErrUnsupportedShell      = errors.New("unsupported shell; use --no-shell-profile and configure PATH manually")
	ErrMalformedProfileBlock = errors.New("pocketctl launcher profile block is incomplete; repair it manually")
)

type EnableOptions struct {
	NoShellProfile bool
	DecisionSource string
}

type Status struct {
	Agent            string
	Detected         bool
	Version          string
	State            string
	EffectiveMode    string
	CapabilityReason string
	RealBinary       string
	ShimPath         string
	PathActive       bool
	RuntimeReachable bool
	Error            string
}

type Manager interface {
	Detect(context.Context) (string, string, error)
	EnableDetected(context.Context, string, EnableOptions) (Status, error)
	Disable(context.Context) error
	Status(context.Context) Status
}

type MultiAgentManager interface {
	DetectAgent(context.Context, string) (string, string, error)
	EnableAgentDetected(context.Context, string, string, EnableOptions) (Status, error)
	DisableAgent(context.Context, string) error
	StatusAgent(context.Context, string) Status
}

type Installer struct {
	PocketctlPath      string
	Shell              string
	Now                func() time.Time
	ResolveOpenCode    func(context.Context) (string, string, error)
	ResolveCodex       func(context.Context) (string, string, error)
	ProbeCodex         func(context.Context, string, string) (CodexCapabilities, error)
	RuntimeStatus      func(context.Context) (RuntimeStatusResult, error)
	RuntimeStatusAgent func(context.Context, string) (RuntimeStatusResult, error)
}

func NewInstaller() *Installer {
	return &Installer{}
}

func (i Installer) Detect(ctx context.Context) (string, string, error) {
	return i.DetectAgent(ctx, AgentOpenCode)
}

func (i Installer) DetectAgent(ctx context.Context, agent string) (string, string, error) {
	switch agent {
	case AgentOpenCode:
		if i.ResolveOpenCode != nil {
			return i.ResolveOpenCode(ctx)
		}
		return ResolveConfiguredOpenCode()
	case AgentCodex:
		if i.ResolveCodex != nil {
			return i.ResolveCodex(ctx)
		}
		return ResolveConfiguredCodex()
	default:
		return "", "", fmt.Errorf("unknown managed agent %q", agent)
	}
}

func (i Installer) Enable(ctx context.Context, options EnableOptions) (Status, error) {
	return i.EnableAgent(ctx, AgentOpenCode, options)
}

func (i Installer) EnableAgent(ctx context.Context, agent string, options EnableOptions) (Status, error) {
	path, _, err := i.DetectAgent(ctx, agent)
	if err != nil {
		return Status{}, err
	}
	return i.EnableAgentDetected(ctx, agent, path, options)
}

func (i Installer) EnableDetected(ctx context.Context, realBinary string, options EnableOptions) (Status, error) {
	return i.EnableAgentDetected(ctx, AgentOpenCode, realBinary, options)
}

func (i Installer) EnableAgentDetected(ctx context.Context, agent, realBinary string, options EnableOptions) (Status, error) {
	detectedPath, version, err := i.DetectAgent(ctx, agent)
	if err != nil {
		return Status{}, err
	}
	if realBinary == "" {
		realBinary = detectedPath
	}
	// Detection is repeated here so an executable replaced between the CLI's
	// detect and enable steps cannot be persisted by stale path. The latest
	// successful resolution is authoritative.
	realBinary = detectedPath
	if err := i.checkCompatibility(ctx, agent, detectedPath, version); err != nil {
		return Status{}, err
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return Status{}, err
	}
	pocketctlPath, err := i.pocketctlPath()
	if err != nil {
		return Status{}, err
	}
	shimPath := defaultShimPath(agent)
	if err := os.MkdirAll(filepath.Dir(shimPath), 0o700); err != nil {
		return Status{}, fmt.Errorf("create launcher directory: %w", err)
	}
	if err := installPlatformShim(shimPath, pocketctlPath, agent); err != nil {
		return Status{}, err
	}
	profileChanged := false
	if !options.NoShellProfile {
		if err := ensureLauncherPath(home, filepath.Dir(shimPath), i.shell()); err != nil {
			_ = removePlatformShim(shimPath, pocketctlPath)
			return Status{}, err
		}
		profileChanged = true
	}

	cfg, loadErr := LoadConfig()
	if loadErr != nil && !errors.Is(loadErr, os.ErrNotExist) {
		if profileChanged {
			_ = removeLauncherPath(home, filepath.Dir(shimPath), i.shell())
		}
		_ = removePlatformShim(shimPath, pocketctlPath)
		return Status{}, loadErr
	}
	now := i.now()
	source := options.DecisionSource
	if source == "" {
		source = SourceCommand
	}
	cfg.Version = ConfigVersion
	agentConfig := AgentConfig{
		State: StateEnabled, DecisionSource: source, RealBinary: realBinary,
		ShimPath: shimPath, DecidedAt: now, InstalledAt: now,
	}
	if err := setAgentConfig(&cfg, agent, agentConfig); err != nil {
		return Status{}, err
	}
	if err := SaveConfig(cfg); err != nil {
		if profileChanged {
			_ = removeLauncherPath(home, filepath.Dir(shimPath), i.shell())
		}
		_ = removePlatformShim(shimPath, pocketctlPath)
		return Status{}, err
	}
	return i.StatusAgent(context.Background(), agent), nil
}

func (i Installer) Disable(ctx context.Context) error {
	return i.DisableAgent(ctx, AgentOpenCode)
}

func (i Installer) DisableAgent(_ context.Context, agent string) error {
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	cfg, err := LoadConfig()
	if err != nil {
		return err
	}
	agentConfig, err := getAgentConfig(cfg, agent)
	if err != nil {
		return err
	}
	shimPath := agentConfig.ShimPath
	if shimPath == "" {
		shimPath = defaultShimPath(agent)
	}
	pocketctlPath, pathErr := i.pocketctlPath()
	if pathErr == nil {
		if err := removePlatformShim(shimPath, pocketctlPath); err != nil {
			return err
		}
	} else if _, statErr := os.Lstat(shimPath); statErr == nil {
		return pathErr
	}
	cfg.Version = ConfigVersion
	agentConfig.State = StateDisabled
	agentConfig.DecisionSource = SourceCommand
	agentConfig.DecidedAt = i.now()
	agentConfig.ShimPath = ""
	agentConfig.InstalledAt = time.Time{}
	if err := setAgentConfig(&cfg, agent, agentConfig); err != nil {
		return err
	}
	if !hasInstalledLauncher(cfg) {
		if err := removeLauncherPath(home, filepath.Dir(shimPath), i.shell()); err != nil {
			return err
		}
	}
	return SaveConfig(cfg)
}

func (i Installer) Status(ctx context.Context) Status {
	return i.StatusAgent(ctx, AgentOpenCode)
}

func (i Installer) StatusAgent(ctx context.Context, agent string) Status {
	cfg, err := LoadConfig()
	if err != nil {
		cfg = DefaultConfig()
	}
	agentConfig, configErr := getAgentConfig(cfg, agent)
	if configErr != nil {
		return Status{Agent: agent, State: StateUndecided, Error: configErr.Error()}
	}
	status := Status{
		Agent:         agent,
		State:         agentConfig.State,
		RealBinary:    agentConfig.RealBinary,
		ShimPath:      agentConfig.ShimPath,
		EffectiveMode: string(LaunchNative),
	}
	path, version, detectErr := i.DetectAgent(ctx, agent)
	if detectErr == nil {
		status.Detected = true
		status.Version = version
		if status.RealBinary == "" {
			status.RealBinary = path
		}
		if compatibilityErr := i.checkCompatibility(ctx, agent, path, version); compatibilityErr != nil {
			status.CapabilityReason = compatibilityErr.Error()
		}
	} else if !errors.Is(detectErr, ErrOpenCodeNotFound) && !errors.Is(detectErr, ErrCodexNotFound) {
		status.Error = detectErr.Error()
	}
	if status.ShimPath == "" {
		defaultShim := defaultShimPath(agent)
		if _, statErr := os.Lstat(defaultShim); statErr == nil {
			status.ShimPath = defaultShim
		}
	}
	if status.ShimPath != "" {
		status.PathActive = pathContains(filepath.Dir(status.ShimPath))
	}
	runtimeStatus := func(ctx context.Context) (RuntimeStatusResult, error) {
		if i.RuntimeStatusAgent != nil {
			return i.RuntimeStatusAgent(ctx, agent)
		}
		if agent == AgentOpenCode && i.RuntimeStatus != nil {
			return i.RuntimeStatus(ctx)
		}
		return NewAgentClient("", agent).Status(ctx, StatusPayload{})
	}
	statusCtx, cancel := context.WithTimeout(ctx, DefaultLauncherTimeout)
	defer cancel()
	if runtime, runtimeErr := runtimeStatus(statusCtx); runtimeErr == nil {
		status.RuntimeReachable = runtime.Mode == string(LaunchManaged)
		if status.RuntimeReachable {
			status.EffectiveMode = string(LaunchManaged)
		}
	}
	return status
}

func (i Installer) checkCompatibility(ctx context.Context, agent, binary, version string) error {
	switch agent {
	case AgentOpenCode:
		if !SupportsManagedOpenCodeVersion(version) {
			return fmt.Errorf("%w: OpenCode %s is older than %s", ErrCodexVersionUnsupported, version, minimumManagedOpenCodeVersion)
		}
		return nil
	case AgentCodex:
		if !SupportsManagedCodexVersion(version) {
			return fmt.Errorf("%w: Codex %s is older than %s", ErrCodexVersionUnsupported, version, minimumManagedCodexVersion)
		}
		probe := i.ProbeCodex
		if probe == nil {
			probe = func(ctx context.Context, path, version string) (CodexCapabilities, error) {
				return (CodexProbe{}).Probe(ctx, path, version)
			}
		}
		_, err := probe(ctx, binary, version)
		return err
	default:
		return fmt.Errorf("unknown managed agent %q", agent)
	}
}

func getAgentConfig(cfg Config, agent string) (AgentConfig, error) {
	switch agent {
	case AgentOpenCode:
		return cfg.OpenCode, nil
	case AgentCodex:
		return cfg.Codex, nil
	default:
		return AgentConfig{}, fmt.Errorf("unknown managed agent %q", agent)
	}
}

func setAgentConfig(cfg *Config, agent string, value AgentConfig) error {
	switch agent {
	case AgentOpenCode:
		cfg.OpenCode = value
	case AgentCodex:
		cfg.Codex = value
	default:
		return fmt.Errorf("unknown managed agent %q", agent)
	}
	return nil
}

func hasInstalledLauncher(cfg Config) bool {
	for _, value := range []AgentConfig{cfg.OpenCode, cfg.Codex} {
		if value.State == StateEnabled && value.ShimPath != "" {
			if _, err := os.Lstat(value.ShimPath); err == nil {
				return true
			}
		}
	}
	return false
}

func (i Installer) pocketctlPath() (string, error) {
	path := i.PocketctlPath
	if path == "" {
		var err error
		path, err = os.Executable()
		if err != nil {
			return "", err
		}
	}
	if resolved, err := filepath.EvalSymlinks(path); err == nil {
		path = resolved
	}
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		return "", fmt.Errorf("invalid pocketctl binary %q", path)
	}
	return path, nil
}

func (i Installer) shell() string {
	if i.Shell != "" {
		return i.Shell
	}
	return os.Getenv("SHELL")
}

func (i Installer) now() time.Time {
	if i.Now != nil {
		return i.Now().UTC()
	}
	return time.Now().UTC()
}

func pathContains(want string) bool {
	want = cleanComparablePath(want)
	for _, entry := range filepath.SplitList(os.Getenv("PATH")) {
		if cleanComparablePath(entry) == want {
			return true
		}
	}
	return false
}

func cleanComparablePath(path string) string {
	path = os.ExpandEnv(strings.TrimSpace(path))
	if abs, err := filepath.Abs(path); err == nil {
		path = abs
	}
	if runtime.GOOS == "windows" {
		path = strings.ToLower(path)
	}
	return filepath.Clean(path)
}

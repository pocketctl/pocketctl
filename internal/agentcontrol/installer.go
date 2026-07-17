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
	Detected         bool
	Version          string
	State            string
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

type Installer struct {
	PocketctlPath   string
	Shell           string
	Now             func() time.Time
	ResolveOpenCode func(context.Context) (string, string, error)
	RuntimeStatus   func(context.Context) (RuntimeStatusResult, error)
}

func NewInstaller() *Installer {
	return &Installer{}
}

func (i Installer) Detect(ctx context.Context) (string, string, error) {
	if i.ResolveOpenCode != nil {
		return i.ResolveOpenCode(ctx)
	}
	return ResolveConfiguredOpenCode()
}

func (i Installer) Enable(ctx context.Context, options EnableOptions) (Status, error) {
	path, _, err := i.Detect(ctx)
	if err != nil {
		return Status{}, err
	}
	return i.EnableDetected(ctx, path, options)
}

func (i Installer) EnableDetected(_ context.Context, realBinary string, options EnableOptions) (Status, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return Status{}, err
	}
	pocketctlPath, err := i.pocketctlPath()
	if err != nil {
		return Status{}, err
	}
	shimPath := defaultOpenCodeShimPath()
	if err := os.MkdirAll(filepath.Dir(shimPath), 0o700); err != nil {
		return Status{}, fmt.Errorf("create launcher directory: %w", err)
	}
	if err := installPlatformShim(shimPath, pocketctlPath); err != nil {
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
	cfg.OpenCode = AgentConfig{
		State: StateEnabled, DecisionSource: source, RealBinary: realBinary,
		ShimPath: shimPath, DecidedAt: now, InstalledAt: now,
	}
	if err := SaveConfig(cfg); err != nil {
		if profileChanged {
			_ = removeLauncherPath(home, filepath.Dir(shimPath), i.shell())
		}
		_ = removePlatformShim(shimPath, pocketctlPath)
		return Status{}, err
	}
	return i.Status(context.Background()), nil
}

func (i Installer) Disable(_ context.Context) error {
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	cfg, err := LoadConfig()
	if err != nil {
		return err
	}
	shimPath := cfg.OpenCode.ShimPath
	if shimPath == "" {
		shimPath = defaultOpenCodeShimPath()
	}
	pocketctlPath, pathErr := i.pocketctlPath()
	if pathErr == nil {
		if err := removePlatformShim(shimPath, pocketctlPath); err != nil {
			return err
		}
	} else if _, statErr := os.Lstat(shimPath); statErr == nil {
		return pathErr
	}
	if err := removeLauncherPath(home, filepath.Dir(shimPath), i.shell()); err != nil {
		return err
	}
	cfg.Version = ConfigVersion
	cfg.OpenCode.State = StateDisabled
	cfg.OpenCode.DecisionSource = SourceCommand
	cfg.OpenCode.DecidedAt = i.now()
	cfg.OpenCode.ShimPath = ""
	cfg.OpenCode.InstalledAt = time.Time{}
	return SaveConfig(cfg)
}

func (i Installer) Status(ctx context.Context) Status {
	cfg, err := LoadConfig()
	if err != nil {
		cfg = DefaultConfig()
	}
	status := Status{
		State:      cfg.OpenCode.State,
		RealBinary: cfg.OpenCode.RealBinary,
		ShimPath:   cfg.OpenCode.ShimPath,
	}
	path, version, detectErr := i.Detect(ctx)
	if detectErr == nil {
		status.Detected = true
		status.Version = version
		if status.RealBinary == "" {
			status.RealBinary = path
		}
	} else if !errors.Is(detectErr, ErrOpenCodeNotFound) {
		status.Error = detectErr.Error()
	}
	if status.ShimPath == "" {
		defaultShim := defaultOpenCodeShimPath()
		if _, statErr := os.Lstat(defaultShim); statErr == nil {
			status.ShimPath = defaultShim
		}
	}
	if status.ShimPath != "" {
		status.PathActive = pathContains(filepath.Dir(status.ShimPath))
	}
	runtimeStatus := i.RuntimeStatus
	if runtimeStatus == nil {
		client := NewClient("")
		runtimeStatus = func(ctx context.Context) (RuntimeStatusResult, error) {
			return client.Status(ctx, StatusPayload{})
		}
	}
	statusCtx, cancel := context.WithTimeout(ctx, DefaultLauncherTimeout)
	defer cancel()
	if runtime, runtimeErr := runtimeStatus(statusCtx); runtimeErr == nil {
		status.RuntimeReachable = runtime.Mode == string(LaunchManaged)
	}
	return status
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

package agentcontrol

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	DefaultLauncherTimeout = 200 * time.Millisecond
	DefaultAcquireTimeout  = 10 * time.Second
)

type ExecSpec struct {
	Path    string
	Args    []string
	Env     []string
	Dir     string
	OnStart func(pid int) error
}

type Launcher struct {
	Acquire        func(context.Context, AcquirePayload) (AcquireResult, error)
	BindLease      func(context.Context, LeaseBindPayload) error
	Release        func(context.Context, ReleasePayload) error
	ResolveBinary  func() (string, error)
	Execute        func(ExecSpec) error
	Environ        func() []string
	Stderr         io.Writer
	Timeout        time.Duration
	AcquireTimeout time.Duration
	RecordFallback func(string)
}

func NewLauncher() Launcher {
	client := NewClient("")
	return Launcher{
		Acquire: func(ctx context.Context, payload AcquirePayload) (AcquireResult, error) {
			return client.Acquire(ctx, payload)
		},
		BindLease:      client.BindLease,
		Release:        client.Release,
		ResolveBinary:  resolveLauncherOpenCode,
		Execute:        executeOpenCode,
		Environ:        os.Environ,
		Stderr:         os.Stderr,
		Timeout:        DefaultLauncherTimeout,
		AcquireTimeout: DefaultAcquireTimeout,
		RecordFallback: func(reason string) { _ = RecordOpenCodeFallback(reason) },
	}
}

func (l Launcher) Run(ctx context.Context, args []string, cwd string) error {
	if cwd == "" {
		cwd, _ = os.Getwd()
	}
	plan := PlanOpenCode(args, cwd)
	if l.Environ == nil {
		l.Environ = os.Environ
	}
	if l.Stderr == nil {
		l.Stderr = io.Discard
	}
	if l.Execute == nil {
		l.Execute = executeOpenCode
	}
	if l.ResolveBinary == nil {
		l.ResolveBinary = resolveLauncherOpenCode
	}
	if l.Timeout <= 0 {
		l.Timeout = DefaultLauncherTimeout
	}
	if l.AcquireTimeout <= 0 {
		// Custom launchers historically use Timeout as the complete Acquire
		// budget. NewLauncher opts into a longer provider preparation budget,
		// while Client still caps only the local daemon connection attempt.
		l.AcquireTimeout = l.Timeout
	}

	if plan.Mode == LaunchNative {
		if plan.Warn {
			if l.RecordFallback != nil {
				l.RecordFallback(FallbackUnsupportedArguments)
			}
			fmt.Fprintf(l.Stderr, "pocketctl: OpenCode arguments are not managed yet; starting native OpenCode (%s)\n", plan.Reason)
		}
		binary, err := l.ResolveBinary()
		if err != nil {
			return err
		}
		return l.Execute(ExecSpec{Path: binary, Args: plan.NativeArgs, Env: stripLauncherInternalEnv(l.Environ()), Dir: plan.CWD})
	}

	acquire := l.Acquire
	if acquire == nil {
		acquire = NewLauncher().Acquire
	}
	requestCtx, cancel := context.WithTimeout(ctx, l.AcquireTimeout)
	result, err := acquire(requestCtx, AcquirePayload{
		CWD: plan.CWD, Intent: plan.Intent, SessionID: plan.SessionID, Fork: plan.Fork,
		OperationID: newOperationID(),
	})
	cancel()
	if err != nil || result.Mode != string(LaunchManaged) {
		if l.RecordFallback != nil {
			l.RecordFallback(classifyOpenCodeFallback(err, result))
		}
		reason := "daemon unavailable"
		var protocolErr *ProtocolError
		if errors.As(err, &protocolErr) {
			if protocolErr.Message != "" {
				reason = protocolErr.Message
			} else {
				reason = protocolErr.Code
			}
		} else if err == nil && result.Reason != "" {
			reason = result.Reason
		}
		fmt.Fprintf(l.Stderr, "pocketctl: managed OpenCode unavailable; starting native OpenCode (%s)\n", oneLine(reason))
		binary := result.RealBinary
		if binary == "" {
			binary, err = l.ResolveBinary()
			if err != nil {
				return err
			}
		}
		return l.Execute(ExecSpec{Path: binary, Args: args, Env: stripLauncherInternalEnv(l.Environ()), Dir: plan.CWD})
	}
	if result.RealBinary == "" || result.BaseURL == "" {
		return errors.New("daemon returned an incomplete managed OpenCode runtime")
	}
	env := setEnv(stripLauncherInternalEnv(l.Environ()), "OPENCODE_SERVER_PASSWORD", result.Password)
	if result.Username != "" {
		env = setEnv(env, "OPENCODE_SERVER_USERNAME", result.Username)
	}
	spec := ExecSpec{Path: result.RealBinary, Args: plan.ManagedArgs(result), Env: env, Dir: plan.CWD}
	if result.LeaseID != "" {
		bindLease := l.BindLease
		if bindLease == nil {
			bindLease = NewClient("").BindLease
		}
		spec.OnStart = func(pid int) error {
			bindCtx, bindCancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer bindCancel()
			return bindLease(bindCtx, LeaseBindPayload{LeaseID: result.LeaseID, PID: pid})
		}
	}
	err = l.Execute(spec)
	if result.LeaseID != "" {
		release := l.Release
		if release == nil {
			release = NewClient("").Release
		}
		releaseCtx, releaseCancel := context.WithTimeout(context.Background(), 2*time.Second)
		_ = release(releaseCtx, ReleasePayload{LeaseID: result.LeaseID})
		releaseCancel()
	}
	return err
}

func resolveLauncherOpenCode() (string, error) {
	cfg, err := LoadConfig()
	if err == nil && cfg.OpenCode.RealBinary != "" {
		if resolved, ok := validatedRealAgentPath(cfg.OpenCode.RealBinary); ok &&
			!sameResolvedPath(resolved, cfg.OpenCode.ShimPath) && !sameResolvedPath(resolved, defaultOpenCodeShimPath()) {
			return resolved, nil
		}
	}
	if hint, ok := validatedLauncherRealBinaryHint(); ok {
		return hint, nil
	}
	path, _, err := ResolveConfiguredOpenCode()
	return path, err
}

func sameResolvedPath(path, other string) bool {
	if other == "" {
		return false
	}
	resolved, _, err := inspectPath(other)
	return err == nil && filepath.Clean(path) == filepath.Clean(resolved)
}

func setEnv(env []string, key, value string) []string {
	prefix := key + "="
	out := make([]string, 0, len(env)+1)
	for _, item := range env {
		if !strings.HasPrefix(item, prefix) {
			out = append(out, item)
		}
	}
	return append(out, prefix+value)
}

func newOperationID() string {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err == nil {
		return hex.EncodeToString(raw[:])
	}
	return fmt.Sprintf("%d-%d", os.Getpid(), time.Now().UnixNano())
}

func oneLine(value string) string {
	value = strings.ReplaceAll(value, "\r", " ")
	value = strings.ReplaceAll(value, "\n", " ")
	return strings.TrimSpace(value)
}

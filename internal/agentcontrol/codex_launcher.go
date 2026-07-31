package agentcontrol

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"time"
)

type CodexLauncher struct {
	Acquire        func(context.Context, AcquirePayload) (AcquireResult, error)
	BindLease      func(context.Context, LeaseBindPayload) error
	Release        func(context.Context, ReleasePayload) error
	ResolveBinary  func() (string, error)
	Execute        func(ExecSpec) error
	Environ        func() []string
	Stderr         io.Writer
	Timeout        time.Duration
	AcquireTimeout time.Duration
}

func NewCodexLauncher() CodexLauncher {
	client := NewAgentClient("", AgentCodex)
	return CodexLauncher{
		Acquire: func(ctx context.Context, payload AcquirePayload) (AcquireResult, error) {
			return client.Acquire(ctx, payload)
		},
		BindLease:      client.BindLease,
		Release:        client.Release,
		ResolveBinary:  resolveLauncherCodex,
		Execute:        executeOpenCode,
		Environ:        os.Environ,
		Stderr:         os.Stderr,
		Timeout:        DefaultLauncherTimeout,
		AcquireTimeout: DefaultAcquireTimeout,
	}
}

func (l CodexLauncher) Run(ctx context.Context, args []string, cwd string) error {
	if cwd == "" {
		cwd, _ = os.Getwd()
	}
	plan := PlanCodex(args, cwd)
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
		l.ResolveBinary = resolveLauncherCodex
	}
	if l.Timeout <= 0 {
		l.Timeout = DefaultLauncherTimeout
	}
	if l.AcquireTimeout <= 0 {
		l.AcquireTimeout = l.Timeout
	}

	if plan.Mode == LaunchNative {
		binary, err := l.ResolveBinary()
		if err != nil {
			return err
		}
		return l.Execute(ExecSpec{Path: binary, Args: plan.NativeArgs, Env: l.Environ(), Dir: plan.CWD})
	}

	acquire := l.Acquire
	if acquire == nil {
		acquire = NewCodexLauncher().Acquire
	}
	requestCtx, cancel := context.WithTimeout(ctx, l.AcquireTimeout)
	result, err := acquire(requestCtx, AcquirePayload{
		CWD: plan.CWD, Intent: plan.Intent, SessionID: plan.SessionID, OperationID: newOperationID(),
	})
	cancel()
	if err != nil || result.Mode != string(LaunchManaged) {
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
		fmt.Fprintf(l.Stderr, "pocketctl: managed Codex unavailable; starting native Codex (%s)\n", oneLine(reason))
		binary := result.RealBinary
		if binary == "" {
			binary, err = l.ResolveBinary()
			if err != nil {
				return err
			}
		}
		return l.Execute(ExecSpec{Path: binary, Args: args, Env: l.Environ(), Dir: plan.CWD})
	}
	if result.RealBinary == "" || result.RemoteURI == "" {
		return errors.New("daemon returned an incomplete managed Codex runtime")
	}
	spec := ExecSpec{
		Path: result.RealBinary, Args: plan.ManagedArgs(result.RemoteURI), Env: l.Environ(), Dir: plan.CWD,
	}
	if result.LeaseID != "" {
		bind := l.BindLease
		if bind == nil {
			bind = NewAgentClient("", AgentCodex).BindLease
		}
		spec.OnStart = func(pid int) error {
			bindCtx, bindCancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer bindCancel()
			return bind(bindCtx, LeaseBindPayload{LeaseID: result.LeaseID, PID: pid})
		}
	}
	err = l.Execute(spec)
	if result.LeaseID != "" {
		release := l.Release
		if release == nil {
			release = NewAgentClient("", AgentCodex).Release
		}
		releaseCtx, releaseCancel := context.WithTimeout(context.Background(), 2*time.Second)
		_ = release(releaseCtx, ReleasePayload{LeaseID: result.LeaseID})
		releaseCancel()
	}
	return err
}

func resolveLauncherCodex() (string, error) {
	cfg, err := LoadConfig()
	if err == nil && cfg.Codex.RealBinary != "" {
		resolved, _, inspectErr := inspectExecutable(cfg.Codex.RealBinary)
		if inspectErr == nil && !sameResolvedPath(resolved, cfg.Codex.ShimPath) && !sameResolvedPath(resolved, defaultCodexShimPath()) {
			return resolved, nil
		}
	}
	path, _, err := ResolveConfiguredCodex()
	return path, err
}

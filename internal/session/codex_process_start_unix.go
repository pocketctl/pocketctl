//go:build !windows

package session

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"sync"
	"syscall"
	"time"

	"github.com/pocketctl/pocketctl/internal/codexapp"
	"github.com/pocketctl/pocketctl/internal/daemon"
)

type codexCommandFactory func(binary, socketPath string) *exec.Cmd

func startCodexAppServer(ctx context.Context, binary, version string, generation uint64) (*codexAppServerRuntime, error) {
	return startCodexAppServerWithFactory(ctx, binary, version, generation, 10*time.Second, func(binary, socketPath string) *exec.Cmd {
		return exec.Command(binary, "app-server", "--listen", "unix://"+socketPath)
	})
}

func adoptCodexAppServer(ctx context.Context, state *daemon.CodexAppServerState) (*codexAppServerRuntime, error) {
	client, err := codexapp.DialUnix(ctx, state.Endpoint)
	if err != nil {
		return nil, err
	}
	var initialized map[string]any
	if err := client.Initialize(ctx, codexInitializeParams(), &initialized); err != nil {
		_ = client.Close()
		return nil, err
	}
	runtime := &codexAppServerRuntime{PID: state.PID, Endpoint: state.Endpoint, RemoteURI: state.RemoteURI, Client: client}
	runtime.Stop = func() error {
		_ = client.Close()
		if err := syscall.Kill(-state.PID, syscall.SIGTERM); err != nil && !errors.Is(err, syscall.ESRCH) {
			return err
		}
		return nil
	}
	return runtime, nil
}

func stopPersistedCodexAppServer(state *daemon.CodexAppServerState) error {
	if state == nil || state.PID <= 0 {
		return fmt.Errorf("invalid Codex app-server handoff")
	}
	if err := syscall.Kill(-state.PID, syscall.SIGTERM); err != nil && !errors.Is(err, syscall.ESRCH) {
		return err
	}
	if state.Endpoint != "" {
		_ = os.Remove(state.Endpoint)
	}
	return nil
}

func startCodexAppServerWithFactory(ctx context.Context, binary, _ string, generation uint64, timeout time.Duration, factory codexCommandFactory) (*codexAppServerRuntime, error) {
	dir, err := codexRuntimeDir()
	if err != nil {
		return nil, err
	}
	socketPath := filepath.Join(dir, fmt.Sprintf("app-%d.sock", generation))
	if err := os.Remove(socketPath); err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	cmd := factory(binary, socketPath)
	cmd.Env = append(cmd.Env, os.Environ()...)
	cmd.Env = append(cmd.Env, "POCKETCTL_CODEX_SOCKET="+socketPath)
	cmd.Stdout, cmd.Stderr = io.Discard, io.Discard
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start Codex app-server: %w", err)
	}
	wait := make(chan error, 1)
	go func() { wait <- cmd.Wait() }()
	var stopOnce sync.Once
	stop := func() error {
		var stopErr error
		stopOnce.Do(func() {
			_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGTERM)
			select {
			case stopErr = <-wait:
			case <-time.After(2 * time.Second):
				_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
				stopErr = <-wait
			}
			_ = os.Remove(socketPath)
		})
		return stopErr
	}

	readyCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	var client *codexapp.Client
	for client == nil {
		select {
		case processErr := <-wait:
			return nil, fmt.Errorf("Codex app-server exited before ready: %w", processErr)
		case <-readyCtx.Done():
			_ = stop()
			return nil, fmt.Errorf("Codex app-server readiness timeout: %w", readyCtx.Err())
		case <-time.After(20 * time.Millisecond):
		}
		info, statErr := os.Stat(socketPath)
		if statErr != nil {
			continue
		}
		if info.Mode()&os.ModeSocket == 0 || info.Mode().Perm() != 0o600 {
			_ = stop()
			return nil, fmt.Errorf("Codex app-server socket must be private (0600)")
		}
		client, err = codexapp.DialUnix(readyCtx, socketPath)
		if err != nil {
			client = nil
			continue
		}
		var initialized map[string]any
		if err = client.Initialize(readyCtx, codexInitializeParams(), &initialized); err != nil {
			_ = client.Close()
			client = nil
		}
	}
	runtime := &codexAppServerRuntime{PID: cmd.Process.Pid, Endpoint: socketPath, RemoteURI: "unix://" + socketPath, Client: client}
	runtime.Stop = func() error {
		_ = client.Close()
		return stop()
	}
	return runtime, nil
}

func codexRuntimeDir() (string, error) {
	if configured := os.Getenv("POCKETCTL_CODEX_RUNTIME_DIR"); configured != "" {
		if !filepath.IsAbs(configured) {
			return "", fmt.Errorf("POCKETCTL_CODEX_RUNTIME_DIR must be an absolute path")
		}
		if err := os.MkdirAll(configured, 0o700); err != nil {
			return "", err
		}
		if err := os.Chmod(configured, 0o700); err != nil {
			return "", err
		}
		return configured, nil
	}
	base := os.TempDir()
	if runtime.GOOS == "darwin" {
		base = "/private/tmp"
	}
	dir := filepath.Join(base, "pocketctl-"+strconv.Itoa(os.Getuid()), "codex")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	if err := os.Chmod(filepath.Dir(dir), 0o700); err != nil {
		return "", err
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		return "", err
	}
	return dir, nil
}

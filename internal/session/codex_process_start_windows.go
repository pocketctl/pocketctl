//go:build windows

package session

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/pocketctl/pocketctl/internal/codexapp"
	"github.com/pocketctl/pocketctl/internal/daemon"
	"github.com/pocketctl/pocketctl/internal/platform"
	"golang.org/x/sys/windows"
)

var codexWebSocketListenRE = regexp.MustCompile(`listening on:\s*(ws://127\.0\.0\.1:\d+)`)

func startCodexAppServer(ctx context.Context, binary, _ string, _ uint64) (*codexAppServerRuntime, error) {
	cmd := exec.Command(binary, "app-server", "--listen", "ws://127.0.0.1:0")
	cmd.Env = codexAppServerEnv(os.Environ())
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_NO_WINDOW}
	reader, writer := io.Pipe()
	cmd.Stdout, cmd.Stderr = writer, writer
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start Codex app-server: %w", err)
	}
	wait := make(chan error, 1)
	go func() {
		wait <- cmd.Wait()
		_ = writer.Close()
	}()
	endpointCh := make(chan string, 1)
	go func() {
		scanner := bufio.NewScanner(reader)
		scanner.Buffer(make([]byte, 64<<10), 1<<20)
		for scanner.Scan() {
			if match := codexWebSocketListenRE.FindStringSubmatch(scanner.Text()); len(match) == 2 {
				select {
				case endpointCh <- match[1]:
				default:
				}
			}
		}
	}()

	readyCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	var endpoint string
	select {
	case endpoint = <-endpointCh:
	case err := <-wait:
		return nil, fmt.Errorf("Codex app-server exited before ready: %w", err)
	case <-readyCtx.Done():
		_ = platform.NewProcessController().Kill(cmd.Process.Pid)
		return nil, fmt.Errorf("Codex app-server readiness timeout: %w", readyCtx.Err())
	}
	client, err := codexapp.DialWebSocket(readyCtx, endpoint, nil)
	if err != nil {
		_ = platform.NewProcessController().Kill(cmd.Process.Pid)
		return nil, err
	}
	if err := initializeCodexWindowsClient(readyCtx, client); err != nil {
		_ = client.Close()
		_ = platform.NewProcessController().Kill(cmd.Process.Pid)
		return nil, err
	}
	var stopOnce sync.Once
	stop := func() error {
		var stopErr error
		stopOnce.Do(func() {
			_ = client.Close()
			if platform.NewProcessController().IsAlive(cmd.Process.Pid) {
				stopErr = platform.NewProcessController().Kill(cmd.Process.Pid)
			}
			select {
			case <-wait:
			case <-time.After(2 * time.Second):
			}
		})
		return stopErr
	}
	return &codexAppServerRuntime{PID: cmd.Process.Pid, Endpoint: endpoint, RemoteURI: endpoint, Client: client, Stop: stop}, nil
}

func adoptCodexAppServer(ctx context.Context, state *daemon.CodexAppServerState) (*codexAppServerRuntime, error) {
	if state == nil || !strings.HasPrefix(state.Endpoint, "ws://127.0.0.1:") {
		return nil, fmt.Errorf("invalid Codex loopback WebSocket handoff")
	}
	client, err := codexapp.DialWebSocket(ctx, state.Endpoint, nil)
	if err != nil {
		return nil, err
	}
	if err := initializeCodexWindowsClient(ctx, client); err != nil {
		_ = client.Close()
		return nil, err
	}
	return &codexAppServerRuntime{
		PID: state.PID, Endpoint: state.Endpoint, RemoteURI: state.RemoteURI, Client: client,
		Stop: func() error {
			_ = client.Close()
			if !platform.NewProcessController().IsAlive(state.PID) {
				return nil
			}
			return platform.NewProcessController().Kill(state.PID)
		},
	}, nil
}

func stopPersistedCodexAppServer(state *daemon.CodexAppServerState) error {
	if state == nil || state.PID <= 0 {
		return fmt.Errorf("invalid Codex app-server handoff")
	}
	if !platform.NewProcessController().IsAlive(state.PID) {
		return nil
	}
	return platform.NewProcessController().Kill(state.PID)
}

func initializeCodexWindowsClient(ctx context.Context, client *codexapp.Client) error {
	var initialized map[string]any
	return client.Initialize(ctx, codexInitializeParams(), &initialized)
}

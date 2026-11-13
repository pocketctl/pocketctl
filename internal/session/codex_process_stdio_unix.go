//go:build !windows

package session

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"sync"
	"syscall"
	"time"

	"github.com/pocketctl/pocketctl/internal/codexapp"
	"github.com/pocketctl/pocketctl/internal/platform"
)

func codexPrivateProjectStarter(home string) codexRuntimeStarter {
	return func(ctx context.Context, binary, _ string, generation uint64) (*codexAppServerRuntime, error) {
		dir, err := codexRuntimeDir()
		if err != nil {
			return nil, err
		}
		cmd := exec.Command(binary, "app-server", "-c", "thread_unload_delay_secs=0", "--listen", "stdio://")
		if home != "" {
			cmd.Env = []string{"CODEX_HOME=" + home}
		}
		return startCodexStdioProcess(ctx, cmd, dir, generation)
	}
}

func startCodexStdioProcess(ctx context.Context, cmd *exec.Cmd, dir string, generation uint64) (*codexAppServerRuntime, error) {
	cmd.Dir = dir
	cmd.Env = codexAppServerEnv(codexCommandEnvironment(os.Environ(), cmd.Env))
	var err error
	cmd.Args, cmd.Env, err = applyManagedTaskToolsCommand("codex", cmd.Args, cmd.Env)
	if err != nil {
		return nil, err
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.WaitDelay = time.Second
	stderr := &codexStartupStderr{}
	cmd.Stderr = stderr
	phase := "start"
	defer func() { stderr.finish(phase, generation) }()
	childInput, parentInput, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	defer childInput.Close()
	parentOutput, childOutput, err := os.Pipe()
	if err != nil {
		_ = parentInput.Close()
		return nil, err
	}
	defer childOutput.Close()
	cmd.Stdin, cmd.Stdout = childInput, childOutput
	if err := cmd.Start(); err != nil {
		_ = parentInput.Close()
		_ = parentOutput.Close()
		return nil, fmt.Errorf("start Codex stdio app-server: %w", err)
	}
	_ = childInput.Close()
	_ = childOutput.Close()
	pid := cmd.Process.Pid
	identity, err := platform.ProcessStartIdentity(pid)
	if err != nil || identity == "" {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		_ = parentInput.Close()
		_ = parentOutput.Close()
		return nil, fmt.Errorf("identify Codex stdio app-server: %w", errors.Join(err, errors.New("unavailable process identity")))
	}
	client := codexapp.NewStdioClient(parentOutput, parentInput)
	done := make(chan struct{})
	go func() {
		_ = cmd.Wait()
		close(done)
	}()
	var once sync.Once
	var stopErr error
	stop := func() error {
		once.Do(func() {
			_ = client.Close()
			timer := time.NewTimer(time.Second)
			defer timer.Stop()
			select {
			case <-done:
			case <-timer.C:
				if codexProcessBirthMatches(pid, identity) {
					if err := syscall.Kill(-pid, syscall.SIGKILL); err != nil && !errors.Is(err, syscall.ESRCH) {
						stopErr = err
						return
					}
				}
				timer.Reset(2 * time.Second)
				select {
				case <-done:
				case <-timer.C:
					stopErr = errors.New("Codex stdio app-server did not exit")
				}
			}
		})
		return stopErr
	}
	phase = "initialize"
	ready, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := client.Initialize(ready, codexInitializeParams(), nil); err != nil {
		return nil, errors.Join(fmt.Errorf("initialize Codex stdio app-server: %w", err), stop())
	}
	phase = ""
	return &codexAppServerRuntime{PID: pid, ProcessStartIdentity: identity, PrivateStdio: true, Client: client, Stop: stop}, nil
}

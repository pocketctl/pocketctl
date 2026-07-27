package agentcontrol

import (
	"bytes"
	"context"
	"reflect"
	"testing"
	"time"
)

func TestCodexLauncherAppendsOfficialRemoteAndUsesCodexAcquire(t *testing.T) {
	repo := t.TempDir()
	var payload AcquirePayload
	var executed ExecSpec
	launcher := CodexLauncher{
		Acquire: func(_ context.Context, got AcquirePayload) (AcquireResult, error) {
			payload = got
			return AcquireResult{
				Mode: string(LaunchManaged), RemoteURI: "unix:///tmp/pocketctl-codex.sock",
				RealBinary: "/real/codex", LeaseID: "lease-codex",
			}, nil
		},
		BindLease: func(context.Context, LeaseBindPayload) error { return nil },
		Release:   func(context.Context, ReleasePayload) error { return nil },
		Execute:   func(spec ExecSpec) error { executed = spec; return nil },
		Environ:   func() []string { return []string{"HOME=/tmp/home"} },
	}
	if err := launcher.Run(context.Background(), []string{"resume", "thread-1"}, repo); err != nil {
		t.Fatal(err)
	}
	if payload.Intent != IntentResume || payload.SessionID != "thread-1" || payload.CWD != repo {
		t.Fatalf("payload=%+v", payload)
	}
	want := []string{"resume", "thread-1", "--remote", "unix:///tmp/pocketctl-codex.sock"}
	if executed.Path != "/real/codex" || !reflect.DeepEqual(executed.Args, want) {
		t.Fatalf("exec=%+v want args=%v", executed, want)
	}
	if !reflect.DeepEqual(executed.Env, []string{"HOME=/tmp/home"}) {
		t.Fatalf("unexpected environment mutation: %v", executed.Env)
	}
}

func TestCodexLauncherDaemonUnavailableFallsBackQuickly(t *testing.T) {
	var executed ExecSpec
	var stderr bytes.Buffer
	launcher := CodexLauncher{
		Acquire: func(ctx context.Context, _ AcquirePayload) (AcquireResult, error) {
			<-ctx.Done()
			return AcquireResult{}, ctx.Err()
		},
		ResolveBinary: func() (string, error) { return "/native/codex", nil },
		Execute:       func(spec ExecSpec) error { executed = spec; return nil },
		Environ:       func() []string { return []string{"HOME=/tmp/home"} },
		Stderr:        &stderr,
		Timeout:       50 * time.Millisecond,
	}
	start := time.Now()
	if err := launcher.Run(context.Background(), []string{"hello"}, "/repo"); err != nil {
		t.Fatal(err)
	}
	if elapsed := time.Since(start); elapsed > 250*time.Millisecond {
		t.Fatalf("fallback took %v", elapsed)
	}
	if executed.Path != "/native/codex" || !reflect.DeepEqual(executed.Args, []string{"hello"}) {
		t.Fatalf("exec=%+v", executed)
	}
}

func TestCodexLauncherNativeCommandNeverAcquires(t *testing.T) {
	called := false
	var executed ExecSpec
	launcher := CodexLauncher{
		Acquire: func(context.Context, AcquirePayload) (AcquireResult, error) {
			called = true
			return AcquireResult{}, nil
		},
		ResolveBinary: func() (string, error) { return "/native/codex", nil },
		Execute:       func(spec ExecSpec) error { executed = spec; return nil },
	}
	if err := launcher.Run(context.Background(), []string{"exec", "--json", "hello"}, "/repo"); err != nil {
		t.Fatal(err)
	}
	if called || !reflect.DeepEqual(executed.Args, []string{"exec", "--json", "hello"}) {
		t.Fatalf("called=%v exec=%+v", called, executed)
	}
}

package agentcontrol

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestOpenCodeLauncherDaemonUnavailableFallsBack(t *testing.T) {
	repo := t.TempDir()
	var executed ExecSpec
	var stderr bytes.Buffer
	launcher := Launcher{
		Acquire: func(ctx context.Context, _ AcquirePayload) (AcquireResult, error) {
			<-ctx.Done()
			return AcquireResult{}, ctx.Err()
		},
		ResolveBinary: func() (string, error) { return "/real/opencode", nil },
		Execute:       func(spec ExecSpec) error { executed = spec; return nil },
		Stderr:        &stderr,
		Timeout:       200 * time.Millisecond,
		Environ:       func() []string { return []string{"HOME=/tmp/home", "TERM=xterm"} },
	}

	started := time.Now()
	err := launcher.Run(context.Background(), []string{"-c"}, repo)
	if err != nil {
		t.Fatal(err)
	}
	if elapsed := time.Since(started); elapsed > 300*time.Millisecond {
		t.Fatalf("fallback took %v", elapsed)
	}
	if executed.Path != "/real/opencode" || !reflect.DeepEqual(executed.Args, []string{"-c"}) || executed.Dir != repo {
		t.Fatalf("exec=%+v", executed)
	}
	if !reflect.DeepEqual(executed.Env, []string{"HOME=/tmp/home", "TERM=xterm"}) {
		t.Fatalf("env=%q", executed.Env)
	}
	if lines := strings.Count(strings.TrimSpace(stderr.String()), "\n"); lines > 0 {
		t.Fatalf("fallback warning must be one line: %q", stderr.String())
	}
}

func TestOpenCodeLauncherDefaultAllowsManagedPreparationPastConnectBudget(t *testing.T) {
	launcher := NewLauncher()
	var executed ExecSpec
	launcher.Acquire = func(ctx context.Context, _ AcquirePayload) (AcquireResult, error) {
		select {
		case <-time.After(2 * DefaultLauncherTimeout):
			return AcquireResult{Mode: string(LaunchManaged), BaseURL: "http://127.0.0.1:4096", RealBinary: "/daemon/opencode"}, nil
		case <-ctx.Done():
			return AcquireResult{}, ctx.Err()
		}
	}
	launcher.ResolveBinary = func() (string, error) { return "/native/opencode", nil }
	launcher.Execute = func(spec ExecSpec) error { executed = spec; return nil }
	launcher.Environ = func() []string { return []string{"HOME=/tmp/home"} }
	launcher.Stderr = io.Discard

	if err := launcher.Run(context.Background(), nil, "/repo"); err != nil {
		t.Fatal(err)
	}
	if executed.Path != "/daemon/opencode" || len(executed.Args) == 0 || executed.Args[0] != "attach" {
		t.Fatalf("slow managed preparation fell back to native: %+v", executed)
	}
}

func TestOpenCodeLauncherNativePlanDoesNotDial(t *testing.T) {
	called := false
	var executed ExecSpec
	launcher := Launcher{
		Acquire: func(context.Context, AcquirePayload) (AcquireResult, error) {
			called = true
			return AcquireResult{}, nil
		},
		ResolveBinary: func() (string, error) { return "/real/opencode", nil },
		Execute:       func(spec ExecSpec) error { executed = spec; return nil },
		Environ:       os.Environ,
	}
	if err := launcher.Run(context.Background(), []string{"serve", "--port", "0"}, "/repo"); err != nil {
		t.Fatal(err)
	}
	if called || !reflect.DeepEqual(executed.Args, []string{"serve", "--port", "0"}) {
		t.Fatalf("called=%v exec=%+v", called, executed)
	}
}

func TestOpenCodeLauncherManagedAttachKeepsPasswordOutOfArgs(t *testing.T) {
	repo := t.TempDir()
	var payload AcquirePayload
	var executed ExecSpec
	launcher := Launcher{
		Acquire: func(_ context.Context, got AcquirePayload) (AcquireResult, error) {
			payload = got
			return AcquireResult{Mode: string(LaunchManaged), BaseURL: "http://127.0.0.1:4096", Password: "secret", Username: "pocketctl", RealBinary: "/daemon/opencode", ResolvedSessionID: "ses_1"}, nil
		},
		ResolveBinary: func() (string, error) { return "/fallback/opencode", nil },
		Execute:       func(spec ExecSpec) error { executed = spec; return nil },
		Environ:       func() []string { return []string{"HOME=/tmp/home", "OPENCODE_SERVER_PASSWORD=old"} },
	}
	if err := launcher.Run(context.Background(), []string{"-s", "ses_1"}, repo); err != nil {
		t.Fatal(err)
	}
	if payload.Intent != IntentResume || payload.SessionID != "ses_1" || payload.CWD != repo || payload.OperationID == "" {
		t.Fatalf("payload=%+v", payload)
	}
	if executed.Path != "/daemon/opencode" || strings.Contains(strings.Join(executed.Args, " "), "secret") {
		t.Fatalf("exec=%+v", executed)
	}
	if got := envValue(executed.Env, "OPENCODE_SERVER_PASSWORD"); got != "secret" {
		t.Fatalf("password env=%q", got)
	}
	if got := envValue(executed.Env, "OPENCODE_SERVER_USERNAME"); got != "pocketctl" {
		t.Fatalf("username env=%q", got)
	}
}

func TestOpenCodeLauncherManagedProcessBindsAndReleasesLease(t *testing.T) {
	var bound LeaseBindPayload
	var released ReleasePayload
	launcher := Launcher{
		Acquire: func(context.Context, AcquirePayload) (AcquireResult, error) {
			return AcquireResult{Mode: string(LaunchManaged), BaseURL: "http://127.0.0.1:4096", RealBinary: "/daemon/opencode", LeaseID: "lease-1"}, nil
		},
		BindLease: func(_ context.Context, payload LeaseBindPayload) error { bound = payload; return nil },
		Release:   func(_ context.Context, payload ReleasePayload) error { released = payload; return nil },
		Execute: func(spec ExecSpec) error {
			if spec.OnStart == nil {
				t.Fatal("managed execution has no child lease binder")
			}
			return spec.OnStart(4321)
		},
		Environ: os.Environ,
	}
	if err := launcher.Run(context.Background(), nil, "/repo"); err != nil {
		t.Fatal(err)
	}
	if bound.LeaseID != "lease-1" || bound.PID != 4321 {
		t.Fatalf("bound=%+v", bound)
	}
	if released.LeaseID != "lease-1" {
		t.Fatalf("released=%+v", released)
	}
}

func TestOpenCodeLauncherNativeResponseDoesNotLeakCredentials(t *testing.T) {
	var executed ExecSpec
	launcher := Launcher{
		Acquire: func(context.Context, AcquirePayload) (AcquireResult, error) {
			return AcquireResult{Mode: string(LaunchNative), RealBinary: "/real/opencode", Password: "must-not-leak", Reason: "disabled"}, nil
		},
		ResolveBinary: func() (string, error) { return "", errors.New("should not resolve") },
		Execute:       func(spec ExecSpec) error { executed = spec; return nil },
		Environ:       func() []string { return []string{"HOME=/tmp/home"} },
	}
	if err := launcher.Run(context.Background(), []string{"-c"}, "/repo"); err != nil {
		t.Fatal(err)
	}
	if executed.Path != "/real/opencode" || envValue(executed.Env, "OPENCODE_SERVER_PASSWORD") != "" {
		t.Fatalf("exec=%+v", executed)
	}
}

func TestOpenCodeLauncherRecordsOnlyClassifiedFallback(t *testing.T) {
	var category string
	var stderr bytes.Buffer
	launcher := Launcher{
		Acquire: func(context.Context, AcquirePayload) (AcquireResult, error) {
			return AcquireResult{}, &ProtocolError{Code: ErrSessionBusy, Message: "an unmanaged OpenCode process is still active"}
		},
		RecordFallback: func(value string) { category = value },
		ResolveBinary:  func() (string, error) { return "/real/opencode", nil },
		Execute:        func(ExecSpec) error { return nil },
		Environ:        os.Environ,
		Stderr:         &stderr,
	}
	if err := launcher.Run(context.Background(), []string{"-c"}, "/repo"); err != nil {
		t.Fatal(err)
	}
	if category != FallbackSessionBusy {
		t.Fatalf("fallback telemetry category=%q", category)
	}
	if !strings.Contains(stderr.String(), "an unmanaged OpenCode process is still active") || strings.Contains(stderr.String(), "daemon unavailable") {
		t.Fatalf("fallback diagnostic=%q", stderr.String())
	}
}

func envValue(env []string, key string) string {
	prefix := key + "="
	for _, item := range env {
		if strings.HasPrefix(item, prefix) {
			return strings.TrimPrefix(item, prefix)
		}
	}
	return ""
}

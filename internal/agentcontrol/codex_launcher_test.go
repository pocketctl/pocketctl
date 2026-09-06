package agentcontrol

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func TestCodexLauncherAppendsOfficialRemoteAndUsesCodexAcquire(t *testing.T) {
	repo := t.TempDir()
	daemonBinary := validatedTestExecutable(t, "daemon-codex")
	var payload AcquirePayload
	var executed ExecSpec
	launcher := CodexLauncher{
		Acquire: func(_ context.Context, got AcquirePayload) (AcquireResult, error) {
			payload = got
			return AcquireResult{
				Mode: string(LaunchManaged), RemoteURI: "unix:///tmp/pocketctl-codex.sock",
				RealBinary: daemonBinary, LeaseID: "lease-codex",
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
	if executed.Path != daemonBinary || !reflect.DeepEqual(executed.Args, want) {
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

func TestCodexLauncherStripsInheritedDesktopOriginFromCLIProcess(t *testing.T) {
	realBinary := validatedTestExecutable(t, "real-codex")
	tests := []struct {
		name    string
		args    []string
		acquire func(context.Context, AcquirePayload) (AcquireResult, error)
	}{
		{
			name: "managed",
			acquire: func(context.Context, AcquirePayload) (AcquireResult, error) {
				return AcquireResult{
					Mode: string(LaunchManaged), RemoteURI: "unix:///tmp/pocketctl-codex.sock",
					RealBinary: realBinary,
				}, nil
			},
		},
		{
			name: "daemon fallback",
			acquire: func(context.Context, AcquirePayload) (AcquireResult, error) {
				return AcquireResult{Mode: string(LaunchNative), RealBinary: realBinary, Reason: "disabled"}, nil
			},
		},
		{
			name: "native command",
			args: []string{"exec", "--json", "hello"},
			acquire: func(context.Context, AcquirePayload) (AcquireResult, error) {
				t.Fatal("native command must not acquire a managed session")
				return AcquireResult{}, nil
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var executed ExecSpec
			launcher := CodexLauncher{
				Acquire:       tt.acquire,
				ResolveBinary: func() (string, error) { return realBinary, nil },
				Execute:       func(spec ExecSpec) error { executed = spec; return nil },
				Environ: func() []string {
					return []string{
						"HOME=/tmp/home",
						"CODEX_INTERNAL_ORIGINATOR_OVERRIDE=Codex Desktop",
						"CODEX_INTERNAL_ORIGINATOR_OVERRIDE_SUFFIX=keep",
						"KEEP=yes",
					}
				},
			}

			if err := launcher.Run(context.Background(), tt.args, "/repo"); err != nil {
				t.Fatal(err)
			}
			want := []string{
				"HOME=/tmp/home",
				"CODEX_INTERNAL_ORIGINATOR_OVERRIDE_SUFFIX=keep",
				"KEEP=yes",
			}
			if !reflect.DeepEqual(executed.Env, want) {
				t.Fatalf("Codex CLI environment=%v, want %v", executed.Env, want)
			}
		})
	}
}

func TestCodexLauncherRejectsOwnedShimFromDaemonNativeResponse(t *testing.T) {
	ownedShim := filepath.Join(t.TempDir(), "codex")
	writeShimFixture(t, ownedShim, "#!/bin/sh\n"+launcherMarkerV3Unix+"\nexit 0\n")
	realBinary := testExecutable(t, "real-codex")
	resolved := false
	var executed ExecSpec
	launcher := CodexLauncher{
		Acquire: func(context.Context, AcquirePayload) (AcquireResult, error) {
			return AcquireResult{Mode: string(LaunchNative), RealBinary: ownedShim, Reason: "disabled"}, nil
		},
		ResolveBinary: func() (string, error) {
			resolved = true
			return realBinary, nil
		},
		Execute: func(spec ExecSpec) error { executed = spec; return nil },
		Environ: func() []string {
			return []string{launcherEnvDepth + "=1", launcherEnvRealBinary + "=" + realBinary, "KEEP=yes"}
		},
	}

	if err := launcher.Run(context.Background(), []string{"resume", "thread-1"}, t.TempDir()); err != nil {
		t.Fatal(err)
	}
	if !resolved || executed.Path != realBinary {
		t.Fatalf("resolved=%v exec path=%q, want validated fallback %q", resolved, executed.Path, realBinary)
	}
	if got := executed.Env; !reflect.DeepEqual(got, []string{"KEEP=yes"}) {
		t.Fatalf("internal launcher env leaked: %v", got)
	}
}

func TestCodexLauncherRejectsOwnedShimFromDaemonManagedResponse(t *testing.T) {
	ownedShim := filepath.Join(t.TempDir(), "codex")
	writeShimFixture(t, ownedShim, "#!/bin/sh\n"+launcherMarkerV3Unix+"\nexit 0\n")
	executed := false
	launcher := CodexLauncher{
		Acquire: func(context.Context, AcquirePayload) (AcquireResult, error) {
			return AcquireResult{Mode: string(LaunchManaged), RemoteURI: "unix:///tmp/codex.sock", RealBinary: ownedShim}, nil
		},
		Execute: func(ExecSpec) error { executed = true; return nil },
		Environ: os.Environ,
	}

	if err := launcher.Run(context.Background(), nil, t.TempDir()); err == nil {
		t.Fatal("managed daemon response pointing at an owned shim must fail closed")
	}
	if executed {
		t.Fatal("owned daemon shim was executed")
	}
}

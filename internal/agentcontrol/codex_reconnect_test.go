package agentcontrol

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
)

func reconnectURI(t *testing.T, env []string) string {
	t.Helper()
	id, err := CodexHomeIDFromEnvironment(env)
	if err != nil {
		t.Fatal(err)
	}
	base := os.TempDir()
	if runtime.GOOS == "darwin" {
		base = "/private/tmp"
	}
	return "unix://" + filepath.Join(base, fmt.Sprintf("pocketctl-%d", os.Getuid()), "codex", "app-"+strings.TrimPrefix(id, "codex-home-")[:12]+"-2.sock")
}

func TestCodexReconnectPreservesTargetAndArguments(t *testing.T) {
	env := []string{"HOME=" + t.TempDir()}
	old := reconnectURI(t, env)
	for _, args := range [][]string{
		{"--remote", old, "resume", "thread-2", "--cd", "/repo with spaces"},
		{"resume", "thread-2", "--remote=" + old, "--cd", "/repo with spaces"},
		{"resume", "thread-2", "--remote", old, "--", "--remote=prompt text"},
		{"--remote=" + old, "agents"},
	} {
		t.Run(strings.Join(args, " "), func(t *testing.T) {
			plan, handled, err := planCodexReconnect(args, t.TempDir(), env)
			if err != nil || !handled || plan.Mode != LaunchManaged {
				t.Fatalf("plan=%+v handled=%v err=%v", plan, handled, err)
			}
			want := []string{"resume", "thread-2", "--cd", "/repo with spaces", "--remote", "unix:///new.sock"}
			if args[len(args)-1] == "--remote=prompt text" {
				want = []string{"resume", "thread-2", "--remote", "unix:///new.sock", "--", "--remote=prompt text"}
			}
			if args[len(args)-1] == "agents" {
				want = []string{"agents", "--remote", "unix:///new.sock"}
			}
			if got := plan.ManagedArgs("unix:///new.sock"); !reflect.DeepEqual(got, want) {
				t.Fatalf("args=%q want=%q", got, want)
			}
		})
	}
}

func TestCodexReconnectLeavesExternalEndpointsAndNativeCommandsUntouched(t *testing.T) {
	env := []string{"HOME=" + t.TempDir()}
	old := reconnectURI(t, env)
	binary := validatedTestExecutable(t, "codex")
	for _, args := range [][]string{
		{"--remote", "unix:///external/app-123456abcdef-2.sock", "resume", "thread"},
		{"--remote=ws://localhost:1234", "agents"},
		{"--remote", strings.Replace(old, "app-", "external-", 1), "agents"},
		{"--remote", strings.Replace(old, fmt.Sprintf("pocketctl-%d", os.Getuid()), fmt.Sprintf("pocketctl-%d", os.Getuid()+1), 1), "agents"},
		{"--remote", old, "exec", "hello"},
		{"--native", "--remote", old, "resume", "thread"},
	} {
		t.Run(strings.Join(args, " "), func(t *testing.T) {
			executed := false
			l := CodexLauncher{
				Environ: func() []string { return env }, ResolveBinary: func() (string, error) { return binary, nil },
				Acquire: func(context.Context, AcquirePayload) (AcquireResult, error) {
					t.Fatal("unexpected acquire")
					return AcquireResult{}, nil
				},
				Execute: func(s ExecSpec) error {
					executed = true
					want := args
					if args[0] == "--native" {
						want = args[1:]
					}
					if !reflect.DeepEqual(s.Args, want) || s.OnStart != nil {
						t.Fatalf("changed native launch: %+v", s)
					}
					return nil
				},
			}
			if err := l.Run(context.Background(), args, t.TempDir()); err != nil || !executed {
				t.Fatalf("executed=%v err=%v", executed, err)
			}
		})
	}
}

func TestCodexReconnectRejectsAmbiguousAccountOrSession(t *testing.T) {
	env := []string{"HOME=" + t.TempDir()}
	old := reconnectURI(t, env)
	other := reconnectURI(t, []string{"HOME=" + t.TempDir()})
	legacy := "unix://" + filepath.Join(filepath.Dir(strings.TrimPrefix(old, "unix://")), "app-2.sock")
	for _, tc := range []struct{ uri, session, reason string }{
		{other, "thread", "different CODEX_HOME"},
		{legacy, "thread", "no account identity"},
		{old, "--last", "explicit session ID"},
	} {
		t.Run(tc.reason, func(t *testing.T) {
			l := CodexLauncher{Environ: func() []string { return env },
				Acquire: func(context.Context, AcquirePayload) (AcquireResult, error) {
					t.Fatal("unexpected acquire")
					return AcquireResult{}, nil
				},
				ResolveBinary: func() (string, error) { t.Fatal("unexpected native fallback"); return "", nil },
				Execute:       func(ExecSpec) error { t.Fatal("unexpected execution"); return nil },
			}
			err := l.Run(context.Background(), []string{"--remote", tc.uri, "resume", tc.session}, t.TempDir())
			if err == nil || !strings.Contains(err.Error(), tc.reason) {
				t.Fatalf("err=%v", err)
			}
		})
	}
}

func TestCodexReconnectAcquireFailureDoesNotFallBack(t *testing.T) {
	env := []string{"HOME=" + t.TempDir()}
	for _, tc := range []struct {
		name   string
		result AcquireResult
		err    error
	}{
		{"daemon unavailable", AcquireResult{}, errors.New("daemon unavailable")},
		{"deadline", AcquireResult{}, context.DeadlineExceeded},
		{"disabled", AcquireResult{Mode: string(LaunchNative), Reason: "disabled"}, nil},
		{"incomplete", AcquireResult{Mode: string(LaunchManaged)}, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			l := CodexLauncher{Environ: func() []string { return env },
				Acquire:       func(context.Context, AcquirePayload) (AcquireResult, error) { return tc.result, tc.err },
				ResolveBinary: func() (string, error) { t.Fatal("unexpected native fallback"); return "", nil },
				Execute:       func(ExecSpec) error { t.Fatal("unexpected execution"); return nil },
			}
			if err := l.Run(context.Background(), []string{"--remote", reconnectURI(t, env), "agents"}, t.TempDir()); err == nil {
				t.Fatal("expected actionable error")
			}
		})
	}
}

func TestCodexReconnectCustomRuntimeDirectory(t *testing.T) {
	env := []string{"HOME=" + t.TempDir()}
	old := reconnectURI(t, env)
	custom := t.TempDir()
	customURI := "unix://" + filepath.Join(custom, filepath.Base(old))
	env = append(env, "POCKETCTL_CODEX_RUNTIME_DIR="+custom)
	if _, handled, err := planCodexReconnect([]string{"--remote", customURI, "agents"}, t.TempDir(), env); err != nil || !handled {
		t.Fatalf("handled=%v err=%v", handled, err)
	}
	if _, handled, err := planCodexReconnect([]string{"--remote", old, "agents"}, t.TempDir(), env); err != nil || handled {
		t.Fatalf("handled=%v err=%v", handled, err)
	}
	env[len(env)-1] = "POCKETCTL_CODEX_RUNTIME_DIR="
	if _, handled, err := planCodexReconnect([]string{"--remote", old, "agents"}, t.TempDir(), env); err != nil || !handled {
		t.Fatalf("empty override: handled=%v err=%v", handled, err)
	}
}

func TestCodexCopiedReconnectUsesCurrentRuntimeAndLease(t *testing.T) {
	for _, command := range []string{"resume", "agents"} {
		t.Run(command, func(t *testing.T) {
			env := []string{"HOME=" + t.TempDir()}
			old := reconnectURI(t, env)
			binary := validatedTestExecutable(t, "codex")
			bound, released, executed := false, false, false
			args := []string{"--remote", old, command}
			if command == "resume" {
				args = append(args, "new-thread")
			}
			l := CodexLauncher{Environ: func() []string { return env }, ResolveBinary: func() (string, error) { return binary, nil },
				Acquire: func(_ context.Context, p AcquirePayload) (AcquireResult, error) {
					if command == "resume" && (p.SessionID != "new-thread" || p.Intent != IntentResume) {
						t.Fatalf("lost resume target: %+v", p)
					}
					id, _ := CodexHomeIDFromEnvironment(env)
					if p.CodexHomeID != id {
						t.Fatal("changed home")
					}
					return AcquireResult{Mode: string(LaunchManaged), RemoteURI: "unix:///current.sock", RealBinary: binary, LeaseID: "lease"}, nil
				},
				BindLease: func(_ context.Context, p LeaseBindPayload) error {
					bound = p.LeaseID == "lease" && p.PID == 123
					return nil
				}, Release: func(_ context.Context, p ReleasePayload) error { released = p.LeaseID == "lease"; return nil },
				Execute: func(s ExecSpec) error {
					executed = true
					if strings.Contains(strings.Join(s.Args, " "), old) || !strings.Contains(strings.Join(s.Args, " "), "unix:///current.sock") {
						t.Errorf("stale endpoint forwarded: %v", s.Args)
					}
					if s.OnStart == nil {
						t.Error("no lease binding")
						return nil
					}
					return s.OnStart(123)
				}}
			if err := l.Run(context.Background(), args, t.TempDir()); err != nil {
				t.Fatal(err)
			}
			if !executed || !bound || !released {
				t.Fatalf("exec=%v bound=%v released=%v", executed, bound, released)
			}
		})
	}
}

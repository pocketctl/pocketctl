package agentcontrol

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func TestResolveOpenCodeUsesStoredRealBinary(t *testing.T) {
	stored := testExecutable(t, "stored-opencode")
	resolver := BinaryResolver{
		Timeout: time.Second,
		ResolveAgent: func(string, ...string) (string, bool, bool) {
			t.Fatal("fallback discovery should not run")
			return "", false, false
		},
		RunVersion: func(_ context.Context, path string) (string, error) {
			if !sameFile(path, stored) {
				t.Fatalf("version path=%q want %q", path, stored)
			}
			return "opencode 1.17.11", nil
		},
	}
	got, version, err := resolver.ResolveOpenCode(AgentConfig{RealBinary: stored})
	if err != nil {
		t.Fatal(err)
	}
	if !sameFile(got, stored) || version != "1.17.11" {
		t.Fatalf("got path=%q version=%q", got, version)
	}
}

func TestSupportsManagedOpenCodeVersion(t *testing.T) {
	tests := map[string]bool{
		"1.17.10":        false,
		"1.17.11":        true,
		"1.17.11-beta.1": true,
		"1.18.0":         true,
		"2.0.0":          true,
		"1.9.99":         false,
		"invalid":        false,
	}
	for version, want := range tests {
		if got := SupportsManagedOpenCodeVersion(version); got != want {
			t.Fatalf("version %q supported=%v, want %v", version, got, want)
		}
	}
}

func TestResolveOpenCodeDeletedStoredPathFallsBackExcludingShim(t *testing.T) {
	real := testExecutable(t, "real-opencode")
	shim := testExecutable(t, "pocketctl-shim")
	var exclusions []string
	resolver := BinaryResolver{
		Timeout: time.Second,
		ResolveAgent: func(name string, excluded ...string) (string, bool, bool) {
			if name != AgentOpenCode {
				t.Fatalf("name=%q", name)
			}
			exclusions = append([]string(nil), excluded...)
			return real, true, true
		},
		RunVersion: func(context.Context, string) (string, error) { return "1.17.11", nil },
	}
	got, _, err := resolver.ResolveOpenCode(AgentConfig{RealBinary: filepath.Join(t.TempDir(), "missing"), ShimPath: shim})
	if err != nil {
		t.Fatal(err)
	}
	if !sameFile(got, real) || !containsSamePath(exclusions, shim) {
		t.Fatalf("got=%q exclusions=%v", got, exclusions)
	}
}

func TestResolveOpenCodeRejectsShimAndUnexecutableBinary(t *testing.T) {
	shim := testExecutable(t, "shim")
	resolver := BinaryResolver{
		Timeout: time.Second,
		ResolveAgent: func(string, ...string) (string, bool, bool) {
			return shim, true, true
		},
		RunVersion: func(context.Context, string) (string, error) { return "1.17.11", nil },
	}
	if _, _, err := resolver.ResolveOpenCode(AgentConfig{ShimPath: shim}); !errors.Is(err, ErrOpenCodeNotFound) {
		t.Fatalf("shim error=%v, want ErrOpenCodeNotFound", err)
	}

	if runtime.GOOS == "windows" {
		return
	}
	notExecutable := filepath.Join(t.TempDir(), "opencode")
	if err := os.WriteFile(notExecutable, []byte("binary"), 0o644); err != nil {
		t.Fatal(err)
	}
	resolver.ResolveAgent = func(string, ...string) (string, bool, bool) { return notExecutable, true, true }
	if _, _, err := resolver.ResolveOpenCode(AgentConfig{}); !errors.Is(err, ErrOpenCodeNotExecutable) {
		t.Fatalf("unexecutable error=%v, want ErrOpenCodeNotExecutable", err)
	}
}

func TestResolveOpenCodeVersionTimeout(t *testing.T) {
	bin := testExecutable(t, "slow-opencode")
	resolver := BinaryResolver{
		Timeout: 20 * time.Millisecond,
		ResolveAgent: func(string, ...string) (string, bool, bool) {
			return bin, true, true
		},
		RunVersion: func(ctx context.Context, _ string) (string, error) {
			<-ctx.Done()
			return "", ctx.Err()
		},
	}
	start := time.Now()
	_, _, err := resolver.ResolveOpenCode(AgentConfig{})
	if !errors.Is(err, ErrOpenCodeVersionTimeout) {
		t.Fatalf("error=%v, want timeout", err)
	}
	if elapsed := time.Since(start); elapsed > 250*time.Millisecond {
		t.Fatalf("timeout took %v", elapsed)
	}
}

func testExecutable(t *testing.T, name string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(path, []byte("binary"), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

func containsSamePath(paths []string, want string) bool {
	for _, path := range paths {
		if sameFile(path, want) {
			return true
		}
	}
	return false
}

func sameFile(left, right string) bool {
	leftInfo, leftErr := os.Stat(left)
	rightInfo, rightErr := os.Stat(right)
	return leftErr == nil && rightErr == nil && os.SameFile(leftInfo, rightInfo)
}

package agentcontrol

import (
	"os"
	"testing"
)

func TestOpenCodeTelemetryStoresOnlyEnumeratedCounters(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	if err := RecordOpenCodeFallback(FallbackDaemonUnavailable); err != nil {
		t.Fatal(err)
	}
	if err := RecordOpenCodeFallback(FallbackDaemonUnavailable); err != nil {
		t.Fatal(err)
	}
	if err := RecordOpenCodeFallback("prompt text must never become a key"); err == nil {
		t.Fatal("arbitrary fallback reason was accepted")
	}
	if err := RecordOpenCodeRuntimeHealth(true); err != nil {
		t.Fatal(err)
	}
	if err := RecordOpenCodeRuntimeHealth(false); err != nil {
		t.Fatal(err)
	}

	snapshot, err := LoadOpenCodeTelemetry()
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.FallbackReasons[FallbackDaemonUnavailable] != 2 || len(snapshot.FallbackReasons) != 1 {
		t.Fatalf("fallback counters=%v", snapshot.FallbackReasons)
	}
	if snapshot.HealthOK != 1 || snapshot.HealthFailed != 1 {
		t.Fatalf("health counters=%+v", snapshot)
	}
	info, err := os.Stat(openCodeTelemetryPath())
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("telemetry mode=%o", info.Mode().Perm())
	}
}

func TestClassifyOpenCodeFallbackDoesNotRetainErrorText(t *testing.T) {
	if got := classifyOpenCodeFallback(nil, AcquireResult{Mode: string(LaunchNative)}); got != FallbackNativeResponse {
		t.Fatalf("native response category=%q", got)
	}
	if got := classifyOpenCodeFallback(&ProtocolError{Code: ErrSessionBusy, Message: "private cwd and prompt"}, AcquireResult{}); got != FallbackSessionBusy {
		t.Fatalf("session busy category=%q", got)
	}
	if got := classifyOpenCodeFallback(os.ErrNotExist, AcquireResult{}); got != FallbackDaemonUnavailable {
		t.Fatalf("untyped error category=%q", got)
	}
}

package protocol

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestSessionControlModeWireContract(t *testing.T) {
	if ControlManaged != "managed" || ControlUnmanagedActive != "unmanaged_active" || ControlLegacyReadOnly != "legacy_read_only" {
		t.Fatalf("control modes changed: %q %q %q", ControlManaged, ControlUnmanagedActive, ControlLegacyReadOnly)
	}
	event := DaemonEvent{Type: "session_discovered", SessionID: "ses_1", ControlMode: ControlManaged, Capabilities: []string{"shared_runtime", "terminal_coapproval", "questions"}}
	raw, err := json.Marshal(event)
	if err != nil {
		t.Fatal(err)
	}
	wire := string(raw)
	for _, want := range []string{`"control_mode":"managed"`, `"shared_runtime"`, `"terminal_coapproval"`} {
		if !strings.Contains(wire, want) {
			t.Fatalf("wire=%s missing %s", wire, want)
		}
	}
}

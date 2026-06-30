package main

import (
	"testing"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

func TestUpgradeGateDecision(t *testing.T) {
	cases := []struct {
		name        string
		found       bool
		manageable  bool
		agentName   string
		path        string
		wantProceed bool
		wantStatus  string
		wantReason  string
		wantErr     string
	}{
		{
			name:        "not installed",
			found:       false,
			manageable:  false,
			agentName:   "claude-code",
			path:        "",
			wantProceed: false,
			wantStatus:  "failed",
			wantReason:  "",
			wantErr:     "claude-code 未安装",
		},
		{
			name:        "system root-owned install",
			found:       true,
			manageable:  false,
			agentName:   "claude-code",
			path:        "/usr/local/bin/claude",
			wantProceed: false,
			wantStatus:  "failed",
			wantReason:  protocol.ReasonPermissionDenied,
			wantErr:     "/usr/local/bin/claude 为系统(root)安装，pocketctl 无法升级，请自行 sudo-free 升级",
		},
		{
			name:        "manageable user install proceeds",
			found:       true,
			manageable:  true,
			agentName:   "claude-code",
			path:        "/Users/me/.local/bin/claude",
			wantProceed: true,
			wantStatus:  "",
			wantReason:  "",
			wantErr:     "",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			proceed, status, reason, errMsg := upgradeGateDecision(tc.found, tc.manageable, tc.agentName, tc.path)
			if proceed != tc.wantProceed {
				t.Errorf("proceed = %v, want %v", proceed, tc.wantProceed)
			}
			if status != tc.wantStatus {
				t.Errorf("status = %q, want %q", status, tc.wantStatus)
			}
			if reason != tc.wantReason {
				t.Errorf("reason = %q, want %q", reason, tc.wantReason)
			}
			if errMsg != tc.wantErr {
				t.Errorf("errMsg = %q, want %q", errMsg, tc.wantErr)
			}
		})
	}

	// reason must be permission_denied ONLY for the !manageable case.
	if _, _, reason, _ := upgradeGateDecision(false, false, "x", ""); reason != "" {
		t.Errorf("!found reason should be empty, got %q", reason)
	}
	if _, _, reason, _ := upgradeGateDecision(true, false, "x", "/p"); reason != protocol.ReasonPermissionDenied {
		t.Errorf("!manageable reason should be permission_denied, got %q", reason)
	}
}

func TestIsPermissionDenied(t *testing.T) {
	for _, s := range []string{"npm ERR! EACCES", "Error: EPERM", "permission denied", "Insufficient permissions"} {
		if !isPermissionDenied(s) {
			t.Errorf("expected permission-denied for %q", s)
		}
	}
	for _, s := range []string{"network timeout", "404 not found", ""} {
		if isPermissionDenied(s) {
			t.Errorf("unexpected permission-denied for %q", s)
		}
	}
}

// TestStartSpinnerNonTTY verifies the spinner degrades cleanly when stdout is
// not a terminal: it prints the message once (no escape codes), and the
// returned stop function is safe to call.
func TestStartSpinnerNonTTY(t *testing.T) {
	// In `go test`, os.Stdout is a pipe (not a char device), so startSpinner
	// takes the non-TTY branch.
	stop := startSpinner("starting test")
	if stop == nil {
		t.Fatal("startSpinner returned nil stop func")
	}
	stop() // must not panic or block
}

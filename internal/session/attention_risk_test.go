package session

import (
	"reflect"
	"testing"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

func TestTrustedActionPolicyModeFailsClosed(t *testing.T) {
	tests := []struct {
		raw  string
		want trustedActionPolicyMode
	}{
		{"", trustedActionPolicyOff},
		{"off", trustedActionPolicyOff},
		{" OBSERVE ", trustedActionPolicyObserve},
		{"on", trustedActionPolicyOn},
		{"invalid", trustedActionPolicyOff},
	}
	for _, tt := range tests {
		if got := parseTrustedActionPolicyMode(tt.raw); got != tt.want {
			t.Errorf("parseTrustedActionPolicyMode(%q)=%q want %q", tt.raw, got, tt.want)
		}
	}
}

func TestSessionManagerExplicitTrustedActionPolicyOverridesEnvironment(t *testing.T) {
	t.Setenv("POCKETCTL_TRUSTED_ACTION_POLICY_V1", "observe")
	explicit := NewSessionManagerWithTrustedActionPolicy(make(chan protocol.DaemonEvent, 1), "on")
	if explicit.trustedActionPolicy != trustedActionPolicyOn {
		t.Fatalf("explicit policy=%q want %q", explicit.trustedActionPolicy, trustedActionPolicyOn)
	}
	legacy := NewSessionManager(make(chan protocol.DaemonEvent, 1))
	if legacy.trustedActionPolicy != trustedActionPolicyObserve {
		t.Fatalf("legacy environment policy=%q want %q", legacy.trustedActionPolicy, trustedActionPolicyObserve)
	}
}

func TestTrustedActionPolicyBuildsBoundedIntersection(t *testing.T) {
	tests := []struct {
		name       string
		risk       string
		incomplete bool
		reasons    []string
		native     []string
		want       []string
	}{
		{
			name: "incomplete high removes persistent and unknown actions",
			risk: "high", incomplete: true,
			reasons: []string{protocol.RiskReasonExecutesCommand, protocol.RiskReasonExecutesCommand, "untrusted"},
			native:  []string{"once", "always", "reject", "future", "cancel", "once"},
			want:    []string{"once", "reject", "cancel"},
		},
		{
			name: "complete low retains native persistent scope",
			risk: "low", incomplete: false,
			native: []string{"once", "always", "reject"},
			want:   []string{"once", "always", "reject"},
		},
		{
			name: "complete medium retains native persistent scope",
			risk: "medium", incomplete: false,
			native: []string{"once", "always", "reject"},
			want:   []string{"once", "always", "reject"},
		},
		{
			name: "complete critical remains one shot",
			risk: "critical", incomplete: false,
			native: []string{"once", "always", "reject"},
			want:   []string{"once", "reject"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			context := approvalSecurityContext(tt.risk, tt.incomplete, tt.reasons, tt.native)
			if context.SchemaVersion != 1 || context.RiskLevel != tt.risk || context.ClassificationIncomplete != tt.incomplete {
				t.Fatalf("context facts=%+v", context)
			}
			if !reflect.DeepEqual(context.AllowedActions, tt.want) {
				t.Fatalf("allowed=%v want %v", context.AllowedActions, tt.want)
			}
			if len(context.RiskReasons) > 4 {
				t.Fatalf("risk reasons not bounded: %v", context.RiskReasons)
			}
		})
	}
}

func TestTrustedActionPolicyChecksAdvertisedMembership(t *testing.T) {
	context := approvalSecurityContext("high", true, []string{protocol.RiskReasonExecutesCommand}, []string{"once", "always", "reject"})
	if !approvalActionAllowed(&context, "once") || !approvalActionAllowed(&context, "reject") {
		t.Fatalf("one-shot decisions rejected: %+v", context)
	}
	if approvalActionAllowed(&context, "always") || approvalActionAllowed(nil, "once") {
		t.Fatalf("unadvertised or absent context was accepted: %+v", context)
	}
}

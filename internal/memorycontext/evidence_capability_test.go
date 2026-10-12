package memorycontext

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestEvidenceCapabilityRequiresNativeDeliveryAndLiveProbe(t *testing.T) {
	cases := []struct {
		hidden Capability
		probe  ProbeEvidence
		want   string
	}{
		{CapabilityNativeHiddenV1, ProbeSupported, "on_demand_v1"},
		{CapabilityNativeHiddenV1, ProbeAbsent, "bounded_excerpt_v1"},
		{CapabilityShadowOnly, ProbeSupported, "bounded_excerpt_v1"},
	}
	for _, tc := range cases {
		if got := ResolveEvidenceReadCapability(tc.hidden, tc.probe); got != tc.want {
			t.Fatalf("capability %v got %q want %q", tc.hidden, got, tc.want)
		}
	}
}
func TestLegacyCompileOmitsEvidenceCapability(t *testing.T) {
	data, err := json.Marshal(CompileRequest{SchemaVersion: 1})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "evidence_read_capability") {
		t.Fatal("legacy request must remain capability-byte compatible")
	}
	data, err = json.Marshal(CompileRequest{SchemaVersion: 1, EvidenceReadCapability: "on_demand_v1"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), `"evidence_read_capability":"on_demand_v1"`) {
		t.Fatal("explicit capability missing")
	}
}

func TestCoordinatorEvidenceNegotiationRequiresServerAcknowledgement(t *testing.T) {
	for _, tc := range []struct {
		name                           string
		probe                          ProbeEvidence
		server, wantWire, wantPrepared string
	}{
		{"unprobed", ProbeAbsent, "on_demand_v1", "", "bounded_excerpt_v1"},
		{"old-server", ProbeSupported, "", "on_demand_v1", "bounded_excerpt_v1"},
		{"acknowledged", ProbeSupported, "on_demand_v1", "on_demand_v1", "on_demand_v1"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			requests := make(chan CompileRequest, 1)
			memory := &fakeMemory{compileStarted: requests, compile: &CompileResponse{Outcome: "ready", EvidenceReadCapability: tc.server, Pack: &WirePack{PackID: "p"}, AdmissionRequired: true},
				admit: &AdmitResponse{InjectionID: "inj", Nonce: "nonce", ExpiresAt: time.Now().Add(time.Minute)}, pack: &PackText{PackID: "p", StableText: "context"}}
			req := newTurn()
			req.EvidenceReadProbe = tc.probe
			prepared, out := coordinator(&fakeGrants{grant: readyGrant}, memory).Prepare(context.Background(), req)
			if out.Kind != "injected" || prepared == nil {
				t.Fatalf("prepare failed: %+v", out)
			}
			if got := <-requests; got.EvidenceReadCapability != tc.wantWire {
				t.Fatalf("wire capability %q want %q", got.EvidenceReadCapability, tc.wantWire)
			}
			if prepared.EvidenceReadCapability != tc.wantPrepared {
				t.Fatalf("prepared capability %q want %q", prepared.EvidenceReadCapability, tc.wantPrepared)
			}
			if memory.fetchCalls != 1 || memory.admitCalls != 1 {
				t.Fatal("negotiation changed native admission semantics")
			}
		})
	}
}

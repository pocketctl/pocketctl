package session

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"testing"
)

func externalRequestFixture() (ExternalExecutionRequest, ExternalCapabilities) {
	input := []byte(`{"prompt":"frozen task","permission":"read-only"}`)
	digest := sha256.Sum256(input)
	return ExternalExecutionRequest{Identity: ExternalExecutionIdentity{Scope: "relay/daemon/owner/provider", CallID: "call", OfferID: "offer", RequestID: "request", AttemptID: "attempt"}, Input: input, InputDigest: hex.EncodeToString(digest[:])}, ExternalCapabilities{IdempotentSubmit: true, LookupByRequest: true, Cancellation: true, ArtifactExport: true}
}
func TestExternalRequestCapabilitiesAndImmutableInput(t *testing.T) {
	request, caps := externalRequestFixture()
	if err := request.Validate(caps); err != nil {
		t.Fatal(err)
	}
	for _, change := range []func(*ExternalCapabilities){func(c *ExternalCapabilities) { c.AutomaticRetry = true }, func(c *ExternalCapabilities) { c.IdempotentSubmit = false }, func(c *ExternalCapabilities) { c.LookupByRequest = false }, func(c *ExternalCapabilities) { c.Cancellation = false }, func(c *ExternalCapabilities) { c.ArtifactExport = false }} {
		next := caps
		change(&next)
		if !errors.Is(request.Validate(next), ErrExternalCapability) {
			t.Fatal("unsafe capability accepted")
		}
	}
	limit := int64(0)
	request.MaxCostMicros = &limit
	if !errors.Is(request.Validate(caps), ErrExternalCapability) {
		t.Fatal("unbounded provider accepted cost limit")
	}
	caps.HardCostLimit = true
	caps.CostReporting = true
	if err := request.Validate(caps); err != nil {
		t.Fatal(err)
	}
	request.Input[0] = 'x'
	if !errors.Is(request.Validate(caps), ErrExternalIdentity) {
		t.Fatal("changed input accepted")
	}
}
func TestExternalReceiptDuplicateStaleAndTerminal(t *testing.T) {
	request, _ := externalRequestFixture()
	cost := int64(12)
	first := ExternalExecutionReceipt{Identity: request.Identity, InputDigest: request.InputDigest, RemoteTaskID: "remote-1", Sequence: 1, State: ExternalRunning, CostMicros: &cost}
	current, err := ReconcileExternalReceipt(request, nil, first)
	if err != nil {
		t.Fatal(err)
	}
	cost = 20
	if *current.CostMicros != 12 {
		t.Fatal("mutable receipt alias")
	}
	replay := current
	if _, err = ReconcileExternalReceipt(request, &current, replay); err != nil {
		t.Fatal(err)
	}
	replay.State = ExternalFailed
	if !errors.Is(func() error { _, e := ReconcileExternalReceipt(request, &current, replay); return e }(), ErrExternalReceipt) {
		t.Fatal("rewritten duplicate accepted")
	}
	done := current
	done.Sequence = 2
	done.State = ExternalSucceeded
	terminal, err := ReconcileExternalReceipt(request, &current, done)
	if err != nil {
		t.Fatal(err)
	}
	stale, err := ReconcileExternalReceipt(request, &terminal, current)
	if err != nil || stale.State != ExternalSucceeded {
		t.Fatal("stale receipt overwrote success", err)
	}
	done.Sequence = 3
	done.State = ExternalRunning
	if _, err = ReconcileExternalReceipt(request, &terminal, done); !errors.Is(err, ErrExternalReceipt) {
		t.Fatal("terminal restarted", err)
	}
}
func TestExternalReceiptIdentityCostAndStateGuards(t *testing.T) {
	request, _ := externalRequestFixture()
	cost := int64(12)
	current := ExternalExecutionReceipt{Identity: request.Identity, InputDigest: request.InputDigest, RemoteTaskID: "remote", Sequence: 1, State: ExternalRunning, CostMicros: &cost}
	for name, change := range map[string]func(*ExternalExecutionReceipt){
		"other_call":         func(r *ExternalExecutionReceipt) { r.Identity.CallID = "other" },
		"other_attempt":      func(r *ExternalExecutionReceipt) { r.Identity.AttemptID = "other" },
		"other_installation": func(r *ExternalExecutionReceipt) { r.Identity.Scope = "other" },
		"other_task":         func(r *ExternalExecutionReceipt) { r.RemoteTaskID = "other" },
		"other_input":        func(r *ExternalExecutionReceipt) { r.InputDigest = "bad" },
		"regression":         func(r *ExternalExecutionReceipt) { r.State = ExternalPending },
		"unknown":            func(r *ExternalExecutionReceipt) { r.State = "timeout" },
		"lost_cost":          func(r *ExternalExecutionReceipt) { r.CostMicros = nil },
		"lower_cost":         func(r *ExternalExecutionReceipt) { v := int64(1); r.CostMicros = &v },
	} {
		t.Run(name, func(t *testing.T) {
			next := current
			next.Sequence = 2
			change(&next)
			if _, err := ReconcileExternalReceipt(request, &current, next); err == nil {
				t.Fatal("invalid receipt accepted")
			}
		})
	}
}

func TestExternalReceiptRejectsCorruptStoredState(t *testing.T) {
	request, _ := externalRequestFixture()
	next := ExternalExecutionReceipt{Identity: request.Identity, InputDigest: request.InputDigest, RemoteTaskID: "remote", Sequence: 2, State: ExternalRunning}
	current := next
	current.Sequence = 0
	if _, err := ReconcileExternalReceipt(request, &current, next); !errors.Is(err, ErrExternalReceipt) {
		t.Fatal("corrupt stored receipt accepted", err)
	}
}

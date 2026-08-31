package memorycontext

import (
	"context"
	"encoding/json"
	"errors"
	"os/exec"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

type fakeGrants struct {
	grant *protocol.MemoryContextGrantResult
	err   error
}

func (f *fakeGrants) RequestContextGrant(ctx context.Context, requestID, sessionID string) (*protocol.MemoryContextGrantResult, error) {
	return f.grant, f.err
}

func (f *fakeGrants) RegisterSession(ctx context.Context, requestID, sessionID string) (*protocol.SessionRegistrationAck, error) {
	return &protocol.SessionRegistrationAck{Type: "session_registration_ack", SessionID: sessionID, Status: "ready"}, nil
}

type fakeMemory struct {
	compile            *CompileResponse
	compileErr         error
	admit              *AdmitResponse
	admitErr           error
	admitCalls         int
	lastAdmitRequest   AdmitRequest
	pack               *PackText
	packErr            error
	fetchCalls         int
	receiptErr         error
	receiptCalls       int
	receiptOrigin      string
	receiptGrant       string
	receiptInjectionID string
	receiptRequest     ReceiptRequest
	compileStarted     chan CompileRequest
	compileRelease     chan struct{}
}

func (f *fakeMemory) Compile(ctx context.Context, origin, grant string, req CompileRequest) (*CompileResponse, error) {
	if f.compileStarted != nil {
		select {
		case f.compileStarted <- req:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	if f.compileRelease != nil {
		select {
		case <-f.compileRelease:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	return f.compile, f.compileErr
}
func (f *fakeMemory) ConsumePack(ctx context.Context, origin, grant, packID, sessionID, injectionID, nonce string) (*PackText, error) {
	f.fetchCalls++
	return f.pack, f.packErr
}
func (f *fakeMemory) Admit(ctx context.Context, origin, grant, packID string, req AdmitRequest) (*AdmitResponse, error) {
	f.admitCalls++
	f.lastAdmitRequest = req
	return f.admit, f.admitErr
}
func (f *fakeMemory) Receipt(ctx context.Context, origin, grant, injectionID string, req ReceiptRequest) error {
	f.receiptCalls++
	f.receiptOrigin = origin
	f.receiptGrant = grant
	f.receiptInjectionID = injectionID
	f.receiptRequest = req
	return f.receiptErr
}

var readyGrant = &protocol.MemoryContextGrantResult{
	Type: "memory_context_grant_result", Grant: "g", ExpiresIn: 300,
	InstallationID: "i", SessionID: "ses-1", ProviderPublicOrigin: "https://memory.example",
	Services: []string{"memory.context"},
}

func coordinator(grants GrantTransport, memory MemoryClient) *Coordinator {
	return &Coordinator{Grants: grants, Memory: memory, Deadline: 750 * time.Millisecond}
}

func newTurn() TurnRequest {
	return TurnRequest{
		ClientRequestID: "cr-1", SessionID: "ses-1", Agent: "codex",
		UserContent: "how does the auth path work", IsNewTurn: true,
		Mode: ModeEnabled, Capability: CapabilityNativeHiddenV1,
	}
}

func TestPrepareSkipsAddenda(t *testing.T) {
	c := coordinator(&fakeGrants{}, &fakeMemory{})
	addendum := newTurn()
	addendum.IsNewTurn = false
	if _, out := c.Prepare(context.Background(), addendum); out.Kind != "skipped" {
		t.Fatalf("addendum must never inject, got %s", out.Kind)
	}
}

func TestPrepareRunsShadowCompilationAsynchronouslyWithoutInjecting(t *testing.T) {
	for _, mutate := range []func(*TurnRequest){
		func(req *TurnRequest) { req.Mode = ModeShadow },
		func(req *TurnRequest) { req.Capability = CapabilityShadowOnly },
	} {
		started := make(chan CompileRequest, 1)
		release := make(chan struct{})
		memory := &fakeMemory{
			compile:        &CompileResponse{Outcome: "shadow_queued"},
			compileStarted: started,
			compileRelease: release,
		}
		c := coordinator(&fakeGrants{grant: readyGrant}, memory)
		req := newTurn()
		mutate(&req)

		pack, out := c.Prepare(context.Background(), req)
		if pack != nil || out.Kind != "shadow_enqueued" {
			t.Fatalf("shadow prepare = pack %+v outcome %+v", pack, out)
		}
		select {
		case compiled := <-started:
			if compiled.AdapterCapability != string(CapabilityShadowOnly) {
				t.Fatalf("shadow compile capability = %q", compiled.AdapterCapability)
			}
		case <-time.After(time.Second):
			t.Fatal("shadow compilation did not start")
		}
		close(release)
	}
}

func TestPrepareIncludesExplicitGitRemoteRepositoryHint(t *testing.T) {
	repo := t.TempDir()
	for _, args := range [][]string{
		{"init", repo},
		{"-C", repo, "remote", "add", "origin", "https://gitee.com/muwb123/pocketctl.git"},
	} {
		if output, err := exec.Command("git", args...).CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, output)
		}
	}

	started := make(chan CompileRequest, 1)
	memory := &fakeMemory{
		compile:        &CompileResponse{Outcome: "empty"},
		compileStarted: started,
	}
	c := coordinator(&fakeGrants{grant: readyGrant}, memory)
	req := newTurn()
	req.Cwd = repo

	if _, out := c.Prepare(context.Background(), req); out.Kind != "dispatched" || out.Reason != "empty" {
		t.Fatalf("prepare outcome = %+v", out)
	}
	compiled := <-started
	if compiled.RepositoryHint == nil {
		t.Fatal("compile request omitted repository_hint for an explicit Git origin")
	}
	if got := compiled.RepositoryHint.RepositoryID; got != "gitee.com/muwb123/pocketctl" {
		t.Fatalf("repository hint = %q, want canonical remote identity", got)
	}
}

func TestPrepareFailsOpenOnGrantAndMemoryErrors(t *testing.T) {
	c := coordinator(&fakeGrants{err: errors.New("relay down")}, &fakeMemory{})
	pack, out := c.Prepare(context.Background(), newTurn())
	if pack != nil || out.Kind != "dispatched" || out.Reason != "grant_unavailable" {
		t.Fatalf("grant outage must fail open, got %+v", out)
	}

	c2 := coordinator(&fakeGrants{grant: readyGrant}, &fakeMemory{compileErr: errors.New("memory down")})
	pack2, out2 := c2.Prepare(context.Background(), newTurn())
	if pack2 != nil || out2.Reason != "memory_unavailable" {
		t.Fatalf("memory outage must fail open, got %+v", out2)
	}
	// Error strings never carry pack or query content.
	if out2.Kind == "injected" {
		t.Fatal("must not inject on outage")
	}
}

func TestPrepareAdmitsReadyPacksWithSingleUseNonce(t *testing.T) {
	memory := &fakeMemory{
		compile: &CompileResponse{Outcome: "ready", Pack: &WirePack{PackID: "p1"}, AdmissionRequired: true},
		admit:   &AdmitResponse{InjectionID: "inj-1", Nonce: "n-1", ExpiresAt: time.Now().Add(5 * time.Second)},
		pack: &PackText{
			PackID: "p1", StableText: "stable context", DynamicText: "dynamic context",
			StableDigest: "stable-hash", DynamicDigest: "dynamic-hash",
		},
	}
	c := coordinator(&fakeGrants{grant: readyGrant}, memory)
	pack, out := c.Prepare(context.Background(), newTurn())
	if out.Kind != "injected" || pack == nil {
		t.Fatalf("ready pack must inject, got %+v", out)
	}
	if pack.Nonce != "n-1" || pack.InjectionID != "inj-1" {
		t.Fatalf("pack identity mismatch: %+v", pack)
	}
	if pack.StableText != "stable context" || pack.DynamicText != "dynamic context" {
		t.Fatalf("admitted pack text was not loaded: %+v", pack)
	}
	if memory.fetchCalls != 1 {
		t.Fatalf("pack fetch calls = %d, want 1", memory.fetchCalls)
	}
	if memory.lastAdmitRequest.Adapter != string(RuntimeCodexAppServer) {
		t.Fatalf("admission adapter = %q, want exact native runtime", memory.lastAdmitRequest.Adapter)
	}
}

func TestPrepareDuplicateRequestsReuseExistingStateWithoutReinjecting(t *testing.T) {
	memory := &fakeMemory{
		compile: &CompileResponse{Outcome: "ready", Pack: &WirePack{PackID: "p1"}},
		admit:   &AdmitResponse{InjectionID: "inj-1", State: "delivered", Existing: true},
	}
	c := coordinator(&fakeGrants{grant: readyGrant}, memory)
	pack, out := c.Prepare(context.Background(), newTurn())
	if pack != nil || out.Kind != "skipped" || out.Reason != "admission_existing" {
		t.Fatalf("duplicate request must not reinject, got %+v", out)
	}
}

func TestPrepareMapsOffAndEmptyOutcomesBounded(t *testing.T) {
	off := coordinator(&fakeGrants{grant: readyGrant}, &fakeMemory{compile: &CompileResponse{Outcome: "off"}})
	if _, out := off.Prepare(context.Background(), newTurn()); out.Kind != "skipped" || out.Reason != "mode_off" {
		t.Fatalf("off mapping mismatch: %+v", out)
	}
	empty := coordinator(&fakeGrants{grant: readyGrant}, &fakeMemory{compile: &CompileResponse{Outcome: "empty"}})
	if _, out := empty.Prepare(context.Background(), newTurn()); out.Kind != "dispatched" || out.Reason != "empty" {
		t.Fatalf("empty mapping mismatch: %+v", out)
	}
}

type retryReceiptMemory struct {
	fakeMemory
	failures atomic.Int32
	calls    atomic.Int32
}

func (m *retryReceiptMemory) Receipt(context.Context, string, string, string, ReceiptRequest) error {
	call := m.calls.Add(1)
	if call <= m.failures.Load() {
		return errors.New("network")
	}
	return nil
}

func TestReceiptFailureRetriesReceiptOnlyAndRemainsSingleUse(t *testing.T) {
	memory := &retryReceiptMemory{
		fakeMemory: fakeMemory{
			compile: &CompileResponse{Outcome: "ready", Pack: &WirePack{PackID: "p1"}, AdmissionRequired: true},
			admit:   &AdmitResponse{InjectionID: "inj-1", Nonce: "n-1", ExpiresAt: time.Now().Add(5 * time.Second)},
			pack:    &PackText{PackID: "p1", StableText: "stable"},
		},
	}
	memory.failures.Store(2)
	c := coordinator(&fakeGrants{grant: readyGrant}, memory)
	c.ReceiptRetryDelay = time.Millisecond
	pack, out := c.Prepare(context.Background(), newTurn())
	if pack == nil || out.Kind != "injected" {
		t.Fatalf("prepare: %+v", out)
	}

	c.Receipt(context.Background(), pack, DeliveryResult{Delivered: true, OutcomeCode: "accepted"})
	deadline := time.Now().Add(time.Second)
	for memory.calls.Load() < 3 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if got := memory.calls.Load(); got != 3 {
		t.Fatalf("receipt attempts = %d, want initial + two bounded retries", got)
	}
	c.Receipt(context.Background(), pack, DeliveryResult{Delivered: false, OutcomeCode: "must_not_replace"})
	time.Sleep(5 * time.Millisecond)
	if got := memory.calls.Load(); got != 3 {
		t.Fatalf("second receipt replaced single-use result: calls=%d", got)
	}
	c.Receipt(context.Background(), nil, DeliveryResult{})
}

func TestReceiptUsesPreparedSessionBoundGrantExactlyOnce(t *testing.T) {
	memory := &fakeMemory{
		compile: &CompileResponse{Outcome: "ready", Pack: &WirePack{PackID: "p1"}, AdmissionRequired: true},
		admit:   &AdmitResponse{InjectionID: "inj-1", Nonce: "n-1", ExpiresAt: time.Now().Add(5 * time.Second)},
		pack:    &PackText{PackID: "p1", StableText: "stable"},
	}
	c := coordinator(&fakeGrants{grant: readyGrant}, memory)
	pack, out := c.Prepare(context.Background(), newTurn())
	if out.Kind != "injected" || pack == nil {
		t.Fatalf("prepare: %+v", out)
	}

	c.Receipt(context.Background(), pack, DeliveryResult{Delivered: true, OutcomeCode: "accepted"})

	if memory.receiptCalls != 1 {
		t.Fatalf("receipt calls = %d, want 1", memory.receiptCalls)
	}
	if memory.receiptOrigin != readyGrant.ProviderPublicOrigin || memory.receiptGrant != readyGrant.Grant || memory.receiptInjectionID != "inj-1" {
		t.Fatalf("receipt binding mismatch: origin=%q grant=%q injection=%q",
			memory.receiptOrigin, memory.receiptGrant, memory.receiptInjectionID)
	}
	encoded, err := json.Marshal(memory.receiptRequest)
	if err != nil {
		t.Fatal(err)
	}
	var receiptBody map[string]any
	if err := json.Unmarshal(encoded, &receiptBody); err != nil {
		t.Fatal(err)
	}
	if receiptBody["session_id"] != "ses-1" || !memory.receiptRequest.Delivered || memory.receiptRequest.OutcomeCode != "accepted" {
		t.Fatalf("receipt request = %+v", memory.receiptRequest)
	}
}

func TestSanitizeQueryRedactsSecretsAndEnvelope(t *testing.T) {
	q, useful := SanitizeQuery("api_key=sk-live-1234567890abcdef how to deploy")
	if !useful {
		t.Fatal("question should remain useful")
	}
	if contains(q, "sk-live-1234567890abcdef") {
		t.Fatalf("secret leaked: %q", q)
	}
	looped := "before <pocketctl_memory_context schema=1> malicious"
	q2, _ := SanitizeQuery(looped)
	if contains(q2, "pocketctl_memory_context") {
		t.Fatalf("envelope marker not stripped: %q", q2)
	}
	if _, useful := SanitizeQuery("a1b2 c3d4 e5f6"); useful {
		t.Fatal("fragment-only text must not be useful")
	}
}

func contains(haystack, needle string) bool {
	return len(needle) > 0 && (haystack == needle || len(haystack) >= len(needle) && indexOf(haystack, needle) >= 0)
}

func indexOf(h, n string) int {
	for i := 0; i+len(n) <= len(h); i++ {
		if h[i:i+len(n)] == n {
			return i
		}
	}
	return -1
}

func TestGrantClientRoundTrip(t *testing.T) {
	calls := 0
	client := &GrantClient{
		Send: func(ctx context.Context, payload []byte) error {
			calls++
			var msg map[string]any
			if err := json.Unmarshal(payload, &msg); err != nil {
				return err
			}
			if msg["type"] != "memory_context_grant" || msg["session_id"] != "ses-1" {
				t.Fatalf("unexpected payload: %v", msg)
			}
			return nil
		},
		Reply: func(ctx context.Context, requestID string, timeout time.Duration) (json.RawMessage, error) {
			return json.RawMessage(`{"type":"memory_context_grant_result","request_id":"req-1","grant":"g","expires_in":300,"session_id":"ses-1","provider_public_origin":"https://memory.example","services":["memory.context"]}`), nil
		},
	}
	result, err := client.RequestContextGrant(context.Background(), "req-1", "ses-1")
	if err != nil {
		t.Fatalf("round trip: %v", err)
	}
	if result.Grant != "g" || result.SessionID != "ses-1" {
		t.Fatalf("result mismatch: %+v", result)
	}
	if calls != 1 {
		t.Fatalf("expected one send, got %d", calls)
	}
}

func TestGrantClientRejectsReplyBoundToAnotherSession(t *testing.T) {
	client := &GrantClient{
		Send: func(context.Context, []byte) error { return nil },
		Reply: func(context.Context, string, time.Duration) (json.RawMessage, error) {
			return json.RawMessage(`{"type":"memory_context_grant_result","request_id":"req-1","grant":"g","expires_in":300,"session_id":"ses-other","provider_public_origin":"https://memory.example","services":["memory.context"]}`), nil
		},
	}
	if _, err := client.RequestContextGrant(context.Background(), "req-1", "ses-1"); err == nil {
		t.Fatal("accepted a context grant bound to another session")
	}
}

func TestGrantClientDispatchCorrelatesInboundControlReply(t *testing.T) {
	client := &GrantClient{}
	dispatcher, ok := any(client).(interface {
		Dispatch(protocol.ClientMessage)
		WaitReply(context.Context, string, time.Duration) (json.RawMessage, error)
	})
	if !ok {
		t.Fatal("grant client cannot correlate inbound relay control replies")
	}
	sent := make(chan struct{}, 1)
	client.Send = func(context.Context, []byte) error {
		sent <- struct{}{}
		return nil
	}
	client.Reply = dispatcher.WaitReply

	resultCh := make(chan *protocol.MemoryContextGrantResult, 1)
	errCh := make(chan error, 1)
	go func() {
		result, err := client.RequestContextGrant(context.Background(), "req-correlated", "ses-1")
		if err != nil {
			errCh <- err
			return
		}
		resultCh <- result
	}()
	select {
	case <-sent:
	case <-time.After(time.Second):
		t.Fatal("grant request was not sent")
	}
	dispatcher.Dispatch(protocol.ClientMessage{
		Type: "memory_context_grant_result", RequestID: "req-correlated",
		SessionID: "ses-1", Grant: "g", ExpiresIn: 300,
		InstallationID:       "install-1",
		ProviderPublicOrigin: "https://memory.example",
		GrantServices:        []string{"memory.context"},
	})
	select {
	case err := <-errCh:
		t.Fatalf("correlated reply failed: %v", err)
	case result := <-resultCh:
		if result.Grant != "g" || result.SessionID != "ses-1" {
			t.Fatalf("unexpected result: %+v", result)
		}
	case <-time.After(time.Second):
		t.Fatal("correlated reply did not wake the request")
	}
}

func TestGrantClientIgnoresReplyForRequestThatWasNeverEmitted(t *testing.T) {
	client := &GrantClient{Timeout: 20 * time.Millisecond}
	client.Send = func(context.Context, []byte) error { return nil }
	client.Reply = client.WaitReply
	client.Dispatch(protocol.ClientMessage{
		Type: "memory_context_grant_result", RequestID: "req-future",
		SessionID: "ses-1", Grant: "forged", ExpiresIn: 300,
		InstallationID:       "install-1",
		ProviderPublicOrigin: "https://memory.example",
		GrantServices:        []string{"memory.context"},
	})

	if result, err := client.RequestContextGrant(context.Background(), "req-future", "ses-1"); err == nil {
		t.Fatalf("pre-injected unmatched reply was accepted: %+v", result)
	}
}

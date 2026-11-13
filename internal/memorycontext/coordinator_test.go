package memorycontext

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/http/httptrace"
	"os/exec"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pocketctl/pocketctl/internal/protocol"
)

type fakeGrants struct {
	grant                 *protocol.MemoryContextGrantResult
	err                   error
	scopedInstallationIDs []string
}

func (f *fakeGrants) RequestScopedContextGrant(ctx context.Context, requestID, sessionID string, installationIDs []string) (*protocol.MemoryContextGrantResult, error) {
	f.scopedInstallationIDs = append([]string(nil), installationIDs...)
	return f.grant, f.err
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
	beforePackReturn   func()
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
	if f.beforePackReturn != nil {
		f.beforePackReturn()
	}
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

func TestPrepareUsesInlineCodexHandoffWithoutRepeatingAdmission(t *testing.T) {
	var request struct {
		PrepareContext bool `json:"prepare_context"`
	}
	var response string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/memory/context/compile" {
			t.Errorf("unexpected follow-up request: %s", r.URL.Path)
			http.NotFound(w, r)
			return
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Error(err)
		}
		_, _ = w.Write([]byte(response))
	}))
	defer server.Close()
	grant := *readyGrant
	grant.ProviderPublicOrigin = server.URL
	c := coordinator(&fakeGrants{grant: &grant}, NewMemoryClient())
	response = `{"outcome":"ready","pack":{"pack_id":"pack-1"},"admission_required":false,"handoff":{"status":"prepared","pack_id":"pack-1","injection_id":"inj-1","stable_text":"evidence"}}`
	pack, out := c.Prepare(context.Background(), newTurn())
	if !request.PrepareContext || pack == nil || pack.InjectionID != "inj-1" || pack.StableText != "evidence" || out.Kind != "injected" {
		t.Fatalf("expected prepared inline Context, got opt-in=%v outcome=%+v", request.PrepareContext, out)
	}
	response = `{"outcome":"ready","pack":{"pack_id":"pack-1"},"admission_required":false,"handoff":{"status":"existing"}}`
	pack, out = c.Prepare(context.Background(), newTurn())
	if pack != nil || out.Reason != "admission_existing" {
		t.Fatalf("duplicate inline admission must not hand off text: %+v", out)
	}
	response = `{"outcome":"ready","pack":{"pack_id":"pack-1"},"admission_required":false,"handoff":{"status":"prepared","pack_id":"wrong","injection_id":"inj-1","stable_text":"evidence"}}`
	pack, out = c.Prepare(context.Background(), newTurn())
	if pack != nil || out.Reason != "pack_unavailable" {
		t.Fatalf("mismatched inline pack must be rejected: %+v", out)
	}
}

func TestPrepareReportsWhereTheCompileRequestStopped(t *testing.T) {
	for _, tc := range []struct {
		name              string
		reply             func(http.ResponseWriter, *http.Request)
		grantError        error
		waitForRepository bool
		stage             string
		written           bool
	}{
		{name: "grant deadline", grantError: context.DeadlineExceeded, stage: "grant_unavailable"},
		{name: "repository deadline", waitForRepository: true, stage: "deadline_before_compile"},
		{name: "HTTP response failure", reply: func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusServiceUnavailable)
		}, stage: "memory_unavailable", written: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			grant := *readyGrant
			if tc.reply != nil {
				server := httptest.NewServer(http.HandlerFunc(tc.reply))
				t.Cleanup(server.Close)
				grant.ProviderPublicOrigin = server.URL
			}
			c := coordinator(&fakeGrants{grant: &grant, err: tc.grantError}, NewMemoryClient())
			var observed []CompileTiming
			c.ObserveCompileTiming = func(timing CompileTiming) { observed = append(observed, timing) }
			turn := newTurn()
			if tc.waitForRepository {
				turn.Cwd = t.TempDir()
				c.Deadline = 20 * time.Millisecond
				c.resolveRepositoryHint = func(ctx context.Context, _ string) *RepositoryHint {
					<-ctx.Done()
					return nil
				}
			}
			_, outcome := c.Prepare(context.Background(), turn)
			if outcome.Reason != tc.stage || len(observed) != 1 {
				t.Fatalf("outcome=%+v timing=%+v", outcome, observed)
			}
			timing := observed[0]
			if timing.Outcome != tc.stage || (timing.RequestWrittenAt >= 0) != tc.written ||
				(timing.CompileStartedAt >= 0) != tc.written || timing.Total < timing.Grant {
				t.Fatalf("wrong stage attribution: %+v", timing)
			}
		})
	}
}

func TestPrepareDistinguishesTransportFailureBeforeWriteFromResponseFailure(t *testing.T) {
	for _, tc := range []struct {
		name         string
		tlsConnected bool
		wroteRequest bool
	}{
		{name: "TLS failed before request write"},
		{name: "response failed after request write", tlsConnected: true, wroteRequest: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := coordinator(&fakeGrants{grant: readyGrant}, &httpClient{HTTP: &http.Client{Transport: compileTimingTransport(func(req *http.Request) (*http.Response, error) {
				trace := httptrace.ContextClientTrace(req.Context())
				trace.GetConn("private.test:443")
				trace.TLSHandshakeStart()
				if tc.tlsConnected {
					trace.TLSHandshakeDone(tls.ConnectionState{}, nil)
					trace.GotConn(httptrace.GotConnInfo{})
				} else {
					trace.TLSHandshakeDone(tls.ConnectionState{}, errors.New("TLS rejected"))
				}
				if tc.wroteRequest {
					trace.WroteRequest(httptrace.WroteRequestInfo{})
					trace.GotFirstResponseByte()
				}
				return nil, errors.New("fixture transport failure")
			})}})
			var observed CompileTiming
			c.ObserveCompileTiming = func(timing CompileTiming) { observed = timing }
			_, outcome := c.Prepare(context.Background(), newTurn())
			if outcome.Reason != "memory_unavailable" || observed.CompileStartedAt < 0 ||
				observed.ConnectionRequestedAt < observed.CompileStartedAt || observed.TLSStartedAt < observed.ConnectionRequestedAt {
				t.Fatalf("incorrect compile and TLS start boundaries: %+v %+v", outcome, observed)
			}
			if (observed.TLSCompletedAt >= 0) != tc.tlsConnected || (observed.ConnectionReadyAt >= 0) != tc.tlsConnected ||
				(observed.RequestWrittenAt >= 0) != tc.wroteRequest || (observed.ResponseStartedAt >= 0) != tc.wroteRequest {
				t.Fatalf("incorrect TLS completion and HTTP boundaries: %+v", observed)
			}
		})
	}
}

type compileTimingTransport func(*http.Request) (*http.Response, error)

func (f compileTimingTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}

func TestPrepareSkipsAddenda(t *testing.T) {
	c := coordinator(&fakeGrants{}, &fakeMemory{})
	addendum := newTurn()
	addendum.IsNewTurn = false
	if _, out := c.Prepare(context.Background(), addendum); out.Kind != "skipped" {
		t.Fatalf("addendum must never inject, got %s", out.Kind)
	}
}

type handoffDeadlineContext struct {
	context.Context
	deadline time.Time
}

func (c handoffDeadlineContext) Deadline() (time.Time, bool) {
	return c.deadline, true
}

func TestPrepareDiscardsPackWhenHandoffDeadlineHasPassed(t *testing.T) {
	// Report a real deadline while withholding cancellation notification. This
	// models a successful response competing with a late timer callback.
	parent := handoffDeadlineContext{Context: context.Background(), deadline: time.Now().Add(25 * time.Millisecond)}
	memory := &fakeMemory{
		compile: &CompileResponse{Outcome: "ready", Pack: &WirePack{PackID: "pack"}},
		admit:   &AdmitResponse{InjectionID: "injection", Nonce: "nonce"},
		pack:    &PackText{PackID: "pack", DynamicText: "synthetic evidence"},
		beforePackReturn: func() {
			time.Sleep(time.Until(parent.deadline) + time.Millisecond)
		},
	}
	pack, out := coordinator(&fakeGrants{grant: readyGrant}, memory).Prepare(parent, newTurn())
	if memory.fetchCalls != 1 || pack != nil || out.Kind != "dispatched" || out.Reason != "pack_unavailable" {
		t.Fatalf("late result escaped the deadline: fetches=%d pack=%t outcome=%+v", memory.fetchCalls, pack != nil, out)
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

type overlappingGrantTransport struct {
	fakeGrants
	repositoryStarted <-chan struct{}
}

func (g overlappingGrantTransport) RequestContextGrant(ctx context.Context, _, _ string) (*protocol.MemoryContextGrantResult, error) {
	select {
	case <-g.repositoryStarted:
		return readyGrant, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func TestPrepareStartsRepositoryProbeWhileGrantIsPending(t *testing.T) {
	repositoryStarted := make(chan struct{})
	memory := &fakeMemory{
		compile:        &CompileResponse{Outcome: "empty"},
		compileStarted: make(chan CompileRequest, 1),
	}
	c := coordinator(&overlappingGrantTransport{repositoryStarted: repositoryStarted}, memory)
	c.resolveRepositoryHint = func(context.Context, string) *RepositoryHint {
		close(repositoryStarted)
		return &RepositoryHint{RepositoryID: "example.test/team/repo", CommitSHA: "0123456789abcdef"}
	}
	req := newTurn()
	req.Cwd = t.TempDir()
	_, outcome := c.Prepare(context.Background(), req)
	select {
	case compiled := <-memory.compileStarted:
		if compiled.RepositoryHint == nil || compiled.RepositoryHint.CommitSHA != "0123456789abcdef" {
			t.Fatalf("compile lost the explicit repository observation: %+v", compiled.RepositoryHint)
		}
	default:
		t.Fatalf("compile did not start within the shared deadline: %+v", outcome)
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

func TestPrepareTeamSelectionUsesScopedGrantAndExactReferences(t *testing.T) {
	grants := &fakeGrants{grant: readyGrant}
	started := make(chan CompileRequest, 1)
	memory := &fakeMemory{
		compile:        &CompileResponse{Outcome: "ready", Pack: &WirePack{PackID: "team-pack"}, AdmissionRequired: true},
		admit:          &AdmitResponse{InjectionID: "team-injection", Nonce: "team-nonce", ExpiresAt: time.Now().Add(5 * time.Second)},
		pack:           &PackText{PackID: "team-pack", StableText: "published team knowledge"},
		compileStarted: started,
	}
	req := newTurn()
	req.ScopeInstallationIDs = []string{"team-installation"}
	req.SelectedReferences = []SelectedReference{{
		SourceKind: "memory_claim", SourceID: "claim", SourceVersion: "version",
		OwnerScopeID: "team", InstallationID: "team-installation",
	}}
	pack, outcome := coordinator(grants, memory).Prepare(context.Background(), req)
	if outcome.Kind != "injected" || pack == nil {
		t.Fatalf("team selection = pack %+v outcome %+v", pack, outcome)
	}
	if len(grants.scopedInstallationIDs) != 1 || grants.scopedInstallationIDs[0] != "team-installation" {
		t.Fatalf("scoped grant ids = %v", grants.scopedInstallationIDs)
	}
	compiled := <-started
	if len(compiled.SelectedReferences) != 1 || compiled.SelectedReferences[0].SourceVersion != "version" {
		t.Fatalf("compile references = %+v", compiled.SelectedReferences)
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

func TestPrepareSelectedMemoryRefusesUnsupportedAdapterWithReason(t *testing.T) {
	started := make(chan CompileRequest, 1)
	memory := &fakeMemory{compileStarted: started, compile: &CompileResponse{Outcome: "shadow_queued"}}
	req := newTurn()
	req.Capability = CapabilityShadowOnly
	req.ScopeInstallationIDs = []string{"shared-installation"}
	req.SelectedReferences = []SelectedReference{{SourceKind: "memory_claim", SourceID: "claim", SourceVersion: "version", OwnerScopeID: "scope", InstallationID: "shared-installation"}}
	pack, outcome := coordinator(&fakeGrants{grant: readyGrant}, memory).Prepare(context.Background(), req)
	if pack != nil || outcome.Reason != "unsupported_adapter" {
		t.Fatalf("selected unsupported adapter: pack=%v outcome=%+v", pack, outcome)
	}
	select {
	case <-started:
		t.Fatal("rejected shared selection must not fall back to personal shadow compilation")
	case <-time.After(20 * time.Millisecond):
	}
}

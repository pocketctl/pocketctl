package memorycontext

import (
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/hex"
	"net/http/httptrace"
	"sync/atomic"
	"time"

	"github.com/pocketctl/pocketctl/internal/protocol"
	"github.com/pocketctl/pocketctl/internal/repositoryidentity"
)

// Coordinator owns the daemon-side pre-turn context flow (plan 11): a hard
// 750ms deadline across grant + compile + admission, fail-open on every
// error, duplicate-request reuse, and receipts that never resend the user
// turn. Pack text lives only for the admission/delivery attempt and is
// never persisted or logged by the daemon.
type Coordinator struct {
	Grants   GrantTransport
	Memory   MemoryClient
	Deadline time.Duration
	// ObserveCompileTiming receives only elapsed times and a bounded outcome.
	ObserveCompileTiming func(CompileTiming)
	// ReceiptRetryDelay is injectable for tests. Production uses a short
	// backoff because receipt retries must never delay or resend the user turn.
	ReceiptRetryDelay time.Duration
	// Now is injectable for tests.
	Now                   func() time.Time
	resolveRepositoryHint func(context.Context, string) *RepositoryHint
}

// TurnRequest describes one new-turn enrichment decision.
type TurnRequest struct {
	SceneID              string
	TaskScopeKey         string
	Destination          string
	FactAt               string
	KnownAt              string
	EvidenceReadProbe    ProbeEvidence
	ClientRequestID      string
	SessionID            string
	Agent                string
	Cwd                  string
	UserContent          string
	IsNewTurn            bool
	Mode                 Mode
	Capability           Capability
	ScopeInstallationIDs []string
	SelectedReferences   []SelectedReference
	rebuildAttempt       int
}

// Mode is the locally resolved effective mode ceiling for this session.
type Mode string

const (
	ModeOff     Mode = "off"
	ModeShadow  Mode = "shadow"
	ModeEnabled Mode = "enabled"
)

// Outcome explains what the coordinator did; it never carries pack text.
type Outcome struct {
	Kind   string // dispatched | shadow_enqueued | injected | skipped | deadline
	Reason string
	Pack   *PreparedContext
}

// CompileTiming uses the daemon's monotonic clock. Negative offsets mark
// boundaries the request did not reach. It contains no request or user data.
type CompileTiming struct {
	Grant                 time.Duration
	RepositoryWait        time.Duration
	CompileStartedAt      time.Duration
	ConnectionRequestedAt time.Duration
	ConnectionReadyAt     time.Duration
	TLSStartedAt          time.Duration
	TLSCompletedAt        time.Duration
	RequestWrittenAt      time.Duration
	ResponseStartedAt     time.Duration
	Total                 time.Duration
	Outcome               string
}

func (c *Coordinator) deadline() time.Duration {
	if c.Deadline > 0 {
		return c.Deadline
	}
	return 750 * time.Millisecond
}

func (c *Coordinator) receiptRetryDelay() time.Duration {
	if c.ReceiptRetryDelay > 0 {
		return c.ReceiptRetryDelay
	}
	return 100 * time.Millisecond
}

func newRequestID() string {
	buf := make([]byte, 12)
	_, _ = rand.Read(buf)
	return hex.EncodeToString(buf)
}

func repositoryHint(ctx context.Context, cwd string) *RepositoryHint {
	observation, ok := repositoryidentity.Resolve(ctx, cwd)
	if !ok {
		return nil
	}
	return &RepositoryHint{
		RepositoryID: observation.RepositoryID,
		Branch:       observation.Branch,
		CommitSHA:    observation.CommitSHA,
	}
}

// Prepare runs the enabled-mode synchronous flow. The returned context, if
// any, is valid for one admission window; every error returns (nil, outcome)
// and the caller MUST dispatch the original user input unchanged.
func (c *Coordinator) Prepare(parent context.Context, req TurnRequest) (_ *PreparedContext, outcome Outcome) {
	// Only new turns inject: steer/addendum input remains part of the
	// active turn (plan 8.3).
	if !req.IsNewTurn || req.Mode == ModeOff {
		return nil, Outcome{Kind: "skipped", Reason: "not_new_turn_or_not_enabled"}
	}
	// Explicit shared selections must not silently compile a personal shadow
	// pack when the runtime cannot deliver hidden context.
	if len(req.SelectedReferences) > 0 && req.Capability != CapabilityNativeHiddenV1 {
		return nil, Outcome{Kind: "skipped", Reason: "unsupported_adapter"}
	}
	if req.Mode == ModeShadow || req.Capability != CapabilityNativeHiddenV1 {
		c.prepareShadow(req)
		return nil, Outcome{Kind: "shadow_enqueued", Reason: "shadow_only"}
	}

	deadline := c.deadline()
	ctx, cancel := context.WithTimeout(parent, deadline)
	defer cancel()
	started := time.Now()
	var timing CompileTiming
	var connectionRequested, connectionReady, tlsStarted, tlsCompleted, requestWritten, responseStarted atomic.Int64
	if observe := c.ObserveCompileTiming; observe != nil {
		timing.CompileStartedAt = -1
		for _, stamp := range []*atomic.Int64{&connectionRequested, &connectionReady, &tlsStarted, &tlsCompleted, &requestWritten, &responseStarted} {
			stamp.Store(-1)
		}
		defer func() {
			timing.ConnectionRequestedAt = time.Duration(connectionRequested.Load())
			timing.ConnectionReadyAt = time.Duration(connectionReady.Load())
			timing.TLSStartedAt = time.Duration(tlsStarted.Load())
			timing.TLSCompletedAt = time.Duration(tlsCompleted.Load())
			timing.RequestWrittenAt = time.Duration(requestWritten.Load())
			timing.ResponseStartedAt = time.Duration(responseStarted.Load())
			timing.Total = time.Since(started)
			timing.Outcome = outcome.Kind
			switch outcome.Reason {
			case "scoped_grant_unavailable", "grant_unavailable", "deadline_before_compile", "memory_unavailable",
				"admission_failed", "admission_existing", "pack_unavailable", "compile_outcome":
				timing.Outcome = outcome.Reason
			}
			observe(timing)
		}()
	}

	requestID := req.ClientRequestID
	if requestID == "" {
		requestID = newRequestID()
	}

	// Git and the authenticated grant are independent. Keep the original
	// bounded observation and wait for it only while the turn is still live.
	var repository chan *RepositoryHint
	if req.Cwd != "" {
		repository = make(chan *RepositoryHint, 1)
		resolve := c.resolveRepositoryHint
		if resolve == nil {
			resolve = repositoryHint
		}
		go func() { repository <- resolve(ctx, req.Cwd) }()
	}

	var grant *protocol.MemoryContextGrantResult
	var err error
	if len(req.ScopeInstallationIDs) > 0 {
		scoped, ok := c.Grants.(ScopedGrantTransport)
		if !ok {
			return nil, Outcome{Kind: "dispatched", Reason: "scoped_grant_unavailable"}
		}
		grant, err = scoped.RequestScopedContextGrant(ctx, requestID, req.SessionID, req.ScopeInstallationIDs)
	} else {
		grant, err = c.Grants.RequestContextGrant(ctx, requestID, req.SessionID)
	}
	grantFinished := time.Now()
	timing.Grant = grantFinished.Sub(started)
	if err != nil {
		return nil, Outcome{Kind: "dispatched", Reason: "grant_unavailable"}
	}

	var hint *RepositoryHint
	if repository != nil {
		select {
		case hint = <-repository:
		case <-ctx.Done():
			timing.RepositoryWait = time.Since(grantFinished)
			return nil, Outcome{Kind: "dispatched", Reason: "deadline_before_compile"}
		}
	}
	timing.RepositoryWait = time.Since(grantFinished)
	if ctx.Err() != nil {
		return nil, Outcome{Kind: "dispatched", Reason: "deadline_before_compile"}
	}
	query, useful := SanitizeQuery(req.UserContent)
	if !useful {
		query = ""
	}
	compileReq := CompileRequest{
		SceneID: req.SceneID, TaskScopeKey: req.TaskScopeKey, Destination: req.Destination, FactAt: req.FactAt, KnownAt: req.KnownAt,
		PrepareContext:     req.Agent == "codex" && len(req.SelectedReferences) == 0 && len(req.ScopeInstallationIDs) == 0,
		SchemaVersion:      1,
		ClientRequestID:    requestID,
		SessionID:          req.SessionID,
		Agent:              req.Agent,
		AdapterCapability:  string(req.Capability),
		RepositoryHint:     hint,
		Query:              query,
		RequestedAt:        started.UTC(),
		SelectedReferences: req.SelectedReferences,
	}
	if ResolveEvidenceReadCapability(req.Capability, req.EvidenceReadProbe) == "on_demand_v1" {
		compileReq.EvidenceReadCapability = "on_demand_v1"
	}
	compileCtx := ctx
	timing.CompileStartedAt = time.Since(started)
	if c.ObserveCompileTiming != nil {
		record := func(stamp *atomic.Int64) { stamp.CompareAndSwap(-1, int64(time.Since(started))) }
		compileCtx = httptrace.WithClientTrace(ctx, &httptrace.ClientTrace{
			GetConn:           func(string) { record(&connectionRequested) },
			GotConn:           func(httptrace.GotConnInfo) { record(&connectionReady) },
			TLSHandshakeStart: func() { record(&tlsStarted) },
			TLSHandshakeDone: func(_ tls.ConnectionState, err error) {
				if err == nil {
					record(&tlsCompleted)
				}
			},
			GotFirstResponseByte: func() { record(&responseStarted) },
			WroteRequest: func(info httptrace.WroteRequestInfo) {
				if info.Err == nil {
					record(&requestWritten)
				}
			},
		})
	}
	compiled, err := c.Memory.Compile(compileCtx, grant.ProviderPublicOrigin, grant.Grant, compileReq)
	if err != nil {
		return nil, Outcome{Kind: "dispatched", Reason: "memory_unavailable"}
	}
	switch compiled.Outcome {
	case "off":
		return nil, Outcome{Kind: "skipped", Reason: "mode_off"}
	case "empty", "degraded":
		reason := compiled.Reason
		if reason == "" {
			reason = compiled.Outcome
		}
		return nil, Outcome{Kind: "dispatched", Reason: reason}
	case "unsupported_adapter":
		return nil, Outcome{Kind: "skipped", Reason: "unsupported_adapter"}
	case "shadow_queued":
		return nil, Outcome{Kind: "shadow_enqueued"}
	}
	if compiled.Outcome != "ready" || compiled.Pack == nil {
		return nil, Outcome{Kind: "dispatched", Reason: "compile_outcome"}
	}

	var admitted *AdmitResponse
	var text *PackText
	if compileReq.PrepareContext && compiled.Handoff != nil {
		handoff := compiled.Handoff
		switch handoff.Status {
		case "admission_failed":
			return nil, Outcome{Kind: "dispatched", Reason: "admission_failed"}
		case "existing":
			return nil, Outcome{Kind: "skipped", Reason: "admission_existing"}
		case "prepared":
			if compiled.AdmissionRequired || handoff.InjectionID == "" {
				return nil, Outcome{Kind: "dispatched", Reason: "pack_unavailable"}
			}
			admitted = &AdmitResponse{InjectionID: handoff.InjectionID, ExpiresAt: handoff.ExpiresAt}
			text = &handoff.PackText
		default:
			return nil, Outcome{Kind: "dispatched", Reason: "pack_unavailable"}
		}
	} else {
		admitted, err = c.Memory.Admit(ctx, grant.ProviderPublicOrigin, grant.Grant, compiled.Pack.PackID, AdmitRequest{
			ClientRequestID: requestID,
			SessionID:       req.SessionID,
			Agent:           req.Agent,
			Adapter:         nativeAdapterForAgent(req.Agent),
		})
		if err != nil {
			if len(req.SelectedReferences) > 0 && req.rebuildAttempt == 0 {
				return c.rebuildSelectedContext(ctx, req, requestID)
			}
			return nil, Outcome{Kind: "dispatched", Reason: "admission_failed"}
		}
		if admitted.Existing || admitted.Nonce == "" {
			// A duplicate request returns existing state; without a fresh nonce
			// there is nothing this attempt may deliver.
			if len(req.SelectedReferences) > 0 && req.rebuildAttempt == 0 {
				return c.rebuildSelectedContext(ctx, req, requestID)
			}
			return nil, Outcome{Kind: "skipped", Reason: "admission_existing"}
		}
		text, err = c.Memory.ConsumePack(ctx, grant.ProviderPublicOrigin, grant.Grant,
			compiled.Pack.PackID, req.SessionID, admitted.InjectionID, admitted.Nonce)
	}
	// A successful response can race the context's cancellation callback.
	// Enforce the same monotonic deadline before handing the pack to the caller.
	handoffDeadline, _ := ctx.Deadline()
	if ctx.Err() != nil || !time.Now().Before(handoffDeadline) {
		return nil, Outcome{Kind: "dispatched", Reason: "pack_unavailable"}
	}
	if err != nil || text == nil || text.PackID != compiled.Pack.PackID ||
		(text.StableText == "" && text.DynamicText == "") {
		if len(req.SelectedReferences) > 0 && req.rebuildAttempt == 0 {
			return c.rebuildSelectedContext(ctx, req, requestID)
		}
		return nil, Outcome{Kind: "dispatched", Reason: "pack_unavailable"}
	}
	evidenceCapability := "bounded_excerpt_v1"
	if compileReq.EvidenceReadCapability == "on_demand_v1" && compiled.EvidenceReadCapability == "on_demand_v1" {
		evidenceCapability = "on_demand_v1"
	}
	return &PreparedContext{
		EvidenceReadCapability: evidenceCapability,
		PackID:                 compiled.Pack.PackID,
		InjectionID:            admitted.InjectionID,
		Nonce:                  admitted.Nonce,
		ExpiresAt:              admitted.ExpiresAt,
		HandoffDeadline:        handoffDeadline,
		StableText:             text.StableText,
		DynamicText:            text.DynamicText,
		StableDigest:           text.StableDigest,
		DynamicDigest:          text.DynamicDigest,
		sessionID:              req.SessionID,
		providerOrigin:         grant.ProviderPublicOrigin,
		grant:                  grant.Grant,
	}, Outcome{Kind: "injected", Pack: nil}
}

func (c *Coordinator) rebuildSelectedContext(ctx context.Context, req TurnRequest, requestID string) (*PreparedContext, Outcome) {
	req.rebuildAttempt = 1
	req.ClientRequestID = requestID
	if len(req.ClientRequestID) > 112 {
		req.ClientRequestID = req.ClientRequestID[:112]
	}
	req.ClientRequestID += "-rebuild-1"
	return c.Prepare(ctx, req)
}

// prepareShadow holds the minimized query only in this process and starts the
// compile after the user dispatch path has already been released. Shadow work
// never admits, fetches, or injects a pack and is bounded independently from
// the caller's request context.
func (c *Coordinator) prepareShadow(req TurnRequest) {
	if c == nil || c.Grants == nil || c.Memory == nil {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), c.deadline())
		defer cancel()
		requestID := req.ClientRequestID
		if requestID == "" {
			requestID = newRequestID()
		}
		grant, err := c.Grants.RequestContextGrant(ctx, requestID, req.SessionID)
		if err != nil {
			return
		}
		query, useful := SanitizeQuery(req.UserContent)
		if !useful {
			query = ""
		}
		_, _ = c.Memory.Compile(ctx, grant.ProviderPublicOrigin, grant.Grant, CompileRequest{
			SceneID: req.SceneID, TaskScopeKey: req.TaskScopeKey, Destination: req.Destination, FactAt: req.FactAt, KnownAt: req.KnownAt,
			SchemaVersion:     1,
			ClientRequestID:   requestID,
			SessionID:         req.SessionID,
			Agent:             req.Agent,
			AdapterCapability: string(CapabilityShadowOnly),
			RepositoryHint:    repositoryHint(ctx, req.Cwd),
			Query:             query,
			RequestedAt:       c.now().UTC(),
		})
	}()
}

func (c *Coordinator) now() time.Time {
	if c.Now != nil {
		return c.Now()
	}
	return time.Now()
}

func nativeAdapterForAgent(agent string) string {
	switch agent {
	case "codex":
		return string(RuntimeCodexAppServer)
	case "opencode":
		return string(RuntimeOpenCodeServer)
	case "claude-code":
		return string(RuntimeClaudePrintResume)
	default:
		return string(RuntimeUnknown)
	}
}

// Receipt records the native delivery outcome. A failed first attempt is
// retried asynchronously with the same idempotent receipt. It NEVER triggers
// a resend of the user turn.
func (c *Coordinator) Receipt(parent context.Context, pack *PreparedContext, result DeliveryResult) {
	if pack == nil {
		return
	}
	pack.receiptOnce.Do(func() {
		pack.receiptMu.Lock()
		origin, grant := pack.providerOrigin, pack.grant
		injectionID, sessionID := pack.InjectionID, pack.sessionID
		pack.receiptMu.Unlock()
		if origin == "" || grant == "" || sessionID == "" || injectionID == "" {
			return
		}
		clearGrant := func() {
			pack.receiptMu.Lock()
			pack.grant = ""
			pack.receiptMu.Unlock()
		}
		ctx, cancel := context.WithTimeout(parent, 2*time.Second)
		err := c.Memory.Receipt(ctx, origin, grant, injectionID, ReceiptRequest{
			Delivered: result.Delivered, OutcomeCode: result.OutcomeCode, SessionID: sessionID,
		})
		cancel()
		if err == nil {
			clearGrant()
			return
		}

		request := ReceiptRequest{
			Delivered: result.Delivered, OutcomeCode: result.OutcomeCode, SessionID: sessionID,
		}
		go func() {
			defer clearGrant()
			for attempt := 0; attempt < 2; attempt++ {
				timer := time.NewTimer(c.receiptRetryDelay() * time.Duration(attempt+1))
				<-timer.C
				retryCtx, retryCancel := context.WithTimeout(context.Background(), 2*time.Second)
				retryErr := c.Memory.Receipt(retryCtx, origin, grant, injectionID, request)
				retryCancel()
				if retryErr == nil {
					return
				}
			}
		}()
	})
}

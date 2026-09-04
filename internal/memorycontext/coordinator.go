package memorycontext

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"time"

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
	// ReceiptRetryDelay is injectable for tests. Production uses a short
	// backoff because receipt retries must never delay or resend the user turn.
	ReceiptRetryDelay time.Duration
	// Now is injectable for tests.
	Now func() time.Time
}

// TurnRequest describes one new-turn enrichment decision.
type TurnRequest struct {
	ClientRequestID string
	SessionID       string
	Agent           string
	Cwd             string
	UserContent     string
	IsNewTurn       bool
	Mode            Mode
	Capability      Capability
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
func (c *Coordinator) Prepare(parent context.Context, req TurnRequest) (*PreparedContext, Outcome) {
	// Only new turns inject: steer/addendum input remains part of the
	// active turn (plan 8.3).
	if !req.IsNewTurn || req.Mode == ModeOff {
		return nil, Outcome{Kind: "skipped", Reason: "not_new_turn_or_not_enabled"}
	}
	if req.Mode == ModeShadow || req.Capability != CapabilityNativeHiddenV1 {
		c.prepareShadow(req)
		return nil, Outcome{Kind: "shadow_enqueued"}
	}

	deadline := c.deadline()
	ctx, cancel := context.WithTimeout(parent, deadline)
	defer cancel()
	started := time.Now()

	requestID := req.ClientRequestID
	if requestID == "" {
		requestID = newRequestID()
	}

	grant, err := c.Grants.RequestContextGrant(ctx, requestID, req.SessionID)
	if err != nil {
		return nil, Outcome{Kind: "dispatched", Reason: "grant_unavailable"}
	}

	query, useful := SanitizeQuery(req.UserContent)
	if !useful {
		query = ""
	}
	compileReq := CompileRequest{
		SchemaVersion:     1,
		ClientRequestID:   requestID,
		SessionID:         req.SessionID,
		Agent:             req.Agent,
		AdapterCapability: string(req.Capability),
		RepositoryHint:    repositoryHint(ctx, req.Cwd),
		Query:             query,
		RequestedAt:       started.UTC(),
	}
	compiled, err := c.Memory.Compile(ctx, grant.ProviderPublicOrigin, grant.Grant, compileReq)
	if err != nil {
		return nil, Outcome{Kind: "dispatched", Reason: "memory_unavailable"}
	}
	switch compiled.Outcome {
	case "off":
		return nil, Outcome{Kind: "skipped", Reason: "mode_off"}
	case "empty", "degraded":
		return nil, Outcome{Kind: "dispatched", Reason: compiled.Outcome}
	case "unsupported_adapter":
		return nil, Outcome{Kind: "skipped", Reason: "unsupported_adapter"}
	case "shadow_queued":
		return nil, Outcome{Kind: "shadow_enqueued"}
	}
	if compiled.Outcome != "ready" || compiled.Pack == nil {
		return nil, Outcome{Kind: "dispatched", Reason: "compile_outcome"}
	}

	admitted, err := c.Memory.Admit(ctx, grant.ProviderPublicOrigin, grant.Grant, compiled.Pack.PackID, AdmitRequest{
		ClientRequestID: requestID,
		SessionID:       req.SessionID,
		Agent:           req.Agent,
		Adapter:         nativeAdapterForAgent(req.Agent),
	})
	if err != nil {
		return nil, Outcome{Kind: "dispatched", Reason: "admission_failed"}
	}
	if admitted.Existing || admitted.Nonce == "" {
		// A duplicate request returns existing state; without a fresh nonce
		// there is nothing this attempt may deliver.
		return nil, Outcome{Kind: "skipped", Reason: "admission_existing"}
	}
	text, err := c.Memory.ConsumePack(ctx, grant.ProviderPublicOrigin, grant.Grant,
		compiled.Pack.PackID, req.SessionID, admitted.InjectionID, admitted.Nonce)
	if err != nil || text == nil || text.PackID != compiled.Pack.PackID ||
		(text.StableText == "" && text.DynamicText == "") {
		return nil, Outcome{Kind: "dispatched", Reason: "pack_unavailable"}
	}
	return &PreparedContext{
		PackID:         compiled.Pack.PackID,
		InjectionID:    admitted.InjectionID,
		Nonce:          admitted.Nonce,
		ExpiresAt:      admitted.ExpiresAt,
		StableText:     text.StableText,
		DynamicText:    text.DynamicText,
		StableDigest:   text.StableDigest,
		DynamicDigest:  text.DynamicDigest,
		sessionID:      req.SessionID,
		providerOrigin: grant.ProviderPublicOrigin,
		grant:          grant.Grant,
	}, Outcome{Kind: "injected", Pack: nil}
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
	if pack.providerOrigin == "" || pack.grant == "" || pack.sessionID == "" || pack.InjectionID == "" {
		return
	}
	pack.receiptOnce.Do(func() {
		ctx, cancel := context.WithTimeout(parent, 2*time.Second)
		err := c.Memory.Receipt(ctx, pack.providerOrigin, pack.grant, pack.InjectionID, ReceiptRequest{
			Delivered: result.Delivered, OutcomeCode: result.OutcomeCode, SessionID: pack.sessionID,
		})
		cancel()
		if err == nil {
			pack.grant = ""
			return
		}

		origin, grant := pack.providerOrigin, pack.grant
		injectionID, sessionID := pack.InjectionID, pack.sessionID
		request := ReceiptRequest{
			Delivered: result.Delivered, OutcomeCode: result.OutcomeCode, SessionID: sessionID,
		}
		go func() {
			defer func() { pack.grant = "" }()
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

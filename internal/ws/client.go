package ws

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	mathrand "math/rand/v2"
	"net"
	"net/http"
	"net/url"
	"os"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pocketctl/pocketctl/internal/daemon"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

const (
	// pingInterval is how often the daemon sends an app-level ping to the relay
	// (which replies with a pong, updating the relay's heartbeat).
	pingInterval = 10 * time.Second
	// pongWait is the read deadline: if NO message (pong, command, anything)
	// arrives within this window the connection is treated as dead and the read
	// loop returns so Run reconnects. It MUST be comfortably larger than
	// pingInterval (relay pongs every ~10s on an idle link). This is the primary
	// defense against silent half-open sockets, where ReadMessage would
	// otherwise block until OS TCP keepalive (~2h).
	pongWait = 30 * time.Second
	// writeWait bounds a single WriteMessage so a stuck socket can't block the
	// writer forever.
	writeWait = 10 * time.Second
	// maxBackoff caps the reconnect backoff delay.
	maxBackoff = 30 * time.Second
	// authRejectStopThreshold is how many CONSECUTIVE auth rejections (relay close
	// 4001 — invalid/revoked token) the daemon tolerates before it stops
	// reconnecting and parks until shutdown. Retrying a revoked token is futile;
	// once stopped, the user must re-login (`pocketctl login`) and restart the
	// daemon. >1 so a transient 4001 during a relay deploy doesn't permanently
	// park every daemon — a healthy register_ack resets the counter.
	authRejectStopThreshold = 3
	// connectionStatusQueueLimit bounds asynchronous observer delivery. A slow
	// observer must never hold up the connection loop or create one goroutine per
	// status change.
	connectionStatusQueueLimit = 16
	// defaultMaxOutCount / defaultMaxOutBytes bound the unacked outbound buffer.
	// At the cap the producer blocks (back-pressure) rather than dropping events.
	defaultMaxOutCount = 10000
	defaultMaxOutBytes = 64 << 20 // 64 MiB
	// registerAckWait is how long connectAndServe waits for register_ack before
	// replaying anyway. The relay normally replies within milliseconds; the
	// timeout covers legacy relays that never send register_ack (so replay
	// still proceeds, just without the readiness guarantee) and pathological
	// slow-DB edge cases.
	registerAckWait = 5 * time.Second
	// replayBatchSize / replayBatchGap pace the replay burst so a large unacked
	// buffer (e.g. accumulated during a long outage) doesn't overwhelm the relay
	// in a single sub-millisecond write storm that tears down the connection.
	replayBatchSize = 50
	replayBatchGap  = 50 * time.Millisecond
	// Transport-size rejection and the rate limit it can trigger must not use
	// the tight reconnect cadence reserved for planned Relay restarts.
	transportRejectReconnectFloor = 5 * time.Second
)

// bufferedEvent is a sent-but-unacked daemon event held for replay on reconnect.
type bufferedEvent struct {
	seq  int64
	data []byte // pre-marshaled JSON (includes the seq field)
}

// OnConnectStateChange is called when the relay connection state changes.
type OnConnectStateChange func(connected bool)

// DurableIngressDiagnostics is a local-only aggregate snapshot for daemon
// status. It deliberately contains no daemon, session, token, request, or
// event identifiers.
type DurableIngressDiagnostics struct {
	SpoolEvents   int
	SpoolBytes    int64
	EventWindow   int
	UnackedEvents int
	LastACKAt     time.Time
	Reconnects    uint64
}

// ConnectionStatus describes the daemon's recoverable relationship with the
// relay. It supplements OnStateChange without changing that older callback.
type ConnectionStatus string

const (
	ConnectionConnected     ConnectionStatus = "connected"
	ConnectionReconnecting  ConnectionStatus = "reconnecting"
	ConnectionBackpressured ConnectionStatus = "backpressured"
	ConnectionAuthUncertain ConnectionStatus = "auth_uncertain"
	ConnectionLoginRequired ConnectionStatus = "login_required"
	ConnectionRevoked       ConnectionStatus = "revoked"
	ConnectionStopped       ConnectionStatus = "stopped"
)

var errReconnectRequested = errors.New("relay requested reconnect")

var errOutputClosed = errors.New("daemon output channel closed")

type connectionStatusEvent struct {
	status   ConnectionStatus
	reason   string
	callback func(ConnectionStatus, string)
}

// OnEvent is invoked for every event leaving the daemon (just before it is
// forwarded to the relay). It lets the daemon inspect outgoing events and
// emit derived events — e.g. detecting a model change from an agent_text
// event's Model field and sending a session_model_changed. Returning a slice
// replaces the original event (return nil to forward it unchanged).
type OnEvent func(evt protocol.DaemonEvent) []protocol.DaemonEvent

type Client struct {
	relayURL string
	token    string
	tokenMu  sync.Mutex // protects token (refreshable at runtime via UpdateToken)
	// relayPin is the base64-encoded SHA-256 of the relay's leaf certificate
	// SPKI (SubjectPublicKeyInfo). When set, the dialer pins the TLS peer to
	// this key, defeating MITM even if a trusted CA is compromised. Empty =
	// standard system-CA validation only (backwards compatible).
	relayPin                   string
	conn                       *websocket.Conn
	connMu                     sync.Mutex
	writeMu                    sync.Mutex // protects WriteMessage on conn
	outputCh                   <-chan protocol.DaemonEvent
	sendCh                     chan []byte
	logger                     *slog.Logger
	daemonID                   string
	hostname                   string
	agents                     []string
	agentVersions              map[string]string
	agentLatests               map[string]string
	agentManageable            map[string]bool
	osName                     string
	localIP                    string
	arch                       string
	version                    string
	startedAt                  int64
	metricsFn                  func() (float64, float64, float64) // cpu, mem, disk
	openCodeRuntimeTelemetryFn func() protocol.OpenCodeRuntimeTelemetry
	// activeSessionIDsFn returns the session IDs this daemon currently owns.
	// Seeded into the register message so the relay can rebuild its
	// session→daemon routing table after a relay restart or daemon reconnect,
	// instead of losing every historical session to a cold in-memory map.
	activeSessionIDsFn func() []string
	CommandCh          chan protocol.ClientMessage
	// Callbacks are configured before Run and not replaced while it is running,
	// matching the existing OnStateChange configuration contract.
	OnStateChange OnConnectStateChange
	// OnControlMessage handles correlated control-plane replies directly from
	// the read pump. It must be configured before Run and return true only when
	// the message was consumed, keeping synchronous request/reply flows from
	// deadlocking behind the ordinary serial CommandCh consumer.
	OnControlMessage func(protocol.ClientMessage) bool
	// OnConnectionStatus receives asynchronously dispatched connection states.
	// Configure it before Run; replacing callback fields during Run is unsafe.
	OnConnectionStatus func(ConnectionStatus, string)
	OnReconnected      func()  // called after successful (re)connection + register
	OnEvent            OnEvent // optional hook: inspect/derive events before forwarding to relay
	// OnEventsAcknowledged receives stable event identities removed by a real
	// Relay event_ack. It is used by Codex startup replay to checkpoint source
	// lines only after the receiver has durably accepted their transport prefix.
	OnEventsAcknowledged func(eventIDs []string)
	// OnTokenRefresh is invoked when the relay rejects us with 4001 (invalid/expired
	// access token). It must attempt a refresh-token exchange and return the new
	// access token + true on success. On success the client reconnects with the new
	// token (no backoff, no auth-reject escalation); on failure the rejection count
	// keeps climbing and eventually the client parks. May be nil — without it the
	// client behaves as if refresh always fails (stops after authRejectStopThreshold).
	OnTokenRefresh func() (newAccessToken string, ok bool)

	// reconnectAttempt counts consecutive connections that never reached a
	// successful registration; it drives the exponential backoff and is reset to
	// 0 only once the relay confirms us with register_ack (NOT merely on a
	// successful WS dial — the relay accepts the upgrade and only then closes with
	// 4001 on a bad/revoked token, so a dial-time reset would let an invalid-token
	// daemon hammer the relay at the minimum interval forever). Written from the
	// readPump goroutine (onRegisterAck) and the Run goroutine (backoffSleep), so
	// it is atomic.
	reconnectAttempt atomic.Int64
	reconnectCount   atomic.Uint64

	// authRejectCount counts CONSECUTIVE relay auth rejections (close 4001) that
	// were NOT followed by a successful token refresh. Incremented in readPump on a
	// 4001 close, reset in onRegisterAck (healthy connection) and after a successful
	// OnTokenRefresh. Read in Run to decide when to stop reconnecting
	// (authRejectStopThreshold). Atomic for the same cross-goroutine reason.
	authRejectCount atomic.Int64

	// lastCloseAuthReject is set true by readPump when the connection was closed
	// with 4001, reset to false at the start of each connectAndServe. Read by Run
	// to decide whether to attempt a token refresh before reconnecting.
	lastCloseAuthReject atomic.Bool

	// registrationRejected is set for persistent business rejections such as a
	// free account exhausting its bound-host slots. Reconnecting with the same
	// credentials cannot fix that state, so Run parks until the daemon is
	// restarted after the user deletes a host or logs in again.
	registrationRejected atomic.Bool
	// registrationRevoked distinguishes a terminal remote revocation from other
	// registration rejections, which still report a stopped daemon.
	registrationRevoked atomic.Bool

	// fastReconnect is set by readPump when the relay announces a restart
	// (relay_restarting) and cleared in onRegisterAck after a successful
	// re-registration. While set, backoffSleep uses the compact
	// fastReconnectSteps cadence instead of the usual exponential backoff, so
	// the daemon re-polls the relay tightly as it comes back up. Read by Run
	// (backoffSleep) and written by readPump (relay_restarting) and
	// onRegisterAck — atomic for the same cross-goroutine reason as above.
	fastReconnect atomic.Bool
	// reconnectStatusPending keeps a specific relay status visible while Run is
	// backing off. It is changed to reconnecting only when the next attempt
	// actually begins.
	reconnectStatusPending atomic.Bool

	// serverRetryAfter is a one-shot reconnect floor supplied by the relay when
	// it is overloaded. It is consumed by the next reconnect sleep.
	serverRetryAfter atomic.Int64

	connectionStatusMu     sync.Mutex
	connectionStatusQueue  []connectionStatusEvent
	connectionStatusWorker bool

	// Connection liveness/timeouts. Default to the package consts; overridable
	// (e.g. shortened by tests) without touching the timing logic.
	pingInterval time.Duration
	pongWait     time.Duration
	writeWait    time.Duration
	// Jitter sources are configured before Run, like the existing callbacks.
	// They make fleet timing testable without sharing mutable RNG state.
	heartbeatJitter func(max time.Duration) time.Duration
	reconnectJitter func(base time.Duration) time.Duration

	// Outbound delivery buffer (at-least-once). Holds events sent on the current
	// or a prior connection that the relay has not yet acked. On reconnect the
	// buffer is replayed in seq order; the relay dedups by (daemon_id, seq) and
	// acks via event_ack, which trims the buffer. Guarded by outMu/outCond so a
	// full buffer applies back-pressure to producers instead of dropping events.
	outMu                    sync.Mutex
	outCond                  *sync.Cond
	outBuf                   []bufferedEvent
	outBytes                 int
	seqCtr                   int64 // monotonic, assigned at enqueue; never reset across reconnects
	ackedSeq                 int64 // highest seq the relay has acknowledged
	lastACKAt                time.Time
	draining                 bool // ctx cancelled — stop blocking producers
	ackKnown                 bool // register_ack processed on the current connection
	ackSupported             bool // relay advertised supports_event_ack (else legacy trim-on-write)
	flowControlSupported     bool // register_ack advertised the durable flow-control capability
	streamTransportSupported bool
	maxEventBytes            int
	maxChunkBytes            int
	outboundStreams          map[string]outboundContentStream
	eventWindow              int // maximum unacknowledged events while flow control is active
	flowRetryAfterMS         int
	flowBackpressured        bool
	fatalFlowBlockedSeq      int64  // permanent barrier for an event Relay can never admit
	fatalFlowReason          string // guarded by outMu; retained across reconnects
	outWaiters               int    // guarded by outMu; used by deterministic blocked-send tests
	// registerAckCh signals that register_ack arrived on the current connection.
	// connectAndServe waits on it before replaying the unacked buffer so the
	// relay has finished its async registerDaemon DB work (upsert/bind/routes)
	// and initialised the per-daemon seq cursor — otherwise a burst of replayed
	// events arrives before the relay is ready and the connection is torn down.
	// Recreated per connectAndServe call; closed by readPump via done.
	registerAckCh chan struct{}
	maxOutCount   int
	maxOutBytes   int
	// spool durably mirrors outBuf to disk so a daemon process crash doesn't lose
	// unacked events. nil when spooling is disabled (in-memory-only fallback).
	spool *spool
}

func NewClient(relayURL, token, daemonID string, agents []string, agentVersions map[string]string, agentLatests map[string]string, outputCh <-chan protocol.DaemonEvent, logger *slog.Logger) *Client {
	hostname, _ := os.Hostname()
	localIP := getLocalIP()
	osName := runtime.GOOS
	c := &Client{
		relayURL:        relayURL,
		token:           token,
		outputCh:        outputCh,
		sendCh:          make(chan []byte, 256),
		logger:          logger,
		daemonID:        daemonID,
		hostname:        hostname,
		agents:          agents,
		agentVersions:   agentVersions,
		agentLatests:    agentLatests,
		osName:          osName,
		localIP:         localIP,
		arch:            runtime.GOARCH,
		CommandCh:       make(chan protocol.ClientMessage, 64),
		pingInterval:    pingInterval,
		pongWait:        pongWait,
		writeWait:       writeWait,
		heartbeatJitter: boundedJitter,
		reconnectJitter: fullReconnectJitter,
		maxOutCount:     envInt("POCKETCTL_OUTBUF_MAX_COUNT", defaultMaxOutCount),
		maxOutBytes:     envInt("POCKETCTL_OUTBUF_MAX_BYTES", defaultMaxOutBytes),
		outboundStreams: make(map[string]outboundContentStream),
	}
	c.eventWindow = c.maxOutCount
	c.outCond = sync.NewCond(&c.outMu)
	return c
}

// InitSpool enables disk-backed durability for the unacked outbound buffer at
// the given path, and restores any events spooled before a previous crash. Must
// be called before Run (it seeds outBuf/seqCtr without locking). A load/open
// failure degrades to in-memory-only delivery rather than aborting startup.
func (c *Client) InitSpool(path string) error {
	restored, err := loadSpool(path)
	if err != nil {
		return err
	}
	s, err := openSpool(path)
	if err != nil {
		return err
	}
	c.spool = s
	if len(restored) > 0 {
		c.outBuf = restored
		var bytesN int
		var maxSeq int64
		for _, be := range restored {
			bytesN += len(be.data)
			if be.seq > maxSeq {
				maxSeq = be.seq
			}
		}
		c.outBytes = bytesN
		c.seqCtr = maxSeq // resume numbering past the highest restored seq
		// Everything below the lowest restored seq was already acked/trimmed before
		// the crash; tell the relay so its fresh persisted mark starts there (no
		// phantom gap before the replayed tail).
		c.ackedSeq = restored[0].seq - 1
		c.logger.Info("restored spooled events", "count", len(restored), "from_seq", restored[0].seq, "to_seq", maxSeq)
	}
	return nil
}

// envInt reads a positive integer from env, falling back to def.
func envInt(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		var n int
		if _, err := fmt.Sscanf(v, "%d", &n); err == nil && n > 0 {
			return n
		}
	}
	return def
}

// SetVersion sets the daemon version for register messages.
func (c *Client) SetVersion(v string) { c.version = v }

// SetAgentVersions updates the agent version map (e.g. after an agent upgrade).
func (c *Client) SetAgentVersions(v map[string]string) { c.agentVersions = v }

// SetAgentLatests updates the agent latest-version map (e.g. after re-checking npm registry).
func (c *Client) SetAgentLatests(v map[string]string) { c.agentLatests = v }

// SetAgentManageable updates the per-agent manageable flag map (user-owned install).
func (c *Client) SetAgentManageable(m map[string]bool) { c.agentManageable = m }

// ResendRegister re-sends the register message to push updated info (e.g. new agent versions after upgrade).
func (c *Client) ResendRegister() {
	c.connMu.Lock()
	conn := c.conn
	c.connMu.Unlock()
	if conn == nil {
		return
	}
	register := protocol.RegisterMessage{
		Type: "register", DaemonID: c.daemonID, Hostname: c.hostname, Agents: c.agents,
		AgentVersions:   c.agentVersions,
		AgentLatests:    c.agentLatests,
		AgentManageable: c.agentManageable,
		OS:              c.osName, IP: c.localIP, Arch: c.arch, Version: c.version, StartedAt: c.startedAt,
		SupportsQuotaGrant: true,
	}
	if c.activeSessionIDsFn != nil {
		register.ActiveSessionIDs = c.activeSessionIDsFn()
	}
	c.outMu.Lock()
	register.AckedSeq = c.ackedSeq // durable baseline so the relay seeds its persisted mark
	c.outMu.Unlock()
	c.SendMsg(register)
}

// SetStartedAt sets the daemon start timestamp for register messages.
func (c *Client) SetStartedAt(t int64) { c.startedAt = t }

// SetMetricsFn sets the function used to collect system metrics for ping messages.
func (c *Client) SetMetricsFn(fn func() (float64, float64, float64)) { c.metricsFn = fn }

// SetOpenCodeRuntimeTelemetryFn adds cumulative, content-free rollout counters
// to heartbeats without mixing them into session events or durable relay data.
func (c *Client) SetOpenCodeRuntimeTelemetryFn(fn func() protocol.OpenCodeRuntimeTelemetry) {
	c.openCodeRuntimeTelemetryFn = fn
}

// SetRelayPin sets the pinned relay certificate SPKI hash (base64-encoded
// SHA-256). When non-empty, the TLS handshake only succeeds if a certificate
// in the peer chain has a matching public key — defeating MITM by a rogue CA
// or a TLS-terminating proxy. The value is typically loaded from the
// POCKETCTL_RELAY_PIN env var by the daemon bootstrap.
func (c *Client) SetRelayPin(pin string) { c.relayPin = pin }

// dialer returns the websocket.Dialer for connecting to the relay. When a pin
// is configured and the scheme is wss://, the dialer carries a TLS client config
// that verifies the peer certificate chain AND pins a public key — so a MITM
// with a valid-but-malicious cert (rogue CA, TLS-terminating proxy) is rejected.
// For ws:// (plain) or when no pin is set, it falls back to DefaultDialer.
func (c *Client) dialer() *websocket.Dialer {
	if c.relayPin == "" || !strings.HasPrefix(c.relayURL, "wss://") {
		return websocket.DefaultDialer
	}
	return &websocket.Dialer{
		NetDialContext:   websocket.DefaultDialer.NetDialContext,
		HandshakeTimeout: websocket.DefaultDialer.HandshakeTimeout,
		TLSClientConfig:  &tls.Config{VerifyPeerCertificate: c.verifyPinnedCert},
		// Force the standard chain validation too: VerifyPeerCertificate runs
		// AFTER the normal chain build, so we get both the system-CA check and
		// our pin check. gorilla sets the intermediates/root from the handshake.
	}
}

// verifyPinnedCert is the VerifyPeerCertificate callback. Go has already parsed
// the peer's certificate chain (rawCerts) by this point but has NOT validated it
// against roots when a custom VerifyPeerCertificate is set without
// InsecureSkipVerify — so we do a manual chain + pin check here.
func (c *Client) verifyPinnedCert(rawCerts [][]byte, _ [][]*x509.Certificate) error {
	if len(rawCerts) == 0 {
		return errors.New("relay presented no certificates")
	}
	// Build and verify the chain against system roots so a self-signed or
	// expired cert is rejected regardless of the pin.
	certs := make([]*x509.Certificate, 0, len(rawCerts))
	for _, raw := range rawCerts {
		cert, err := x509.ParseCertificate(raw)
		if err != nil {
			return fmt.Errorf("parse peer cert: %w", err)
		}
		certs = append(certs, cert)
	}
	roots, err := x509.SystemCertPool()
	if err != nil {
		roots = x509.NewCertPool()
	}
	if _, err := certs[0].Verify(x509.VerifyOptions{Roots: roots}); err != nil {
		return fmt.Errorf("relay cert chain invalid: %w", err)
	}
	// Pin check: at least one cert in the chain must have a matching SPKI hash.
	pinBytes, err := base64.StdEncoding.DecodeString(c.relayPin)
	if err != nil {
		return fmt.Errorf("invalid relay pin (expected base64): %w", err)
	}
	for _, cert := range certs {
		spki := sha256.Sum256(cert.RawSubjectPublicKeyInfo)
		if equalHash(spki[:], pinBytes) {
			return nil // pin matched
		}
	}
	return errors.New("relay cert does not match pinned key (possible MITM)")
}

// equalHash is a constant-time comparison to avoid timing side channels.
func equalHash(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	var v byte
	for i := range a {
		v |= a[i] ^ b[i]
	}
	return v == 0
}

// UpdateToken replaces the access token used for future connections. Called after
// a successful token refresh so the next reconnect dials with the fresh token.
func (c *Client) UpdateToken(newToken string) {
	c.tokenMu.Lock()
	c.token = newToken
	c.tokenMu.Unlock()
}

// SetActiveSessionIDsFn sets the function used to collect this daemon's active
// session IDs for the register message (rebuilds the relay's routing table).
func (c *Client) SetActiveSessionIDsFn(fn func() []string) { c.activeSessionIDsFn = fn }

// DurableIngressDiagnostics returns a race-free local snapshot. Spool fields
// are zero when disk spooling is disabled; unacked fields remain available for
// the in-memory fallback.
func (c *Client) DurableIngressDiagnostics() DurableIngressDiagnostics {
	c.outMu.Lock()
	defer c.outMu.Unlock()
	diagnostics := DurableIngressDiagnostics{
		EventWindow:   c.eventWindow,
		UnackedEvents: len(c.outBuf),
		LastACKAt:     c.lastACKAt,
		Reconnects:    c.reconnectCount.Load(),
	}
	if c.spool != nil {
		diagnostics.SpoolEvents = len(c.outBuf)
		diagnostics.SpoolBytes = int64(c.outBytes)
	}
	return diagnostics
}

func (c *Client) Run(ctx context.Context) error {
	// Unblock any producer parked on a full outbound buffer when we're shutting
	// down, so back-pressure doesn't outlive ctx cancellation.
	go func() {
		<-ctx.Done()
		c.outMu.Lock()
		c.draining = true
		c.outCond.Broadcast()
		c.outMu.Unlock()
	}()
	firstConnection := true
	for {
		if firstConnection {
			firstConnection = false
		} else {
			c.reconnectCount.Add(1)
		}
		if c.reconnectStatusPending.Swap(false) {
			c.notifyConnectionStatus(ConnectionReconnecting, "")
		}
		err := c.connectAndServe(ctx)
		if ctx.Err() != nil {
			return ctx.Err()
		}
		c.notifyState(false)
		if errors.Is(err, errOutputClosed) {
			c.notifyConnectionStatus(ConnectionStopped, "output_closed")
			return nil
		}

		// If the relay rejected our access token (4001), try to refresh it before
		// anything else: a remote daemon whose 24h access token simply expired must
		// self-heal via its refresh token — the user can't be expected to reach the
		// machine to re-login. On success, reconnect immediately with the new token.
		if c.lastCloseAuthReject.Load() && c.OnTokenRefresh != nil {
			c.logger.Info("auth rejected; attempting token refresh")
			newToken, ok := c.OnTokenRefresh()
			if ok && newToken != "" {
				c.UpdateToken(newToken)
				c.authRejectCount.Store(0) // refresh worked — forgive prior rejections
				c.reconnectAttempt.Store(0)
				c.logger.Info("token refreshed; reconnecting")
				continue // reconnect at once, no backoff
			}
			c.logger.Error("token refresh failed; refresh token may be expired — run `pocketctl login` on this machine")
		}

		// Refresh wasn't possible or failed, and the relay keeps rejecting us —
		// stop hammering. Park until shutdown (returning would let RunLoop restart
		// the loop); the user must re-login and restart the daemon. A healthy
		// register_ack (or a successful refresh) resets the counter, so this only
		// trips when the refresh token is genuinely dead.
		if c.authRejectCount.Load() >= authRejectStopThreshold {
			c.logger.Error("relay auth rejected repeatedly even after refresh attempts; pausing reconnect until you run `pocketctl login` and restart the daemon",
				"consecutive", c.authRejectCount.Load())
			<-ctx.Done()
			return ctx.Err()
		}
		if c.registrationRejected.Load() {
			c.logger.Error("relay rejected daemon registration; pausing reconnect until a host slot is released and the daemon is restarted")
			if !c.registrationRevoked.Load() {
				c.notifyConnectionStatus(ConnectionStopped, "registration_rejected")
			}
			<-ctx.Done()
			return ctx.Err()
		}
		if !errors.Is(err, errReconnectRequested) {
			c.notifyConnectionStatus(ConnectionReconnecting, err.Error())
		}
		c.logger.Error("connection lost, reconnecting", "error", err)
		if !c.backoffSleep(ctx) {
			return ctx.Err()
		}
	}
}

func (c *Client) connectAndServe(ctx context.Context) error {
	// New connection attempt — clear the "last close was auth reject" flag so a
	// non-4001 close on this attempt isn't mistaken for an auth failure.
	c.lastCloseAuthReject.Store(false)
	relayURL := c.relayURL
	// Ensure path ends with /ws
	if !strings.HasSuffix(relayURL, "/ws") {
		relayURL = strings.TrimRight(relayURL, "/") + "/ws"
	}
	u, err := url.Parse(relayURL)
	if err != nil {
		return fmt.Errorf("parse relay URL: %w", err)
	}
	q := u.Query()
	q.Set("type", "daemon")
	u.RawQuery = q.Encode()

	// Send the JWT in the Authorization header rather than the URL query, so it
	// never lands in proxy access logs / referrers.
	c.tokenMu.Lock()
	tok := c.token
	c.tokenMu.Unlock()
	hdr := http.Header{}
	hdr.Set("Authorization", "Bearer "+tok)

	c.logger.Info("connecting to relay", "url", u.Host)
	dialer := c.dialer()
	conn, _, err := dialer.DialContext(ctx, u.String(), hdr)
	if err != nil {
		return fmt.Errorf("dial: %w", err)
	}
	c.connMu.Lock()
	c.conn = conn
	c.connMu.Unlock()

	// Reset per-connection ack capability: re-determined by this connection's
	// register_ack. Until then we buffer (don't trim on write).
	c.outMu.Lock()
	c.ackKnown = false
	c.ackSupported = false
	c.flowControlSupported = false
	c.streamTransportSupported = false
	c.maxEventBytes = 0
	c.maxChunkBytes = 0
	c.eventWindow = c.maxOutCount
	c.flowRetryAfterMS = 0
	c.flowBackpressured = c.fatalFlowBlockedSeq > 0
	fatalReason := c.fatalFlowReason
	hasFatalBarrier := c.fatalFlowBlockedSeq > 0
	c.outMu.Unlock()
	// Fresh per-connection ack signal (readPump closes/sends on register_ack).
	c.registerAckCh = make(chan struct{}, 1)

	// NOTE: do NOT reset reconnectAttempt here. A successful dial only means the
	// relay accepted the WS upgrade — it may still close us with 4001 if the token
	// is invalid/revoked (relay validates after upgrade). The backoff is reset in
	// onRegisterAck, once the relay has actually confirmed our registration.

	c.notifyState(true)
	if hasFatalBarrier {
		c.notifyConnectionStatus(ConnectionBackpressured, fatalReason)
	} else {
		c.notifyConnectionStatus(ConnectionConnected, "")
	}

	c.logger.Info("sending register", "daemonID", c.daemonID, "hostname", c.hostname)
	register := protocol.RegisterMessage{
		Type: "register", DaemonID: c.daemonID, Hostname: c.hostname, Agents: c.agents,
		AgentVersions:   c.agentVersions,
		AgentLatests:    c.agentLatests,
		AgentManageable: c.agentManageable,
		OS:              c.osName, IP: c.localIP, Arch: c.arch, Version: c.version, StartedAt: c.startedAt,
		SupportsQuotaGrant: true,
	}
	if c.activeSessionIDsFn != nil {
		register.ActiveSessionIDs = c.activeSessionIDsFn()
	}
	c.outMu.Lock()
	register.AckedSeq = c.ackedSeq // durable baseline so the relay seeds its persisted mark
	c.outMu.Unlock()
	c.SendMsg(register)
	c.logger.Info("register sent")

	done := make(chan struct{})
	readErr := make(chan error, 1)
	go c.readPump(ctx, done, readErr)
	go c.pingPump(ctx, done)
	go func() {
		<-done
		c.outMu.Lock()
		c.outCond.Broadcast()
		c.outMu.Unlock()
	}()

	// Wait for register_ack before replaying. The relay's registerDaemon does
	// async DB work (upsert/bind/rebuild routes) and only seeds its per-daemon
	// seq cursor inside that handler; replaying before it completes means the
	// relay receives events it can't yet route/persist, and a large burst can
	// tear the connection down (the "close sent" reconnect storm). We wait up
	// to registerAckWait so a legacy relay (no register_ack) still replays.
	select {
	case <-c.registerAckCh:
		c.logger.Info("register_ack received, replaying unacked buffer")
	case <-time.After(registerAckWait):
		c.logger.Warn("register_ack timeout, replaying without readiness guarantee")
	case <-done:
		return readPumpError(readErr, "connection closed before register_ack")
	}

	// Replay any events the relay hasn't acked (lost mid-flight on the previous
	// connection) before resuming live delivery, so no event is silently dropped
	// across a reconnect. The relay dedups replayed events by (daemon_id, seq).
	if !c.replayOutbound(ctx, conn, done) {
		return readPumpError(readErr, "connection closed during durable replay")
	}

	// Re-announce current authoritative session snapshots only after every
	// durable event from the previous connection has been replayed. Otherwise a
	// historical status in the backlog can overwrite the fresh resync state.
	if c.OnReconnected != nil {
		c.OnReconnected()
	}

	for {
		select {
		case evt, ok := <-c.outputCh:
			if !ok {
				conn.Close()
				return errOutputClosed
			}
			// Give the daemon a chance to inspect the event and emit derived
			// events (e.g. session_model_changed from an agent_text model change)
			// before forwarding to the relay.
			if c.OnEvent != nil {
				for _, e := range c.OnEvent(evt) {
					if !c.sendEventUntil(e, done) {
						return fmt.Errorf("connection closed")
					}
				}
			} else {
				if !c.sendEventUntil(evt, done) {
					return fmt.Errorf("connection closed")
				}
			}
		case <-done:
			return readPumpError(readErr, "connection closed")
		case <-ctx.Done():
			conn.Close()
			return ctx.Err()
		}
	}
}

func (c *Client) readPump(ctx context.Context, done chan struct{}, readErr chan<- error) {
	defer close(done)
	report := func(err error) {
		select {
		case readErr <- err:
		default:
		}
	}
	c.connMu.Lock()
	conn := c.conn
	c.connMu.Unlock()

	// Liveness: require some inbound traffic within pongWait. The relay replies
	// to our 10s app-level ping with a pong, so a healthy idle link delivers a
	// message every ~10s — well inside the 30s deadline. If the socket dies
	// silently (no FIN/RST: NAT timeout, server crash, cable pull), no message
	// arrives, the deadline fires, ReadMessage returns an error, and Run
	// reconnects — instead of blocking until OS TCP keepalive (~2h).
	_ = conn.SetReadDeadline(time.Now().Add(c.pongWait))
	// Defensive: also refresh on WS protocol-level pongs, in case a future relay
	// sends control-frame pongs in addition to the app-level pong message.
	conn.SetPongHandler(func(string) error {
		return conn.SetReadDeadline(time.Now().Add(c.pongWait))
	})

	for {
		_, msg, err := conn.ReadMessage()
		if err != nil {
			// 4001 = relay rejected us on auth (invalid/revoked/expired token or
			// missing auth). Flag it so Run attempts a token refresh before giving
			// up; count it so Run can stop reconnecting after authRejectStopThreshold
			// if refresh also keeps failing.
			if ce, ok := err.(*websocket.CloseError); ok {
				c.handleWebSocketClose(ce)
			}
			report(err)
			return
		}
		// Any inbound message proves the link is alive — extend the deadline.
		_ = conn.SetReadDeadline(time.Now().Add(c.pongWait))
		var base struct {
			Type               string `json:"type"`
			Error              string `json:"error"`
			Code               string `json:"code"`
			Reason             string `json:"reason"`
			Message            string `json:"message"`
			GracePeriodSeconds int    `json:"grace_period_seconds"`
			UpToSeq            int64  `json:"up_to_seq"`
			Used               int    `json:"used"`
			Limit              int    `json:"limit"`
		}
		if err := json.Unmarshal(msg, &base); err != nil {
			continue
		}

		// Transport-level delivery control (not session commands): handle here
		// and don't forward to CommandCh.
		switch base.Type {
		case "event_ack":
			var ack protocol.EventAckMessage
			if json.Unmarshal(msg, &ack) == nil {
				c.handleEventAck(ack)
			}
			continue
		case "register_ack":
			var ack protocol.RegisterAckMessage
			if json.Unmarshal(msg, &ack) == nil {
				c.onRegisterAck(ack)
			}
			continue
		case "flow_control":
			var flow protocol.FlowControlMessage
			if json.Unmarshal(msg, &flow) == nil {
				c.onFlowControl(flow)
			}
			continue
		case "relay_restarting":
			err := c.handleRelayDisconnect(protocol.DisconnectMessage{Type: base.Type, Reason: "relay_restarting"})
			conn.Close()
			report(err)
			return
		case "register_rejected":
			var rejected protocol.RegisterRejectedMessage
			if json.Unmarshal(msg, &rejected) != nil {
				rejected = protocol.RegisterRejectedMessage{
					Type: base.Type, Reason: base.Reason, Message: base.Message,
					Used: base.Used, Limit: base.Limit,
				}
			}
			c.handleRegisterRejected(rejected)
			c.logger.Error("relay rejected daemon registration", "reason", rejected.Reason,
				"message", rejected.Message, "used", rejected.Used, "limit", rejected.Limit,
				"retryable", rejected.Retryable, "retry_after_ms", rejected.RetryAfterMS)
			conn.Close()
			report(errReconnectRequested)
			return
		}

		if base.Type == "kicked" || base.Type == "disconnect" || (base.Type == "error" && base.Code == "DAEMON_LIMIT_REACHED") {
			var disconnect protocol.DisconnectMessage
			if err := json.Unmarshal(msg, &disconnect); err != nil {
				disconnect = protocol.DisconnectMessage{Type: base.Type, Reason: base.Reason, Message: base.Message, GracePeriodSeconds: base.GracePeriodSeconds}
			}
			if disconnect.Reason == "" && base.Type == "error" {
				disconnect.Reason = base.Code
			}
			err := c.handleRelayDisconnect(disconnect)
			if !c.waitRelayGracePeriod(ctx, disconnect.GracePeriodSeconds) {
				report(ctx.Err())
				return
			}
			conn.Close()
			report(err)
			return
		}

		// Forward all other messages to command channel
		var cmdMsg protocol.ClientMessage
		if err := json.Unmarshal(msg, &cmdMsg); err != nil {
			continue
		}
		if c.OnControlMessage != nil && c.OnControlMessage(cmdMsg) {
			continue
		}
		select {
		case c.CommandCh <- cmdMsg:
		default:
		}
	}
}

func (c *Client) pingPump(ctx context.Context, done chan struct{}) {
	initial := time.NewTimer(c.heartbeatInitialDelay())
	defer initial.Stop()
	select {
	case <-initial.C:
		c.sendHeartbeat()
	case <-done:
		return
	case <-ctx.Done():
		return
	}
	ticker := time.NewTicker(c.pingInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			c.sendHeartbeat()
		case <-done:
			return
		case <-ctx.Done():
			return
		}
	}
}

func (c *Client) handleWebSocketClose(closeErr *websocket.CloseError) {
	switch closeErr.Code {
	case 4001:
		c.lastCloseAuthReject.Store(true)
		n := c.authRejectCount.Add(1)
		c.logger.Error(
			"relay rejected the connection: token invalid/expired/revoked",
			"reason", closeErr.Text, "consecutive", n,
		)
	case 4008:
		c.registrationRejected.Store(true)
		c.logger.Error("relay rejected daemon registration", "reason", closeErr.Text)
	case 4003, 4029:
		c.fastReconnect.Store(false)
		c.setServerRetryAfter(transportRejectReconnectFloor)
		c.reconnectStatusPending.Store(true)
		c.notifyConnectionStatus(ConnectionBackpressured, closeErr.Text)
	}
}

func (c *Client) heartbeatInitialDelay() time.Duration {
	const maxInitialHeartbeatJitter = 10 * time.Second
	if c.heartbeatJitter == nil {
		return 0
	}
	delay := c.heartbeatJitter(maxInitialHeartbeatJitter)
	if delay < 0 {
		return 0
	}
	if delay > maxInitialHeartbeatJitter {
		return maxInitialHeartbeatJitter
	}
	return delay
}

func (c *Client) sendHeartbeat() {
	ping := protocol.PingMessage{Type: "ping"}
	if c.metricsFn != nil {
		ping.CpuPct, ping.MemPct, ping.DiskPct = c.metricsFn()
	}
	if c.openCodeRuntimeTelemetryFn != nil {
		snapshot := c.openCodeRuntimeTelemetryFn()
		ping.OpenCodeRuntime = &snapshot
	}
	c.SendMsg(ping)
}

func (c *Client) SendMsg(v any) {
	if err := c.sendMsg(v); err != nil {
		c.logger.Error("send msg failed", "error", err)
	}
}

// SendControlPayload writes one already-marshaled control-plane request and
// reports transport failure to its bounded request/reply caller.
func (c *Client) SendControlPayload(data []byte) error {
	if !json.Valid(data) {
		return fmt.Errorf("invalid control payload")
	}
	return c.sendMsg(json.RawMessage(data))
}

func (c *Client) sendMsg(v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return fmt.Errorf("marshal: %w", err)
	}
	c.connMu.Lock()
	conn := c.conn
	c.connMu.Unlock()
	if conn == nil {
		return fmt.Errorf("websocket disconnected")
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	_ = conn.SetWriteDeadline(time.Now().Add(c.writeWait))
	if err := conn.WriteMessage(websocket.TextMessage, data); err != nil {
		// On a half-open socket a write fails (TCP eventually gives up) while the
		// read side stays blocked. Close the conn so readPump's ReadMessage
		// errors out, closes `done`, and Run reconnects — otherwise a failed ping
		// write would just be logged and the daemon would hang on a dead link.
		// Closing the captured conn is safe even if it's already been replaced by
		// a fresh connection (we only close this specific one).
		conn.Close()
		return fmt.Errorf("write: %w", err)
	}
	return nil
}

// sendEvent delivers a daemon event to the relay with at-least-once semantics:
// it is stamped with a sequence number, retained in the outbound buffer until
// acked, and written to the current connection. Unlike SendMsg, a write failure
// here does NOT drop the event — it stays buffered for replay on reconnect.
func (c *Client) sendEvent(evt protocol.DaemonEvent) {
	c.sendEventUntil(evt, nil)
}

func (c *Client) sendEventUntil(evt protocol.DaemonEvent, stop <-chan struct{}) bool {
	frames, ok := c.appendPreparedOutboundUntil(&evt, stop)
	if !ok {
		return false
	}
	for _, frame := range frames {
		if !c.writeBuffered(frame.seq, frame.data, stop) {
			return false
		}
	}
	return true
}

func (c *Client) appendPreparedOutboundUntil(
	evt *protocol.DaemonEvent,
	stop <-chan struct{},
) ([]bufferedEvent, bool) {
	c.outMu.Lock()
	for {
		if c.draining || channelClosed(stop) {
			c.outMu.Unlock()
			return nil, false
		}
		prepared, err := c.prepareOutboundLocked(evt, c.seqCtr+1)
		if err != nil {
			c.outMu.Unlock()
			c.logger.Error("event transport preparation failed", "type", evt.Type, "error", err)
			return nil, false
		}
		totalBytes := 0
		for _, frame := range prepared.frames {
			totalBytes += len(frame.data)
		}
		if c.streamTransportSupported &&
			(len(prepared.frames) > c.maxOutCount || totalBytes > c.maxOutBytes) {
			raw, marshalErr := json.Marshal(evt)
			if marshalErr != nil {
				c.outMu.Unlock()
				c.logger.Error("event marshal error", "error", marshalErr)
				return nil, false
			}
			prepared, err = c.prepareDeliveryError(*evt, raw, c.seqCtr+1)
			if err != nil {
				c.outMu.Unlock()
				c.logger.Error("event delivery error preparation failed", "type", evt.Type, "error", err)
				return nil, false
			}
			totalBytes = len(prepared.frames[0].data)
		}
		full := len(c.outBuf)+len(prepared.frames) > c.maxOutCount ||
			c.outBytes+totalBytes > c.maxOutBytes
		if !c.streamTransportSupported {
			full = len(c.outBuf) >= c.maxOutCount || c.outBytes >= c.maxOutBytes
		}
		if full {
			c.outWaiters++
			c.outCond.Wait()
			c.outWaiters--
			continue
		}
		if len(prepared.quarantine) > 0 {
			if err := c.spool.quarantine(prepared.quarantine); err != nil {
				c.logger.Error("event quarantine failed", "type", prepared.originalType, "error", err)
			}
		}
		for _, frame := range prepared.frames {
			c.outBuf = append(c.outBuf, frame)
			c.outBytes += len(frame.data)
			c.spool.append(frame.data)
			c.seqCtr = frame.seq
		}
		if prepared.streamID != "" {
			if prepared.streamFinal {
				delete(c.outboundStreams, prepared.streamID)
			} else {
				c.outboundStreams[prepared.streamID] = prepared.streamState
			}
		}
		c.outMu.Unlock()
		return prepared.frames, true
	}
}

// appendOutbound assigns the next seq, marshals the event, and appends it to the
// unacked buffer. If the buffer is at its cap it blocks (back-pressure) until an
// ack frees space or the client is draining. Flow-control windows and permanent
// sequence barriers are intentionally enforced only after this durable append,
// at the shared live/replay transmission boundary. Returns ok=false when
// draining or on marshal error. Called only from the single serve-loop
// goroutine, so seqCtr increments are serialized.
func (c *Client) appendOutbound(evt *protocol.DaemonEvent) (int64, []byte, bool) {
	return c.appendOutboundUntil(evt, nil)
}

func (c *Client) appendOutboundUntil(evt *protocol.DaemonEvent, stop <-chan struct{}) (int64, []byte, bool) {
	c.outMu.Lock()
	for !c.draining && (len(c.outBuf) >= c.maxOutCount || c.outBytes >= c.maxOutBytes) {
		if channelClosed(stop) {
			c.outMu.Unlock()
			return 0, nil, false
		}
		c.outWaiters++
		c.outCond.Wait()
		c.outWaiters--
	}
	if c.draining || channelClosed(stop) {
		c.outMu.Unlock()
		return 0, nil, false
	}
	c.seqCtr++
	seq := c.seqCtr
	evt.Seq = seq
	data, err := json.Marshal(evt)
	if err != nil {
		c.seqCtr-- // nothing buffered; roll back so seq stays contiguous
		c.outMu.Unlock()
		c.logger.Error("event marshal error", "error", err)
		return 0, nil, false
	}
	c.outBuf = append(c.outBuf, bufferedEvent{seq: seq, data: data})
	c.outBytes += len(data)
	c.spool.append(data) // durable mirror (nil-safe, best-effort)
	c.outMu.Unlock()
	return seq, data, true
}

func channelClosed(ch <-chan struct{}) bool {
	if ch == nil {
		return false
	}
	select {
	case <-ch:
		return true
	default:
		return false
	}
}

// writeBuffered transmits one already-durable event on the current connection.
// Live and replay writes both delegate to writeBufferedTo, so a flow window or
// fatal sequence barrier is checked under the same outMu ordering as ACK and
// flow-control updates. A stopped wait never removes the buffered/spooled event.
func (c *Client) writeBuffered(seq int64, data []byte, stop <-chan struct{}) bool {
	c.connMu.Lock()
	conn := c.conn
	c.connMu.Unlock()
	if conn == nil {
		return true // no live conn; the durable event will replay on reconnect
	}
	return c.writeBufferedTo(context.Background(), conn, seq, data, stop)
}

func (c *Client) writeBufferedTo(
	ctx context.Context,
	conn *websocket.Conn,
	seq int64,
	data []byte,
	stop <-chan struct{},
) bool {
	c.outMu.Lock()
	if !c.waitTransmitPermitLocked(ctx, seq, stop) {
		c.outMu.Unlock()
		return false
	}
	if seq <= c.ackedSeq {
		c.outMu.Unlock()
		return true
	}
	// Keep outMu through the bounded socket write. This gives flow-control
	// installation and transmission a total order and preserves a single lock
	// direction (outMu -> writeMu); no writer holds writeMu while taking outMu.
	c.writeMu.Lock()
	_ = conn.SetWriteDeadline(time.Now().Add(c.writeWait))
	err := conn.WriteMessage(websocket.TextMessage, data)
	c.writeMu.Unlock()
	if err != nil {
		c.outMu.Unlock()
		c.logger.Error("event write error", "error", err, "seq", seq, "len", len(data))
		conn.Close()
		return false
	}
	legacy := c.ackKnown && !c.ackSupported
	if legacy {
		c.trimOutboundLocked(seq)
	}
	c.outMu.Unlock()
	return true
}

// replayOutbound re-sends every unacked event, in seq order, on a freshly
// (re)connected socket. Called after register so replayed events precede live
// ones on the wire.
// replayOutbound re-sends every unacked event to the relay in seq order. Events
// are written in batches (replayBatchSize) with a short gap (replayBatchGap)
// between batches so a large accumulated buffer — e.g. hundreds of events from a
// long outage — doesn't hit the relay as a single sub-millisecond write storm
// that overwhelms its WS layer and tears the connection down. The gap is also
// cancellable via ctx so a shutdown doesn't wait on the full pacing.
func (c *Client) replayOutbound(ctx context.Context, conn *websocket.Conn, done <-chan struct{}) bool {
	c.outMu.Lock()
	pending := make([]bufferedEvent, len(c.outBuf))
	copy(pending, c.outBuf)
	c.outMu.Unlock()
	if len(pending) == 0 {
		return true
	}
	c.logger.Info("replaying unacked events", "count", len(pending), "from_seq", pending[0].seq, "batch", replayBatchSize)
	for i, be := range pending {
		if !c.writeBufferedTo(ctx, conn, be.seq, be.data, done) {
			return false
		}
		c.outMu.Lock()
		flowControlled := c.flowControlSupported
		c.outMu.Unlock()
		// Pace between batches: after every replayBatchSize-th write, pause so the
		// relay can persist/route the burst before the next one arrives. Skip the
		// pause on the very last event (nothing follows).
		if !flowControlled && (i+1)%replayBatchSize == 0 && i+1 < len(pending) {
			select {
			case <-time.After(replayBatchGap):
			case <-ctx.Done():
				return false
			case <-done:
				return false
			}
		}
	}
	return true
}

func (c *Client) waitTransmitPermit(ctx context.Context, seq int64, done <-chan struct{}) bool {
	c.outMu.Lock()
	defer c.outMu.Unlock()
	return c.waitTransmitPermitLocked(ctx, seq, done)
}

func (c *Client) waitTransmitPermitLocked(ctx context.Context, seq int64, done <-chan struct{}) bool {
	for seq > c.ackedSeq && ((c.fatalFlowBlockedSeq > 0 && seq >= c.fatalFlowBlockedSeq) ||
		(c.flowControlSupported && seq > c.ackedSeq+int64(c.eventWindow))) {
		if c.transmitWaitStoppedLocked(ctx, done) {
			return false
		}
		c.outWaiters++
		c.outCond.Wait()
		c.outWaiters--
	}
	return !c.transmitWaitStoppedLocked(ctx, done)
}

func (c *Client) transmitWaitStoppedLocked(ctx context.Context, done <-chan struct{}) bool {
	return c.draining || ctx.Err() != nil || channelClosed(done)
}

// trimOutbound removes all buffered events with seq <= uptoSeq (acknowledged or,
// for a legacy relay, written) and wakes any producer blocked on a full buffer.
func (c *Client) trimOutbound(uptoSeq int64) {
	c.outMu.Lock()
	c.trimOutboundLocked(uptoSeq)
	c.outMu.Unlock()
}

func (c *Client) trimOutboundLocked(uptoSeq int64) []string {
	ackAdvanced := false
	if uptoSeq > c.ackedSeq {
		c.ackedSeq = uptoSeq
		ackAdvanced = true
	}
	i := 0
	for i < len(c.outBuf) && c.outBuf[i].seq <= uptoSeq {
		c.outBytes -= len(c.outBuf[i].data)
		i++
	}
	eventIDs := stableEventIDs(c.outBuf[:i])
	if i > 0 {
		c.outBuf = append(c.outBuf[:0], c.outBuf[i:]...)
		c.spool.rewrite(c.outBuf) // shrink the durable mirror to the remaining unacked set
	}
	if i > 0 || ackAdvanced {
		c.outCond.Broadcast()
	}
	return eventIDs
}

func stableEventIDs(events []bufferedEvent) []string {
	var eventIDs []string
	for _, event := range events {
		var envelope struct {
			EventID string `json:"event_id"`
		}
		if json.Unmarshal(event.data, &envelope) == nil && envelope.EventID != "" {
			eventIDs = append(eventIDs, envelope.EventID)
		}
	}
	return eventIDs
}

// onRegisterAck records whether this relay supports event_ack. A legacy relay
// (no support) gets best-effort delivery: the current buffer is trimmed and
// subsequent events are trimmed on successful write.
func (c *Client) onRegisterAck(msg protocol.RegisterAckMessage) {
	// Signal connectAndServe that the relay has confirmed registration and
	// finished its registerDaemon bookkeeping — it may now safely replay the
	// unacked buffer. Non-blocking: the channel is buffered(1) and recreated
	// per connection, so this never blocks readPump.
	select {
	case c.registerAckCh <- struct{}{}:
	default:
	}
	// The relay confirmed our registration — this connection is genuinely usable
	// (token valid, routes rebuilt), so reset the backoff. Until this point the
	// connection could still be torn down with 4001 on a bad token, which must
	// keep the backoff growing.
	c.reconnectAttempt.Store(0)
	c.fastReconnect.Store(false)
	// A confirmed registration means the token is good — clear any prior auth
	// rejections so a later transient 4001 starts counting from scratch.
	c.authRejectCount.Store(0)
	c.outMu.Lock()
	c.ackSupported = msg.SupportsEventAck
	c.ackKnown = true
	c.flowControlSupported = containsCapability(msg.Capabilities, "flow_control")
	c.streamTransportSupported = containsCapability(msg.Capabilities, toolOutputStreamCapability) &&
		msg.MaxEventBytes > 0 && msg.MaxChunkBytes > 0 && msg.MaxChunkBytes <= msg.MaxEventBytes
	if c.streamTransportSupported {
		c.maxEventBytes = msg.MaxEventBytes
		c.maxChunkBytes = msg.MaxChunkBytes
	} else {
		c.maxEventBytes = 0
		c.maxChunkBytes = 0
	}
	if c.flowControlSupported && msg.EventWindow > 0 {
		c.eventWindow = clampEventWindow(msg.EventWindow, c.maxOutCount)
	}
	recoveredFatal := false
	if c.streamTransportSupported {
		blockedSeq := c.fatalFlowBlockedSeq
		repaired, err := c.repairBufferedEventsLocked(func(event bufferedEvent) bool {
			return len(event.data) > c.maxEventBytes || (blockedSeq > 0 && event.seq == blockedSeq)
		})
		if err != nil {
			c.logger.Error("oversized spool repair failed", "error", err)
		} else if _, ok := repaired[blockedSeq]; blockedSeq > 0 && ok {
			c.fatalFlowBlockedSeq = 0
			c.fatalFlowReason = ""
			c.flowRetryAfterMS = 0
			c.flowBackpressured = false
			recoveredFatal = true
		}
	}
	fatalReason := c.fatalFlowReason
	hasFatalBarrier := c.fatalFlowBlockedSeq > 0
	if hasFatalBarrier {
		c.flowBackpressured = true
	}
	c.outCond.Broadcast()
	if msg.SupportsEventAck {
		c.outMu.Unlock()
		if hasFatalBarrier {
			c.notifyConnectionStatus(ConnectionBackpressured, fatalReason)
		} else if recoveredFatal {
			c.notifyConnectionStatus(ConnectionConnected, "")
		}
		return
	}
	if hasFatalBarrier {
		c.outMu.Unlock()
		c.notifyConnectionStatus(ConnectionBackpressured, fatalReason)
		return
	}
	upto := c.seqCtr
	c.outMu.Unlock()
	c.trimOutbound(upto)
}

func (c *Client) handleEventAck(msg protocol.EventAckMessage) {
	c.outMu.Lock()
	if msg.DaemonGeneration != 0 && c.startedAt != 0 && msg.DaemonGeneration != c.startedAt {
		c.outMu.Unlock()
		return
	}
	previousWindow := c.eventWindow
	if msg.UpToSeq > c.ackedSeq {
		c.lastACKAt = time.Now().UTC()
	}
	eventIDs := c.trimOutboundLocked(msg.UpToSeq)
	restored := false
	if c.flowControlSupported && msg.EventWindow > 0 {
		c.eventWindow = clampEventWindow(msg.EventWindow, c.maxOutCount)
		if c.flowBackpressured && c.fatalFlowBlockedSeq == 0 && c.eventWindow > previousWindow {
			c.flowBackpressured = false
			c.flowRetryAfterMS = 0
			restored = true
		}
		c.outCond.Broadcast()
	}
	c.outMu.Unlock()
	if len(eventIDs) > 0 && c.OnEventsAcknowledged != nil {
		c.OnEventsAcknowledged(eventIDs)
	}
	if restored {
		c.notifyConnectionStatus(ConnectionConnected, "")
	}
}

func (c *Client) onFlowControl(msg protocol.FlowControlMessage) {
	c.outMu.Lock()
	if !c.flowControlSupported {
		c.outMu.Unlock()
		return
	}
	if msg.Reason == "event_too_large" {
		blockedSeq := msg.BlockedSeq
		if blockedSeq <= 0 {
			blockedSeq = c.ackedSeq + 1
		}
		if c.streamTransportSupported {
			repaired, err := c.repairBufferedEventsLocked(func(event bufferedEvent) bool {
				return event.seq == blockedSeq
			})
			if err != nil {
				c.logger.Error("runtime poison event repair failed", "seq", blockedSeq, "error", err)
			} else if _, ok := repaired[blockedSeq]; ok {
				c.fatalFlowBlockedSeq = 0
				c.fatalFlowReason = ""
				c.flowRetryAfterMS = 0
				c.flowBackpressured = false
				if msg.Window > 0 {
					c.eventWindow = clampEventWindow(msg.Window, c.maxOutCount)
				}
				c.outCond.Broadcast()
				c.outMu.Unlock()
				c.notifyConnectionStatus(ConnectionReconnecting, "event_too_large_repaired")
				c.connMu.Lock()
				conn := c.conn
				c.connMu.Unlock()
				if conn != nil {
					_ = conn.Close()
				}
				return
			}
		}
		if c.fatalFlowBlockedSeq == 0 || blockedSeq < c.fatalFlowBlockedSeq {
			c.fatalFlowBlockedSeq = blockedSeq
		}
		c.fatalFlowReason = msg.Reason
		c.flowRetryAfterMS = 0
		c.flowBackpressured = true
		c.outCond.Broadcast()
		c.outMu.Unlock()
		c.notifyConnectionStatus(ConnectionBackpressured, msg.Reason)
		return
	}
	if c.fatalFlowBlockedSeq > 0 {
		reason := c.fatalFlowReason
		c.flowBackpressured = true
		c.outCond.Broadcast()
		c.outMu.Unlock()
		c.notifyConnectionStatus(ConnectionBackpressured, reason)
		return
	}
	if msg.Window > 0 {
		c.eventWindow = clampEventWindow(msg.Window, c.maxOutCount)
	}
	c.flowRetryAfterMS = max(0, msg.RetryAfterMS)
	c.flowBackpressured = msg.Reason != "normal" && msg.RetryAfterMS > 0
	backpressured := c.flowBackpressured
	c.outCond.Broadcast()
	c.outMu.Unlock()
	if !backpressured {
		c.notifyConnectionStatus(ConnectionConnected, "")
		return
	}
	c.notifyConnectionStatus(ConnectionBackpressured, msg.Reason)
}

func clampEventWindow(window, maximum int) int {
	if maximum < 1 {
		return 1
	}
	if window < 1 {
		return 1
	}
	if window > maximum {
		return maximum
	}
	return window
}

func containsCapability(capabilities []string, want string) bool {
	for _, capability := range capabilities {
		if capability == want {
			return true
		}
	}
	return false
}

// backoffSleep waits before the next reconnect attempt. It returns true when
// the wait elapsed (proceed to reconnect) or false if ctx was cancelled (stop).
//
// The delay grows exponentially with the number of consecutive connections that
// never reached register_ack (reconnectAttempt, reset to 0 in onRegisterAck):
// 1s, 2s, 4s, 8s, 16s, capped at maxBackoff. Full jitter (a random value in
// [delay/2, delay]) spreads out reconnects so a fleet of daemons doesn't stampede
// the relay in lockstep after it restarts. The loop never gives up — a daemon
// must keep retrying indefinitely until the relay comes back (or the token is
// fixed via re-login).
func (c *Client) backoffSleep(ctx context.Context) bool {
	delay := c.reconnectDelay(int(c.reconnectAttempt.Load()), c.fastReconnect.Load())
	if retryAfter := time.Duration(c.serverRetryAfter.Swap(0)); retryAfter > delay {
		delay = retryAfter
	}
	c.reconnectAttempt.Add(1)
	select {
	case <-time.After(delay):
		return true
	case <-ctx.Done():
		return false
	}
}

func (c *Client) reconnectDelay(attempt int, fast bool) time.Duration {
	if fast {
		return backoffDelay(attempt, true)
	}
	shift := min(attempt, 5)
	base := time.Duration(1<<uint(shift)) * time.Second
	if base > maxBackoff {
		base = maxBackoff
	}
	if c.reconnectJitter == nil {
		return fullReconnectJitter(base)
	}
	delay := c.reconnectJitter(base)
	if delay < base/2 {
		return base / 2
	}
	if delay > base {
		return base
	}
	return delay
}

// fastReconnectSteps is the compact, deterministic delay sequence used right
// after the daemon receives relay_restarting — the relay is coming back fast,
// so we poll tightly instead of the usual 1/2/4s exponential backoff. Capped
// at 1500ms; no jitter so the cadence is predictable.
var fastReconnectSteps = []time.Duration{
	200 * time.Millisecond, 400 * time.Millisecond, 600 * time.Millisecond,
	800 * time.Millisecond, 1000 * time.Millisecond, 1500 * time.Millisecond,
}

// backoffDelay returns the reconnect delay for the given consecutive attempt
// count. When fast is false (default), it is an exponential base (1s, 2s, 4s,
// 8s, 16s, capped at maxBackoff) with full jitter — uniformly random in
// [base/2, base]. When fast is true (relay just announced a restart), it
// returns the deterministic fastReconnectSteps sequence. Pure aside from the
// RNG so the progression is unit-testable.
func backoffDelay(attempt int, fast bool) time.Duration {
	if fast {
		i := attempt
		if i < 0 {
			i = 0
		}
		if i >= len(fastReconnectSteps) {
			i = len(fastReconnectSteps) - 1
		}
		return fastReconnectSteps[i]
	}

	// Cap the shift so 1<<attempt can't overflow; 1<<5 = 32s already exceeds the
	// 30s cap, so attempts beyond 5 all clamp to maxBackoff.
	shift := min(attempt, 5)
	base := time.Duration(1<<uint(shift)) * time.Second
	if base > maxBackoff {
		base = maxBackoff
	}
	return fullReconnectJitter(base)
}

func boundedJitter(max time.Duration) time.Duration {
	if max <= 0 {
		return 0
	}
	return time.Duration(mathrand.Int64N(int64(max) + 1))
}

func fullReconnectJitter(base time.Duration) time.Duration {
	half := base / 2
	return half + boundedJitter(half)
}

func (c *Client) notifyState(connected bool) {
	if c.OnStateChange != nil {
		c.OnStateChange(connected)
	}
}

func (c *Client) notifyConnectionStatus(status ConnectionStatus, reason string) {
	// Capture the configured callback with its event. This avoids a new delayed
	// read of the public callback field in the dispatcher worker; as with
	// OnStateChange, callers configure it before Run and do not replace it while
	// the client is active.
	callback := c.OnConnectionStatus
	if callback == nil {
		return
	}
	event := connectionStatusEvent{status: status, reason: reason, callback: callback}
	c.connectionStatusMu.Lock()
	c.enqueueConnectionStatusLocked(event)
	startWorker := !c.connectionStatusWorker
	if startWorker {
		c.connectionStatusWorker = true
	}
	c.connectionStatusMu.Unlock()
	if startWorker {
		go c.dispatchConnectionStatuses()
	}
}

// enqueueConnectionStatusLocked preserves retained-event order while keeping
// the newest real state. At capacity, an incoming transient replaces the
// oldest queued transient; an incoming terminal does the same, and with an
// all-terminal queue it coalesces the oldest terminal of its own kind. Thus the
// bounded queue retains the latest transient state and every terminal kind.
func (c *Client) enqueueConnectionStatusLocked(event connectionStatusEvent) {
	if len(c.connectionStatusQueue) < connectionStatusQueueLimit {
		c.connectionStatusQueue = append(c.connectionStatusQueue, event)
		return
	}
	for i, queued := range c.connectionStatusQueue {
		if !isTerminalConnectionStatus(queued.status) {
			c.replaceQueuedStatusLocked(i, event)
			return
		}
	}
	if !isTerminalConnectionStatus(event.status) {
		// A terminal-only queue is a final state: a later transient must not
		// displace a terminal state that the observer has yet to receive.
		return
	}
	for i, queued := range c.connectionStatusQueue {
		if queued.status == event.status {
			c.replaceQueuedStatusLocked(i, event)
			return
		}
	}
	// The incoming terminal kind is absent. Evict the earliest repeated kind,
	// never an existing unique terminal, then append the newest terminal state.
	// This remains correct if a future terminal kind is added or a queue contains
	// only a subset of terminal kinds.
	counts := make(map[ConnectionStatus]int, len(c.connectionStatusQueue))
	for _, queued := range c.connectionStatusQueue {
		counts[queued.status]++
	}
	for i, queued := range c.connectionStatusQueue {
		if counts[queued.status] > 1 {
			c.replaceQueuedStatusLocked(i, event)
			return
		}
	}
	// No repeated terminal can be safely replaced. Retain every existing unique
	// terminal rather than silently dropping one to make room for the incoming
	// state.
}

func (c *Client) replaceQueuedStatusLocked(index int, event connectionStatusEvent) {
	copy(c.connectionStatusQueue[index:], c.connectionStatusQueue[index+1:])
	c.connectionStatusQueue = c.connectionStatusQueue[:len(c.connectionStatusQueue)-1]
	c.connectionStatusQueue = append(c.connectionStatusQueue, event)
}

func isTerminalConnectionStatus(status ConnectionStatus) bool {
	return status == ConnectionLoginRequired || status == ConnectionRevoked || status == ConnectionStopped
}

func (c *Client) dispatchConnectionStatuses() {
	for {
		c.connectionStatusMu.Lock()
		if len(c.connectionStatusQueue) == 0 {
			c.connectionStatusWorker = false
			c.connectionStatusMu.Unlock()
			return
		}
		event := c.connectionStatusQueue[0]
		c.connectionStatusQueue = c.connectionStatusQueue[1:]
		callback := event.callback
		c.connectionStatusMu.Unlock()
		if callback != nil {
			c.callConnectionStatusObserver(callback, event)
		}
	}
}

func (c *Client) callConnectionStatusObserver(callback func(ConnectionStatus, string), event connectionStatusEvent) {
	defer func() {
		if recovered := recover(); recovered != nil {
			c.logger.Error("connection status observer panicked", "panic", recovered, "status", event.status)
		}
	}()
	callback(event.status, event.reason)
}

func (c *Client) setServerRetryAfter(delay time.Duration) {
	if delay <= 0 {
		return
	}
	for {
		current := c.serverRetryAfter.Load()
		if current >= delay.Nanoseconds() || c.serverRetryAfter.CompareAndSwap(current, delay.Nanoseconds()) {
			return
		}
	}
}

func (c *Client) handleRelayDisconnect(msg protocol.DisconnectMessage) error {
	if msg.Retryable {
		c.setServerRetryAfter(time.Duration(msg.RetryAfterMS) * time.Millisecond)
	}
	switch msg.Reason {
	case "token_revoked", "host_unbound", "force_kick":
		c.notifyConnectionStatus(ConnectionRevoked, msg.Reason)
		c.registrationRevoked.Store(true)
		c.registrationRejected.Store(true)
		return errReconnectRequested
	case "token_check_failed", "token_check_unavailable":
		c.notifyConnectionStatus(ConnectionAuthUncertain, msg.Reason)
		c.reconnectStatusPending.Store(true)
		return errReconnectRequested
	case "relay_overloaded":
		c.notifyConnectionStatus(ConnectionBackpressured, msg.Reason)
		c.setServerRetryAfter(time.Duration(msg.RetryAfterMS) * time.Millisecond)
		c.reconnectStatusPending.Store(true)
		return errReconnectRequested
	case "relay_restarting":
		c.fastReconnect.Store(true)
		c.notifyConnectionStatus(ConnectionReconnecting, msg.Reason)
		return errReconnectRequested
	default:
		c.notifyConnectionStatus(ConnectionReconnecting, msg.Reason)
		return errReconnectRequested
	}
}

func (c *Client) handleRegisterRejected(msg protocol.RegisterRejectedMessage) {
	if !msg.Retryable {
		c.registrationRejected.Store(true)
		return
	}
	c.setServerRetryAfter(time.Duration(msg.RetryAfterMS) * time.Millisecond)
	c.reconnectStatusPending.Store(true)
	c.notifyConnectionStatus(ConnectionBackpressured, msg.Reason)
}

func (c *Client) waitRelayGracePeriod(ctx context.Context, seconds int) bool {
	if seconds <= 0 {
		return true
	}
	timer := time.NewTimer(time.Duration(seconds) * time.Second)
	defer timer.Stop()
	select {
	case <-timer.C:
		return true
	case <-ctx.Done():
		return false
	}
}

func readPumpError(readErr <-chan error, fallback string) error {
	select {
	case err := <-readErr:
		if err != nil {
			return err
		}
	default:
	}
	return errors.New(fallback)
}

// getLocalIP returns the preferred outbound IP of this machine.
// Tries UDP dial first, but excludes VPN/TUN/proxy virtual interfaces (198.18.x, 169.254.x, 172.1[6-9].x).
func getLocalIP() string {
	// On WSL, the default outbound IP is typically in the 172.x NAT range
	// (Hyper-V virtual switch). The isVirtualIP filter would discard it,
	// so detect WSL and skip that filter for the primary interface.
	wsl := isWSLEnv()

	// Method 1: UDP dial to get default outbound IP
	conn, err := net.Dial("udp", "8.8.8.8:80")
	if err == nil {
		ip := conn.LocalAddr().(*net.UDPAddr).IP.String()
		conn.Close()
		if wsl || !isVirtualIP(ip) {
			return ip
		}
	}
	// Method 2: Walk interfaces for first usable LAN IP
	ifaces, err := net.Interfaces()
	if err != nil {
		return "unknown"
	}
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		// Skip TUN/VPN/docker/bridge interfaces
		name := strings.ToLower(iface.Name)
		if strings.HasPrefix(name, "utun") || strings.HasPrefix(name, "tun") ||
			strings.HasPrefix(name, "tap") || strings.HasPrefix(name, "docker") ||
			strings.HasPrefix(name, "br-") || strings.HasPrefix(name, "veth") ||
			strings.HasPrefix(name, "virbr") {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, addr := range addrs {
			var ip net.IP
			switch v := addr.(type) {
			case *net.IPNet:
				ip = v.IP
			case *net.IPAddr:
				ip = v.IP
			}
			if ip == nil || ip.IsLoopback() {
				continue
			}
			ip4 := ip.To4()
			if ip4 == nil {
				continue // IPv6
			}
			str := ip4.String()
			if wsl || !isVirtualIP(str) {
				return str
			}
		}
	}
	return "unknown"
}

// isWSLEnv delegates to daemon.IsWSL (shared implementation).
func isWSLEnv() bool { return daemon.IsWSL() }

// isVirtualIP returns true for VPN/TUN/proxy/link-local/docker private ranges
// that are not useful as the machine's LAN IP.
func isVirtualIP(ip string) bool {
	if strings.HasPrefix(ip, "198.18.") { // Clash/Surge TUN mode
		return true
	}
	if strings.HasPrefix(ip, "169.254.") { // link-local
		return true
	}
	if strings.HasPrefix(ip, "172.1") { // 172.16-31.x docker
		parts := strings.Split(ip, ".")
		if len(parts) >= 2 {
			second := 0
			fmt.Sscanf(parts[1], "%d", &second)
			if second >= 16 && second <= 31 {
				return true
			}
		}
	}
	return false
}

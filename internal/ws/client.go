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
	// spoolRestoreMaxCount / spoolRestoreMaxBytes cap how many events InitSpool
	// restores from a prior crash's spool. A reconnect storm (relay down for a
	// while, or a feedback loop) can leave the spool holding hundreds of events
	// from already-finished sessions; replaying all of them on the next start
	// re-triggers the storm. The oldest events beyond the cap are dropped — they
	// are already persisted in the relay's event history, so this trades a
	// redundant re-delivery for connection stability. The cap is generous
	// relative to replayBatchSize so a single normal outage's worth replays in a
	// few paced batches.
	spoolRestoreMaxCount = 200
	spoolRestoreMaxBytes = 4 << 20 // 4 MiB
)

// bufferedEvent is a sent-but-unacked daemon event held for replay on reconnect.
type bufferedEvent struct {
	seq  int64
	data []byte // pre-marshaled JSON (includes the seq field)
}

// OnConnectStateChange is called when the relay connection state changes.
type OnConnectStateChange func(connected bool)

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
	relayPin        string
	conn            *websocket.Conn
	connMu          sync.Mutex
	writeMu         sync.Mutex // protects WriteMessage on conn
	outputCh        <-chan protocol.DaemonEvent
	sendCh          chan []byte
	logger          *slog.Logger
	daemonID        string
	hostname        string
	agents          []string
	agentVersions   map[string]string
	agentLatests    map[string]string
	agentManageable map[string]bool
	osName          string
	localIP         string
	arch            string
	version         string
	startedAt       int64
	metricsFn       func() (float64, float64, float64) // cpu, mem, disk
	// activeSessionIDsFn returns the session IDs this daemon currently owns.
	// Seeded into the register message so the relay can rebuild its
	// session→daemon routing table after a relay restart or daemon reconnect,
	// instead of losing every historical session to a cold in-memory map.
	activeSessionIDsFn func() []string
	CommandCh          chan protocol.ClientMessage
	OnStateChange      OnConnectStateChange
	OnReconnected      func()  // called after successful (re)connection + register
	OnEvent            OnEvent // optional hook: inspect/derive events before forwarding to relay
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

	// fastReconnect is set by readPump when the relay announces a restart
	// (relay_restarting) and cleared in onRegisterAck after a successful
	// re-registration. While set, backoffSleep uses the compact
	// fastReconnectSteps cadence instead of the usual exponential backoff, so
	// the daemon re-polls the relay tightly as it comes back up. Read by Run
	// (backoffSleep) and written by readPump (relay_restarting) and
	// onRegisterAck — atomic for the same cross-goroutine reason as above.
	fastReconnect atomic.Bool

	// Connection liveness/timeouts. Default to the package consts; overridable
	// (e.g. shortened by tests) without touching the timing logic.
	pingInterval time.Duration
	pongWait     time.Duration
	writeWait    time.Duration

	// Outbound delivery buffer (at-least-once). Holds events sent on the current
	// or a prior connection that the relay has not yet acked. On reconnect the
	// buffer is replayed in seq order; the relay dedups by (daemon_id, seq) and
	// acks via event_ack, which trims the buffer. Guarded by outMu/outCond so a
	// full buffer applies back-pressure to producers instead of dropping events.
	outMu        sync.Mutex
	outCond      *sync.Cond
	outBuf       []bufferedEvent
	outBytes     int
	seqCtr       int64 // monotonic, assigned at enqueue; never reset across reconnects
	ackedSeq     int64 // highest seq the relay has acknowledged
	draining     bool  // ctx cancelled — stop blocking producers
	ackKnown     bool  // register_ack processed on the current connection
	ackSupported bool  // relay advertised supports_event_ack (else legacy trim-on-write)
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
		relayURL:      relayURL,
		token:         token,
		outputCh:      outputCh,
		sendCh:        make(chan []byte, 256),
		logger:        logger,
		daemonID:      daemonID,
		hostname:      hostname,
		agents:        agents,
		agentVersions: agentVersions,
		agentLatests:  agentLatests,
		osName:        osName,
		localIP:       localIP,
		arch:          runtime.GOARCH,
		CommandCh:     make(chan protocol.ClientMessage, 64),
		pingInterval:  pingInterval,
		pongWait:      pongWait,
		writeWait:     writeWait,
		maxOutCount:   envInt("POCKETCTL_OUTBUF_MAX_COUNT", defaultMaxOutCount),
		maxOutBytes:   envInt("POCKETCTL_OUTBUF_MAX_BYTES", defaultMaxOutBytes),
	}
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
		// Cap the restored set: a reconnect storm can leave the spool holding
		// hundreds of stale events from finished sessions. Dropping the oldest
		// ones beyond the count/byte caps prevents the next start from re-arming
		// the same storm. These events are already in the relay's persisted
		// history, so we only lose a redundant re-delivery.
		trimmed := capRestoredSpool(restored)
		if len(trimmed) < len(restored) {
			c.logger.Warn("trimmed stale spool events on restore",
				"original", len(restored), "kept", len(trimmed),
				"dropped", len(restored)-len(trimmed),
				"from_seq", trimmed[0].seq)
			// Persist the trim so the file matches memory (a crash right after
			// start would otherwise re-load the full set again).
			s.rewrite(trimmed)
		}
		c.outBuf = trimmed
		var bytesN int
		var maxSeq int64
		for _, be := range trimmed {
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
		c.ackedSeq = trimmed[0].seq - 1
		c.logger.Info("restored spooled events", "count", len(trimmed), "from_seq", trimmed[0].seq, "to_seq", maxSeq)
	}
	return nil
}

// capRestoredSpool drops the oldest events from a restored spool until both the
// count and byte caps are satisfied. Events arrive already in seq order (oldest
// first) from loadSpool, so we keep the tail (newest) and drop the head. The
// newest events are the ones most likely to be unacked-and-unpersisted (a
// near-crash flush), while the oldest are from long-finished sessions already
// durably stored in the relay.
func capRestoredSpool(events []bufferedEvent) []bufferedEvent {
	// First trim by count: keep the newest spoolRestoreMaxCount.
	start := 0
	if len(events) > spoolRestoreMaxCount {
		start = len(events) - spoolRestoreMaxCount
	}
	kept := events[start:]
	// Then trim by bytes: walk from the newest end accumulating until the cap
	// is exceeded. cutFrom=0 means "keep everything"; otherwise it's the index
	// from which onward we keep (so kept[cutFrom:] is the newest tail).
	var totalBytes int
	cutFrom := 0
	for i := len(kept) - 1; i >= 0; i-- {
		totalBytes += len(kept[i].data)
		if totalBytes > spoolRestoreMaxBytes {
			cutFrom = i + 1
			break
		}
	}
	return kept[cutFrom:]
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
	for {
		err := c.connectAndServe(ctx)
		if ctx.Err() != nil {
			return ctx.Err()
		}
		c.notifyState(false)

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
			<-ctx.Done()
			return ctx.Err()
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
	c.outMu.Unlock()
	// Fresh per-connection ack signal (readPump closes/sends on register_ack).
	c.registerAckCh = make(chan struct{}, 1)

	// NOTE: do NOT reset reconnectAttempt here. A successful dial only means the
	// relay accepted the WS upgrade — it may still close us with 4001 if the token
	// is invalid/revoked (relay validates after upgrade). The backoff is reset in
	// onRegisterAck, once the relay has actually confirmed our registration.

	c.notifyState(true)

	c.logger.Info("sending register", "daemonID", c.daemonID, "hostname", c.hostname)
	register := protocol.RegisterMessage{
		Type: "register", DaemonID: c.daemonID, Hostname: c.hostname, Agents: c.agents,
		AgentVersions:   c.agentVersions,
		AgentLatests:    c.agentLatests,
		AgentManageable: c.agentManageable,
		OS:              c.osName, IP: c.localIP, Arch: c.arch, Version: c.version, StartedAt: c.startedAt,
	}
	if c.activeSessionIDsFn != nil {
		register.ActiveSessionIDs = c.activeSessionIDsFn()
	}
	c.outMu.Lock()
	register.AckedSeq = c.ackedSeq // durable baseline so the relay seeds its persisted mark
	c.outMu.Unlock()
	c.SendMsg(register)
	c.logger.Info("register sent")

	if c.OnReconnected != nil {
		c.OnReconnected()
	}

	done := make(chan struct{})
	go c.readPump(done)
	go c.pingPump(ctx, done)

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
		return fmt.Errorf("connection closed before register_ack")
	}

	// Replay any events the relay hasn't acked (lost mid-flight on the previous
	// connection) before resuming live delivery, so no event is silently dropped
	// across a reconnect. The relay dedups replayed events by (daemon_id, seq).
	c.replayOutbound(ctx, conn)

	for {
		select {
		case evt, ok := <-c.outputCh:
			if !ok {
				return nil
			}
			// Give the daemon a chance to inspect the event and emit derived
			// events (e.g. session_model_changed from an agent_text model change)
			// before forwarding to the relay.
			if c.OnEvent != nil {
				for _, e := range c.OnEvent(evt) {
					c.sendEvent(e)
				}
			} else {
				c.sendEvent(evt)
			}
		case <-done:
			return fmt.Errorf("connection closed")
		case <-ctx.Done():
			conn.Close()
			return ctx.Err()
		}
	}
}

func (c *Client) readPump(done chan struct{}) {
	defer close(done)
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
				switch ce.Code {
				case 4001:
					c.lastCloseAuthReject.Store(true)
					n := c.authRejectCount.Add(1)
					c.logger.Error("relay rejected the connection: token invalid/expired/revoked", "reason", ce.Text, "consecutive", n)
				case 4008:
					c.registrationRejected.Store(true)
					c.logger.Error("relay rejected daemon registration", "reason", ce.Text)
				}
			}
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
			SupportsEventAck   bool   `json:"supports_event_ack"`
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
			c.trimOutbound(base.UpToSeq)
			continue
		case "register_ack":
			c.onRegisterAck(base.SupportsEventAck)
			continue
		case "relay_restarting":
			c.logger.Info("relay restarting; switching to fast reconnect")
			c.fastReconnect.Store(true)
			continue
		case "register_rejected":
			c.registrationRejected.Store(true)
			c.logger.Error("relay rejected daemon registration", "reason", base.Reason, "message", base.Message, "used", base.Used, "limit", base.Limit)
			return
		}

		// Handle kicked message: daemon is being evicted
		if base.Type == "kicked" {
			fmt.Fprintf(os.Stderr, "\n⚠️  %s\n", base.Message)
			if base.GracePeriodSeconds > 0 {
				fmt.Fprintf(os.Stderr, "将在 %d 秒后断开连接...\n", base.GracePeriodSeconds)
				// Grace period: wait then exit
				go func() {
					time.Sleep(time.Duration(base.GracePeriodSeconds) * time.Second)
					fmt.Fprintf(os.Stderr, "连接已断开\n")
					os.Exit(0)
				}()
				// Continue reading messages during grace period
				continue
			}
			fmt.Fprintf(os.Stderr, "连接已断开\n")
			os.Exit(0)
		}

		// Handle DAEMON_LIMIT_REACHED: print error and exit (legacy compat)
		if base.Type == "error" && base.Code == "DAEMON_LIMIT_REACHED" {
			fmt.Fprintf(os.Stderr, "\n❌ %s\n\n", base.Error)
			os.Exit(1)
		}

		// Forward all other messages to command channel
		var cmdMsg protocol.ClientMessage
		if err := json.Unmarshal(msg, &cmdMsg); err != nil {
			continue
		}
		select {
		case c.CommandCh <- cmdMsg:
		default:
		}
	}
}

func (c *Client) pingPump(ctx context.Context, done chan struct{}) {
	ticker := time.NewTicker(c.pingInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			ping := protocol.PingMessage{Type: "ping"}
			if c.metricsFn != nil {
				ping.CpuPct, ping.MemPct, ping.DiskPct = c.metricsFn()
			}
			c.SendMsg(ping)
		case <-done:
			return
		case <-ctx.Done():
			return
		}
	}
}

func (c *Client) SendMsg(v any) {
	data, err := json.Marshal(v)
	if err != nil {
		c.logger.Error("send msg marshal error", "error", err)
		return
	}
	c.connMu.Lock()
	conn := c.conn
	c.connMu.Unlock()
	if conn == nil {
		c.logger.Error("send msg: conn is nil")
		return
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	_ = conn.SetWriteDeadline(time.Now().Add(c.writeWait))
	if err := conn.WriteMessage(websocket.TextMessage, data); err != nil {
		c.logger.Error("send msg write error", "error", err, "len", len(data))
		// On a half-open socket a write fails (TCP eventually gives up) while the
		// read side stays blocked. Close the conn so readPump's ReadMessage
		// errors out, closes `done`, and Run reconnects — otherwise a failed ping
		// write would just be logged and the daemon would hang on a dead link.
		// Closing the captured conn is safe even if it's already been replaced by
		// a fresh connection (we only close this specific one).
		conn.Close()
	}
}

// sendEvent delivers a daemon event to the relay with at-least-once semantics:
// it is stamped with a sequence number, retained in the outbound buffer until
// acked, and written to the current connection. Unlike SendMsg, a write failure
// here does NOT drop the event — it stays buffered for replay on reconnect.
func (c *Client) sendEvent(evt protocol.DaemonEvent) {
	seq, data, ok := c.appendOutbound(&evt)
	if !ok {
		return
	}
	c.writeBuffered(seq, data)
}

// appendOutbound assigns the next seq, marshals the event, and appends it to the
// unacked buffer. If the buffer is at its cap it blocks (back-pressure) until an
// ack frees space or the client is draining. Returns ok=false when draining or
// on marshal error. Called only from the single serve-loop goroutine, so seqCtr
// increments are serialized.
func (c *Client) appendOutbound(evt *protocol.DaemonEvent) (int64, []byte, bool) {
	c.outMu.Lock()
	for !c.draining && (len(c.outBuf) >= c.maxOutCount || c.outBytes >= c.maxOutBytes) {
		c.outCond.Wait()
	}
	if c.draining {
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

// writeBuffered writes one already-buffered event to the current connection. On
// failure it closes the conn (triggering reconnect+replay) but keeps the event
// buffered. On success against a legacy relay (no event_ack), it trims the event
// immediately so the buffer can't grow unbounded.
func (c *Client) writeBuffered(seq int64, data []byte) {
	c.connMu.Lock()
	conn := c.conn
	c.connMu.Unlock()
	if conn == nil {
		return // no live conn; will be replayed on reconnect
	}
	c.writeMu.Lock()
	_ = conn.SetWriteDeadline(time.Now().Add(c.writeWait))
	err := conn.WriteMessage(websocket.TextMessage, data)
	c.writeMu.Unlock()
	if err != nil {
		c.logger.Error("event write error", "error", err, "seq", seq, "len", len(data))
		conn.Close()
		return
	}
	c.outMu.Lock()
	legacy := c.ackKnown && !c.ackSupported
	c.outMu.Unlock()
	if legacy {
		c.trimOutbound(seq)
	}
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
func (c *Client) replayOutbound(ctx context.Context, conn *websocket.Conn) {
	c.outMu.Lock()
	pending := make([]bufferedEvent, len(c.outBuf))
	copy(pending, c.outBuf)
	c.outMu.Unlock()
	if len(pending) == 0 {
		return
	}
	c.logger.Info("replaying unacked events", "count", len(pending), "from_seq", pending[0].seq, "batch", replayBatchSize)
	for i, be := range pending {
		c.writeMu.Lock()
		_ = conn.SetWriteDeadline(time.Now().Add(c.writeWait))
		err := conn.WriteMessage(websocket.TextMessage, be.data)
		c.writeMu.Unlock()
		if err != nil {
			c.logger.Error("replay write error", "error", err, "seq", be.seq)
			conn.Close()
			return
		}
		// Pace between batches: after every replayBatchSize-th write, pause so the
		// relay can persist/route the burst before the next one arrives. Skip the
		// pause on the very last event (nothing follows).
		if (i+1)%replayBatchSize == 0 && i+1 < len(pending) {
			select {
			case <-time.After(replayBatchGap):
			case <-ctx.Done():
				return
			}
		}
	}
}

// trimOutbound removes all buffered events with seq <= uptoSeq (acknowledged or,
// for a legacy relay, written) and wakes any producer blocked on a full buffer.
func (c *Client) trimOutbound(uptoSeq int64) {
	c.outMu.Lock()
	if uptoSeq > c.ackedSeq {
		c.ackedSeq = uptoSeq
	}
	i := 0
	for i < len(c.outBuf) && c.outBuf[i].seq <= uptoSeq {
		c.outBytes -= len(c.outBuf[i].data)
		i++
	}
	if i > 0 {
		c.outBuf = append(c.outBuf[:0], c.outBuf[i:]...)
		c.outCond.Broadcast()
		c.spool.rewrite(c.outBuf) // shrink the durable mirror to the remaining unacked set
	}
	c.outMu.Unlock()
}

// onRegisterAck records whether this relay supports event_ack. A legacy relay
// (no support) gets best-effort delivery: the current buffer is trimmed and
// subsequent events are trimmed on successful write.
func (c *Client) onRegisterAck(supports bool) {
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
	c.ackSupported = supports
	c.ackKnown = true
	if supports {
		c.outMu.Unlock()
		return
	}
	upto := c.seqCtr
	c.outMu.Unlock()
	c.trimOutbound(upto)
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
	delay := backoffDelay(int(c.reconnectAttempt.Load()), c.fastReconnect.Load())
	c.reconnectAttempt.Add(1)
	select {
	case <-time.After(delay):
		return true
	case <-ctx.Done():
		return false
	}
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
	half := base / 2
	return half + time.Duration(mathrand.Int64N(int64(half)+1))
}

func (c *Client) notifyState(connected bool) {
	if c.OnStateChange != nil {
		c.OnStateChange(connected)
	}
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

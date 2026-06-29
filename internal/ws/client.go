package ws

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	mathrand "math/rand/v2"
	"net"
	"net/url"
	"os"
	"runtime"
	"strings"
	"sync"
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
)

// OnConnectStateChange is called when the relay connection state changes.
type OnConnectStateChange func(connected bool)

// OnEvent is invoked for every event leaving the daemon (just before it is
// forwarded to the relay). It lets the daemon inspect outgoing events and
// emit derived events — e.g. detecting a model change from an agent_text
// event's Model field and sending a session_model_changed. Returning a slice
// replaces the original event (return nil to forward it unchanged).
type OnEvent func(evt protocol.DaemonEvent) []protocol.DaemonEvent

type Client struct {
	relayURL        string
	token           string
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

	// reconnectAttempt counts consecutive failed/lost connections; it drives the
	// exponential backoff and is reset to 0 on every successful connect. Only
	// touched from the single Run goroutine (and the connect it calls), so it
	// needs no lock.
	reconnectAttempt int

	// Connection liveness/timeouts. Default to the package consts; overridable
	// (e.g. shortened by tests) without touching the timing logic.
	pingInterval time.Duration
	pongWait     time.Duration
	writeWait    time.Duration
}

func NewClient(relayURL, token, daemonID string, agents []string, agentVersions map[string]string, agentLatests map[string]string, outputCh <-chan protocol.DaemonEvent, logger *slog.Logger) *Client {
	hostname, _ := os.Hostname()
	localIP := getLocalIP()
	osName := runtime.GOOS
	return &Client{
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
	}
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
	}
	if c.activeSessionIDsFn != nil {
		register.ActiveSessionIDs = c.activeSessionIDsFn()
	}
	c.SendMsg(register)
}

// SetStartedAt sets the daemon start timestamp for register messages.
func (c *Client) SetStartedAt(t int64) { c.startedAt = t }

// SetMetricsFn sets the function used to collect system metrics for ping messages.
func (c *Client) SetMetricsFn(fn func() (float64, float64, float64)) { c.metricsFn = fn }

// SetActiveSessionIDsFn sets the function used to collect this daemon's active
// session IDs for the register message (rebuilds the relay's routing table).
func (c *Client) SetActiveSessionIDsFn(fn func() []string) { c.activeSessionIDsFn = fn }

func (c *Client) Run(ctx context.Context) error {
	for {
		err := c.connectAndServe(ctx)
		if ctx.Err() != nil {
			return ctx.Err()
		}
		c.notifyState(false)
		c.logger.Error("connection lost, reconnecting", "error", err)
		if !c.backoffSleep(ctx) {
			return ctx.Err()
		}
	}
}

func (c *Client) connectAndServe(ctx context.Context) error {
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
	// Use token (JWT) for authentication
	q.Set("token", c.token)
	q.Set("type", "daemon")
	u.RawQuery = q.Encode()

	c.logger.Info("connecting to relay", "url", u.Host)
	conn, _, err := websocket.DefaultDialer.DialContext(ctx, u.String(), nil)
	if err != nil {
		return fmt.Errorf("dial: %w", err)
	}
	c.connMu.Lock()
	c.conn = conn
	c.connMu.Unlock()

	// Connection established — reset backoff so the next disconnect starts from
	// the shortest delay again.
	c.reconnectAttempt = 0

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
	c.SendMsg(register)
	c.logger.Info("register sent")

	if c.OnReconnected != nil {
		c.OnReconnected()
	}

	done := make(chan struct{})
	go c.readPump(done)
	go c.pingPump(ctx, done)

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
					c.SendMsg(e)
				}
			} else {
				c.SendMsg(evt)
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
		}
		if err := json.Unmarshal(msg, &base); err != nil {
			continue
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

// backoffSleep waits before the next reconnect attempt. It returns true when
// the wait elapsed (proceed to reconnect) or false if ctx was cancelled (stop).
//
// The delay grows exponentially with the number of consecutive failures
// (reconnectAttempt, reset to 0 on every successful connect): 1s, 2s, 4s, 8s,
// 16s, capped at maxBackoff. Full jitter (a random value in [delay/2, delay])
// spreads out reconnects so a fleet of daemons doesn't stampede the relay in
// lockstep after it restarts. The loop never gives up — a daemon must keep
// retrying indefinitely until the relay comes back.
func (c *Client) backoffSleep(ctx context.Context) bool {
	delay := backoffDelay(c.reconnectAttempt)
	c.reconnectAttempt++
	select {
	case <-time.After(delay):
		return true
	case <-ctx.Done():
		return false
	}
}

// backoffDelay returns the jittered reconnect delay for the given consecutive
// attempt count: an exponential base (1s, 2s, 4s, 8s, 16s, capped at maxBackoff)
// with full jitter applied — the result is uniformly random in [base/2, base].
// Pure (aside from the RNG) so the progression is unit-testable.
func backoffDelay(attempt int) time.Duration {
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

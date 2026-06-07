package ws

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pocketctl/pocketctl/internal/protocol"
)

// OnConnectStateChange is called when the relay connection state changes.
type OnConnectStateChange func(connected bool)

type Client struct {
	relayURL string
	token    string
	conn     *websocket.Conn
	connMu   sync.Mutex
	writeMu  sync.Mutex // protects WriteMessage on conn
	outputCh <-chan protocol.DaemonEvent
	sendCh   chan []byte
	logger   *slog.Logger
	daemonID string
	hostname string
	agents   []string
	CommandCh chan protocol.ClientMessage
	OnStateChange OnConnectStateChange
}

func NewClient(relayURL, token, daemonID string, agents []string, outputCh <-chan protocol.DaemonEvent, logger *slog.Logger) *Client {
	hostname, _ := os.Hostname()
	return &Client{
		relayURL:  relayURL,
		token:     token,
		outputCh:  outputCh,
		sendCh:    make(chan []byte, 256),
		logger:    logger,
		daemonID:  daemonID,
		hostname:  hostname,
		agents:    agents,
		CommandCh: make(chan protocol.ClientMessage, 64),
	}
}

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

	c.notifyState(true)

	c.SendMsg(protocol.RegisterMessage{
		Type: "register", DaemonID: c.daemonID, Hostname: c.hostname, Agents: c.agents,
	})

	done := make(chan struct{})
	go c.readPump(done)
	go c.pingPump(ctx, done)

	for {
		select {
		case evt, ok := <-c.outputCh:
			if !ok { return nil }
			c.SendMsg(evt)
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
	for {
		_, msg, err := conn.ReadMessage()
		if err != nil { return }
		var base protocol.ClientMessage
		if err := json.Unmarshal(msg, &base); err != nil { continue }
		select {
		case c.CommandCh <- base:
		default:
		}
	}
}

func (c *Client) pingPump(ctx context.Context, done chan struct{}) {
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C: c.SendMsg(protocol.PingMessage{Type: "ping"})
		case <-done: return
		case <-ctx.Done(): return
		}
	}
}

func (c *Client) SendMsg(v any) {
	data, err := json.Marshal(v)
	if err != nil { return }
	c.connMu.Lock()
	conn := c.conn
	c.connMu.Unlock()
	if conn == nil { return }
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	conn.WriteMessage(websocket.TextMessage, data)
}

func (c *Client) backoffSleep(ctx context.Context) bool {
	for attempt := 0; attempt < 10; attempt++ {
		delay := time.Duration(1<<uint(attempt)) * time.Second
		if delay > 30*time.Second { delay = 30 * time.Second }
		select {
		case <-time.After(delay): return true
		case <-ctx.Done(): return false
		}
	}
	return false
}

func (c *Client) notifyState(connected bool) {
	if c.OnStateChange != nil {
		c.OnStateChange(connected)
	}
}

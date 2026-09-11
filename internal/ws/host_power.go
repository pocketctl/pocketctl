package ws

import (
	"context"
	"errors"
	"time"

	"github.com/gorilla/websocket"
)

var errHostSuspended = errors.New("host sleeping or in background wake")

// Check at the transport boundary, not only in a timer: all Go timers become
// runnable together during DarkWake, so a cached awake flag can send stale work.
func (c *Client) hostAwake() bool {
	if c.HostAwake == nil {
		return true
	}
	awake, err := c.HostAwake()
	if err != nil {
		c.logger.Debug("host power state unavailable; pausing relay traffic", "error", err)
	}
	return err == nil && awake
}

func (c *Client) requireHostAwake() error {
	if c.hostAwake() {
		return nil
	}
	c.connMu.Lock()
	conn := c.conn
	c.connMu.Unlock()
	if conn != nil {
		_ = conn.Close()
	}
	return errHostSuspended
}

func (c *Client) waitHostAwake(ctx context.Context) error {
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		if c.hostAwake() {
			return nil
		}
		// Ordinary timers do not request a system wake or hold a power assertion.
		timer := time.NewTimer(time.Second)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
}

func (c *Client) watchHostPower(ctx context.Context, conn *websocket.Conn, done <-chan struct{}) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-done:
			return
		case <-ctx.Done():
			_ = conn.Close()
			return
		case <-ticker.C:
			if !c.hostAwake() {
				c.logger.Info("host suspended; closing relay connection until full wake")
				_ = conn.Close()
				return
			}
		}
	}
}

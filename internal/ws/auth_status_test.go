package ws

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// A rejected upgrade must never be reported as a registered host, and a
// client that has stopped dialing must not leave a reconnecting snapshot.
func TestAuthRejectionPublishesPausedStateWithoutFalseConnected(t *testing.T) {
	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		_ = conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(4001, "invalid token"), time.Now().Add(time.Second))
	}))
	defer srv.Close()
	c := newTestClient(wsURL(srv.URL))
	events := make(chan connectionStatusEvent, 64)
	c.OnConnectionStatus = func(s ConnectionStatus, r string) { events <- connectionStatusEvent{status: s, reason: r} }
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()
	done := make(chan struct{})
	go func() { defer close(done); _ = c.Run(ctx) }()
	defer func() { cancel(); <-done }()
	falseConnected := false
	for {
		select {
		case e := <-events:
			if e.status == ConnectionConnected {
				falseConnected = true
			}
			if e.status == ConnectionStopped {
				if falseConnected {
					t.Fatal("auth-rejected connection was reported connected before registration")
				}
				if e.reason != "auth_refresh_unavailable" {
					t.Fatalf("reason=%q", e.reason)
				}
				return
			}
		case <-ctx.Done():
			t.Fatalf("no paused status; false connected=%v", falseConnected)
		}
	}
}

func TestRefreshInterventionPublishesTerminalState(t *testing.T) {
	for _, tc := range []struct {
		err    error
		status ConnectionStatus
		reason string
	}{
		{ErrRefreshLoginRequired, ConnectionLoginRequired, "refresh_rejected"},
		{ErrRefreshStorageUnavailable, ConnectionStopped, "auth_storage_unavailable"},
		{ErrRefreshPersistenceFailed, ConnectionStopped, "auth_persistence_failed"},
	} {
		t.Run(tc.reason, func(t *testing.T) {
			upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
			var attempts atomic.Int32
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				conn, err := upgrader.Upgrade(w, r, nil)
				if err != nil {
					return
				}
				defer conn.Close()
				attempts.Add(1)
				_ = conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(4001, "invalid token"), time.Now().Add(time.Second))
			}))
			defer srv.Close()
			c := newTestClient(wsURL(srv.URL))
			events := make(chan connectionStatusEvent, 32)
			c.OnConnectionStatus = func(s ConnectionStatus, r string) { events <- connectionStatusEvent{status: s, reason: r} }
			c.OnTokenRefresh = func(context.Context) (string, error) { return "", tc.err }
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			done := make(chan struct{})
			go func() { defer close(done); _ = c.Run(ctx) }()
			defer func() { cancel(); <-done }()
			for {
				select {
				case e := <-events:
					if e.status == ConnectionConnected {
						t.Fatal("reported connected without registration")
					}
					if e.status == tc.status && e.reason == tc.reason {
						select {
						case extra := <-events:
							t.Fatalf("terminal state overwritten: %+v", extra)
						case <-time.After(1100 * time.Millisecond):
						}
						if attempts.Load() != 1 {
							t.Fatalf("retried after terminal failure: %d", attempts.Load())
						}
						return
					}
				case <-ctx.Done():
					t.Fatal("terminal state missing")
				}
			}
		})
	}
}

func TestTransientRefreshFailuresRecoverBeyondOldRejectionLimit(t *testing.T) {
	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	var refreshes atomic.Int32
	var connections atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		connections.Add(1)
		if refreshes.Load() < 5 {
			_ = conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(4001, "invalid token"), time.Now().Add(time.Second))
			return
		}
		_, _, err = conn.ReadMessage()
		if err != nil {
			return
		}
		_ = conn.WriteJSON(map[string]any{"type": "register_ack", "supports_event_ack": true})
		for {
			if _, _, err = conn.ReadMessage(); err != nil {
				return
			}
		}
	}))
	defer srv.Close()
	c := newTestClient(wsURL(srv.URL))
	c.reconnectJitter = func(d time.Duration) time.Duration { return d / 2 }
	events := make(chan connectionStatusEvent, 128)
	c.OnConnectionStatus = func(s ConnectionStatus, r string) { events <- connectionStatusEvent{status: s, reason: r} }
	c.OnTokenRefresh = func(context.Context) (string, error) {
		if refreshes.Add(1) <= 4 {
			return "", errors.New("temporary network error")
		}
		return "fresh", nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	done := make(chan struct{})
	go func() { defer close(done); _ = c.Run(ctx) }()
	defer func() { cancel(); <-done }()
	uncertain := 0
	for {
		select {
		case e := <-events:
			if e.status == ConnectionStopped || e.status == ConnectionLoginRequired {
				t.Fatalf("temporary error parked client: %+v", e)
			}
			if e.reason == "refresh_temporarily_unavailable" {
				uncertain++
			}
			if e.status == ConnectionConnected {
				if connections.Load() != 2 {
					t.Fatalf("redialed rejected token during refresh outage: %d connections; want initial rejection + recovered connection", connections.Load())
				}
				if refreshes.Load() != 5 || uncertain != 4 {
					t.Fatalf("premature connected: refreshes=%d uncertain=%d", refreshes.Load(), uncertain)
				}
				return
			}
		case <-ctx.Done():
			t.Fatalf("did not recover after %d refreshes", refreshes.Load())
		}
	}
}

// After repeated transient refresh errors, an intervening non-auth close must
// not take the legacy no-refresh-callback parking path.
func TestTransientRefreshHistoryDoesNotParkOnTransportClose(t *testing.T) {
	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		_ = conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(1001, "maintenance"), time.Now().Add(time.Second))
	}))
	defer srv.Close()
	c := newTestClient(wsURL(srv.URL))
	c.authRejectCount.Store(3)
	c.OnTokenRefresh = func(context.Context) (string, error) {
		t.Error("refresh called for non-auth close")
		return "", errors.New("temporary")
	}
	events := make(chan connectionStatusEvent, 32)
	c.OnConnectionStatus = func(s ConnectionStatus, r string) { events <- connectionStatusEvent{status: s, reason: r} }
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	done := make(chan struct{})
	go func() { defer close(done); _ = c.Run(ctx) }()
	defer func() { cancel(); <-done }()
	for {
		select {
		case e := <-events:
			if e.status == ConnectionStopped || e.status == ConnectionLoginRequired {
				t.Fatalf("transport close parked refresh-capable client: %+v", e)
			}
			if e.status == ConnectionReconnecting && e.reason != "awaiting_registration" {
				return
			}
		case <-ctx.Done():
			t.Fatal("did not publish reconnecting status")
		}
	}
}

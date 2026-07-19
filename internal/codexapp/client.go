package codexapp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"

	"github.com/gorilla/websocket"
)

var ErrClosed = errors.New("codex app-server connection closed")

type RPCError struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data,omitempty"`
}

func (e *RPCError) Error() string {
	return fmt.Sprintf("app-server RPC %d: %s", e.Code, e.Message)
}

type Inbound struct {
	ID     *RequestID
	Method string
	Params json.RawMessage
}

type response struct {
	result json.RawMessage
	err    *RPCError
	closed error
}

type Client struct {
	conn *websocket.Conn

	nextID  atomic.Int64
	write   sync.Mutex
	mu      sync.Mutex
	pending map[string]chan response
	events  chan Inbound
	done    chan struct{}
	once    sync.Once
}

func NewClient(conn *websocket.Conn) *Client {
	c := &Client{
		conn: conn, pending: make(map[string]chan response),
		events: make(chan Inbound, 128), done: make(chan struct{}),
	}
	go c.readLoop()
	return c
}

func (c *Client) Events() <-chan Inbound { return c.events }
func (c *Client) Done() <-chan struct{}  { return c.done }

func (c *Client) Call(ctx context.Context, method string, params any, result any) error {
	id := numberID(c.nextID.Add(1))
	wait := make(chan response, 1)
	c.mu.Lock()
	c.pending[id.Key()] = wait
	c.mu.Unlock()
	if err := c.writeMessage(map[string]any{"id": id, "method": method, "params": params}); err != nil {
		c.removePending(id.Key())
		return err
	}
	select {
	case reply := <-wait:
		if reply.closed != nil {
			return reply.closed
		}
		if reply.err != nil {
			return reply.err
		}
		if result == nil || len(reply.result) == 0 {
			return nil
		}
		return json.Unmarshal(reply.result, result)
	case <-ctx.Done():
		c.removePending(id.Key())
		return ctx.Err()
	case <-c.done:
		c.removePending(id.Key())
		return ErrClosed
	}
}

func (c *Client) Notify(method string, params any) error {
	return c.writeMessage(map[string]any{"method": method, "params": params})
}

func (c *Client) Respond(id RequestID, result any, rpcErr *RPCError) error {
	message := map[string]any{"id": id}
	if rpcErr != nil {
		message["error"] = rpcErr
	} else {
		message["result"] = result
	}
	return c.writeMessage(message)
}

func (c *Client) Initialize(ctx context.Context, params any, result any) error {
	if err := c.Call(ctx, "initialize", params, result); err != nil {
		return err
	}
	return c.Notify("initialized", map[string]any{})
}

func (c *Client) Close() error {
	err := c.conn.Close()
	c.failAll(ErrClosed)
	return err
}

func (c *Client) writeMessage(value any) error {
	select {
	case <-c.done:
		return ErrClosed
	default:
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	c.write.Lock()
	defer c.write.Unlock()
	if err := c.conn.WriteMessage(websocket.TextMessage, raw); err != nil {
		c.failAll(err)
		return err
	}
	return nil
}

func (c *Client) readLoop() {
	for {
		messageType, raw, err := c.conn.ReadMessage()
		if err != nil {
			c.failAll(err)
			return
		}
		if messageType != websocket.TextMessage {
			continue
		}
		var envelope struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
			Result json.RawMessage `json:"result"`
			Error  *RPCError       `json:"error"`
		}
		if json.Unmarshal(raw, &envelope) != nil {
			continue
		}
		var id *RequestID
		if len(envelope.ID) > 0 && string(envelope.ID) != "null" {
			parsed := RequestID{}
			if json.Unmarshal(envelope.ID, &parsed) != nil {
				continue
			}
			id = &parsed
		}
		if envelope.Method != "" {
			select {
			case c.events <- Inbound{ID: id, Method: envelope.Method, Params: envelope.Params}:
			case <-c.done:
				return
			}
			continue
		}
		if id == nil {
			continue
		}
		c.mu.Lock()
		wait := c.pending[id.Key()]
		delete(c.pending, id.Key())
		c.mu.Unlock()
		if wait != nil {
			wait <- response{result: envelope.Result, err: envelope.Error}
		}
	}
}

func (c *Client) removePending(key string) {
	c.mu.Lock()
	delete(c.pending, key)
	c.mu.Unlock()
}

func (c *Client) failAll(err error) {
	c.once.Do(func() {
		c.mu.Lock()
		pending := c.pending
		c.pending = make(map[string]chan response)
		c.mu.Unlock()
		for _, wait := range pending {
			wait <- response{closed: err}
		}
		close(c.done)
		close(c.events)
	})
}

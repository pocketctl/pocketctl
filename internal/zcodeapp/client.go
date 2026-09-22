package zcodeapp

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync"
	"sync/atomic"
)

const MaxFrameBytes = 8 << 20

var ErrClosed = errors.New("zcode app-server connection closed")

type RPCError struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data,omitempty"`
}

func (e *RPCError) Error() string {
	return fmt.Sprintf("zcode app-server RPC %d: %s", e.Code, e.Message)
}

// RequestID retains the peer's JSON scalar so reverse requests can be answered
// without changing a numeric ID into a string (or vice versa).
type RequestID struct {
	raw json.RawMessage
}

func (id RequestID) MarshalJSON() ([]byte, error) {
	if len(id.raw) == 0 {
		return nil, errors.New("empty request id")
	}
	return id.raw, nil
}

func (id *RequestID) UnmarshalJSON(raw []byte) error {
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return err
	}
	switch value.(type) {
	case string, float64:
		id.raw = append(id.raw[:0], raw...)
		return nil
	default:
		return errors.New("request id must be a string or number")
	}
}

func (id RequestID) key() string { return string(id.raw) }

type Inbound struct {
	ID     *RequestID
	Method string
	Params json.RawMessage
}

type response struct {
	result json.RawMessage
	err    error
}

// Client implements ZCode Protocol's NDJSON request/response transport. ZCode
// frames intentionally omit the JSON-RPC version member.
type Client struct {
	input   io.Reader
	output  io.Writer
	closeFn func() error

	nextID  atomic.Int64
	write   sync.Mutex
	mu      sync.Mutex
	pending map[string]chan response
	err     error
	inbound chan Inbound
	done    chan struct{}
	once    sync.Once
}

func NewClient(input io.Reader, output io.Writer, closeFn func() error) *Client {
	client := &Client{
		input: input, output: output, closeFn: closeFn,
		pending: make(map[string]chan response),
		inbound: make(chan Inbound, 128),
		done:    make(chan struct{}),
	}
	go client.readLoop()
	return client
}

func (c *Client) Inbound() <-chan Inbound { return c.inbound }
func (c *Client) Done() <-chan struct{}   { return c.done }

func (c *Client) Err() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.err
}

func (c *Client) Call(ctx context.Context, method string, params any, result any) error {
	id := RequestID{raw: json.RawMessage(fmt.Sprintf("%d", c.nextID.Add(1)))}
	wait := make(chan response, 1)
	c.mu.Lock()
	select {
	case <-c.done:
		err := c.err
		c.mu.Unlock()
		if err != nil {
			return err
		}
		return ErrClosed
	default:
	}
	c.pending[id.key()] = wait
	c.mu.Unlock()

	if err := c.writeMessage(map[string]any{"id": id, "method": method, "params": params}); err != nil {
		c.removePending(id.key())
		return err
	}
	select {
	case reply := <-wait:
		if reply.err != nil {
			return reply.err
		}
		if result == nil || len(reply.result) == 0 || string(reply.result) == "null" {
			return nil
		}
		return json.Unmarshal(reply.result, result)
	case <-ctx.Done():
		c.removePending(id.key())
		return ctx.Err()
	case <-c.done:
		select {
		case reply := <-wait:
			return reply.err
		default:
		}
		c.removePending(id.key())
		if err := c.Err(); err != nil {
			return err
		}
		return ErrClosed
	}
}

func (c *Client) Respond(id RequestID, result any, rpcErr *RPCError) error {
	frame := map[string]any{"id": id}
	if rpcErr != nil {
		frame["error"] = rpcErr
	} else {
		frame["result"] = result
	}
	return c.writeMessage(frame)
}

func (c *Client) Close() error {
	var closeErr error
	if c.closeFn != nil {
		closeErr = c.closeFn()
	}
	c.fail(ErrClosed)
	return closeErr
}

func (c *Client) writeMessage(value any) error {
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	raw = append(raw, '\n')
	c.write.Lock()
	defer c.write.Unlock()
	select {
	case <-c.done:
		if err := c.Err(); err != nil {
			return err
		}
		return ErrClosed
	default:
	}
	if _, err := c.output.Write(raw); err != nil {
		c.fail(err)
		return err
	}
	return nil
}

func (c *Client) readLoop() {
	defer close(c.inbound)
	scanner := bufio.NewScanner(c.input)
	scanner.Buffer(make([]byte, 64*1024), MaxFrameBytes)
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		if err := c.handleFrame(line); err != nil {
			c.fail(err)
			return
		}
	}
	if err := scanner.Err(); err != nil {
		c.fail(fmt.Errorf("read zcode frame: %w", err))
		return
	}
	c.fail(ErrClosed)
}

func (c *Client) handleFrame(raw []byte) error {
	var envelope struct {
		ID     json.RawMessage `json:"id"`
		Method string          `json:"method"`
		Params json.RawMessage `json:"params"`
		Result json.RawMessage `json:"result"`
		Error  *RPCError       `json:"error"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return fmt.Errorf("decode zcode frame: %w", err)
	}
	var id *RequestID
	if len(envelope.ID) > 0 && string(envelope.ID) != "null" {
		parsed := &RequestID{}
		if err := parsed.UnmarshalJSON(envelope.ID); err != nil {
			return fmt.Errorf("decode zcode request id: %w", err)
		}
		id = parsed
	}
	if envelope.Method != "" {
		select {
		case c.inbound <- Inbound{ID: id, Method: envelope.Method, Params: envelope.Params}:
			return nil
		case <-c.done:
			return ErrClosed
		}
	}
	if id == nil || (len(envelope.Result) == 0 && envelope.Error == nil) {
		return errors.New("decode zcode frame: invalid envelope")
	}
	c.mu.Lock()
	wait := c.pending[id.key()]
	delete(c.pending, id.key())
	c.mu.Unlock()
	if wait != nil {
		if envelope.Error != nil {
			wait <- response{err: envelope.Error}
		} else {
			wait <- response{result: envelope.Result}
		}
	}
	return nil
}

func (c *Client) removePending(key string) {
	c.mu.Lock()
	delete(c.pending, key)
	c.mu.Unlock()
}

func (c *Client) fail(err error) {
	if err == nil {
		err = ErrClosed
	}
	c.once.Do(func() {
		c.mu.Lock()
		c.err = err
		pending := c.pending
		c.pending = make(map[string]chan response)
		c.mu.Unlock()
		for _, wait := range pending {
			wait <- response{err: err}
		}
		close(c.done)
	})
}

package agentcontrol

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"time"

	"github.com/pocketctl/pocketctl/internal/config"
)

type Client struct {
	SocketPath string
	Dial       func(context.Context, string) (net.Conn, error)
}

func NewClient(socketPath string) Client {
	if socketPath == "" {
		socketPath = config.AgentControlSocketPath()
	}
	return Client{SocketPath: socketPath, Dial: dialAgentControl}
}

func (c Client) Acquire(ctx context.Context, payload AcquirePayload) (AcquireResult, error) {
	var result AcquireResult
	if err := c.callPayload(ctx, MethodRuntimeAcquire, payload, &result); err != nil {
		return AcquireResult{}, err
	}
	return result, nil
}

func (c Client) BindLease(ctx context.Context, payload LeaseBindPayload) error {
	var result struct{}
	return c.callPayload(ctx, MethodRuntimeLeaseBind, payload, &result)
}

func (c Client) Release(ctx context.Context, payload ReleasePayload) error {
	var result struct{}
	return c.callPayload(ctx, MethodRuntimeRelease, payload, &result)
}

func (c Client) Status(ctx context.Context, payload StatusPayload) (RuntimeStatusResult, error) {
	var result RuntimeStatusResult
	if err := c.callPayload(ctx, MethodRuntimeStatus, payload, &result); err != nil {
		return RuntimeStatusResult{}, err
	}
	return result, nil
}

func (c Client) callPayload(ctx context.Context, method string, payload any, result any) error {
	payloadBytes, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	req := Request{
		Version: ProtocolVersion, ID: newOperationID(), Method: method,
		Agent: AgentOpenCode, ClientPID: os.Getpid(), Payload: payloadBytes,
	}
	return c.call(ctx, req, result)
}

func (c Client) call(ctx context.Context, req Request, result any) error {
	dial := c.Dial
	if dial == nil {
		dial = dialAgentControl
	}
	dialCtx, dialCancel := context.WithTimeout(ctx, DefaultLauncherTimeout)
	conn, err := dial(dialCtx, c.SocketPath)
	dialCancel()
	if err != nil {
		return fmt.Errorf("connect agent control: %w", err)
	}
	defer conn.Close()
	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	} else {
		_ = conn.SetDeadline(time.Now().Add(DefaultLauncherTimeout))
	}
	frame, err := json.Marshal(req)
	if err != nil {
		return err
	}
	if err := ValidateFrameSize(frame); err != nil {
		return err
	}
	if _, err := conn.Write(append(frame, '\n')); err != nil {
		return fmt.Errorf("write agent control request: %w", err)
	}
	line, err := bufio.NewReaderSize(io.LimitReader(conn, MaxFrameSize+2), MaxFrameSize+2).ReadBytes('\n')
	if err != nil {
		return fmt.Errorf("read agent control response: %w", err)
	}
	line = bytes.TrimSuffix(line, []byte{'\n'})
	if err := ValidateFrameSize(line); err != nil {
		return err
	}
	var resp Response
	if err := json.Unmarshal(line, &resp); err != nil {
		return fmt.Errorf("decode agent control response: %w", err)
	}
	if resp.Version != ProtocolVersion || resp.ID != req.ID {
		return &ProtocolError{Code: ErrUnsupportedVersion, Message: "invalid agent control response envelope"}
	}
	if resp.Error != nil {
		return resp.Error
	}
	if err := json.Unmarshal(resp.Result, result); err != nil {
		return fmt.Errorf("decode agent control result: %w", err)
	}
	return nil
}

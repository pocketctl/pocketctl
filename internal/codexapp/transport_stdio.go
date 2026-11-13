package codexapp

import (
	"bufio"
	"context"
	"errors"
	"io"
	"os"
	"sync"
	"time"
)

type deadlineWriteCloser interface {
	io.WriteCloser
	SetWriteDeadline(time.Time) error
}

type stdioTransport struct {
	input     io.ReadCloser
	output    deadlineWriteCloser
	lines     *bufio.Scanner
	closeOnce sync.Once
	closeErr  error
}

// NewStdioClient owns both ends supplied by the caller. The writer must
// support deadlines, as do the parent's end of an OS pipe and net.Conn.
func NewStdioClient(input io.ReadCloser, output deadlineWriteCloser) *Client {
	lines := bufio.NewScanner(input)
	lines.Buffer(make([]byte, 64<<10), 16<<20)
	return newClient(&stdioTransport{input: input, output: output, lines: lines})
}

func (t *stdioTransport) readMessage() ([]byte, error) {
	if t.lines.Scan() {
		return t.lines.Bytes(), nil
	}
	if err := t.lines.Err(); err != nil {
		return nil, err
	}
	return nil, io.EOF
}

func (t *stdioTransport) writeMessage(ctx context.Context, data []byte) error {
	deadline := time.Now().Add(5 * time.Second)
	if due, ok := ctx.Deadline(); ok && due.Before(deadline) {
		deadline = due
	}
	if err := t.output.SetWriteDeadline(deadline); err != nil {
		return err
	}
	canceled := make(chan struct{})
	stop := context.AfterFunc(ctx, func() {
		_ = t.output.SetWriteDeadline(time.Now())
		close(canceled)
	})
	defer func() {
		if !stop() {
			<-canceled
		}
	}()
	frame := append(data, '\n')
	n, err := t.output.Write(frame)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if due, ok := ctx.Deadline(); ok && !time.Now().Before(due) && errors.Is(err, os.ErrDeadlineExceeded) {
			return context.DeadlineExceeded
		}
		return err
	}
	if n != len(frame) {
		return io.ErrShortWrite
	}
	return nil
}

func (t *stdioTransport) Close() error {
	t.closeOnce.Do(func() { t.closeErr = errors.Join(t.input.Close(), t.output.Close()) })
	return t.closeErr
}

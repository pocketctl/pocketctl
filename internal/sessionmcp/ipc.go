package sessionmcp

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"time"
)

type IPCSource struct {
	SocketPath string
	Dial       func(context.Context, string) (net.Conn, error)
}

func (s *IPCSource) Read(ctx context.Context, request IpcReadRequest) (protocolSessionHistoryResult, error) {
	dial := s.Dial
	if dial == nil {
		dial = dialIPC
	}
	conn, err := dial(ctx, s.SocketPath)
	if err != nil {
		return protocolSessionHistoryResult{}, errors.New("service_unavailable")
	}
	defer conn.Close()
	deadline := time.Now().Add(35 * time.Second)
	if contextDeadline, ok := ctx.Deadline(); ok && contextDeadline.Before(deadline) {
		deadline = contextDeadline
	}
	_ = conn.SetDeadline(deadline)
	request.Type = "session_history_read_request"
	encoded, err := json.Marshal(request)
	if err != nil {
		return protocolSessionHistoryResult{}, errors.New("invalid_request")
	}
	if len(encoded) > maxIPCFrameBytes {
		return protocolSessionHistoryResult{}, errors.New("invalid_request")
	}
	if _, err := conn.Write(append(encoded, '\n')); err != nil {
		return protocolSessionHistoryResult{}, errors.New("service_unavailable")
	}
	line, err := readLine(conn, maxIPCFrameBytes)
	if err != nil {
		return protocolSessionHistoryResult{}, errors.New("service_unavailable")
	}
	var response IpcReadResponse
	if json.Unmarshal(line, &response) != nil {
		return protocolSessionHistoryResult{}, errors.New("invalid_response")
	}
	if response.Error != "" {
		return protocolSessionHistoryResult{}, errors.New(boundedCode(response.Error))
	}
	if response.Result == nil || !response.Result.UntrustedContent {
		return protocolSessionHistoryResult{}, errors.New("invalid_response")
	}
	return *response.Result, nil
}

func readLine(reader io.Reader, limit int) ([]byte, error) {
	line, err := bufio.NewReaderSize(io.LimitReader(reader, int64(limit+1)), limit+1).ReadBytes('\n')
	if len(line) > limit {
		return nil, errors.New("frame_too_large")
	}
	if err != nil {
		return nil, fmt.Errorf("read frame: %w", err)
	}
	return line, nil
}

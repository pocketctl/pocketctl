package memorymcp

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/pocketctl/pocketctl/internal/config"
)

const maxMCPRequestBytes = 256 * 1024

// Bridge proxies a hosting agent's stdio MCP framing to the remote Memory
// /mcp endpoint. Stdout carries ONLY MCP protocol bytes — every diagnostic
// goes to stderr — so a bridge failure can never corrupt the host's framing;
// failing calls answer a bounded JSON-RPC error instead.
type Bridge struct {
	Grants *CachingGrantSource
	Client *http.Client
	Stdin  io.Reader
	Stdout io.Writer
	Stderr io.Writer
}

type jsonRpcMessage struct {
	JSONRPC string           `json:"jsonrpc"`
	ID      *json.RawMessage `json:"id"`
	Error   *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

// Run serves until the context ends or stdin closes.
func (b *Bridge) Run(ctx context.Context) error {
	reader := bufio.NewReaderSize(b.Stdin, maxMCPRequestBytes+1)
	client := b.Client
	if client == nil {
		client = &http.Client{Timeout: 30 * time.Second}
	}
	client = withoutRedirects(client)
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
		frame, err := reader.ReadSlice('\n')
		if errors.Is(err, bufio.ErrBufferFull) || len(frame) > maxMCPRequestBytes {
			return errors.New("mcp_frame_too_large")
		}
		if err != nil && !errors.Is(err, io.EOF) {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			return err // malformed host framing
		}
		if errors.Is(err, io.EOF) && len(frame) == 0 {
			return nil // stdin closed: graceful shutdown
		}
		raw := json.RawMessage(bytes.TrimSpace(frame))
		if len(raw) == 0 {
			if errors.Is(err, io.EOF) {
				return nil
			}
			continue
		}
		if !json.Valid(raw) {
			return errors.New("malformed_mcp_frame")
		}
		var message jsonRpcMessage
		hasID := false
		if json.Unmarshal(raw, &message) == nil && message.ID != nil {
			hasID = true
		}
		grant, err := b.Grants.Token(ctx)
		if err != nil {
			if hasID {
				b.writeRpcError(message.ID, -32050, boundedCode(err))
			}
			continue
		}
		response, body, err := callMemory(ctx, client, raw, grant)
		if err != nil {
			if hasID {
				b.writeRpcError(message.ID, -32050, err.Error())
			}
			continue
		}
		if response.StatusCode == http.StatusUnauthorized {
			b.Grants.Invalidate(grant.Token)
			grant, err = b.Grants.Token(ctx)
			if err == nil {
				response, body, err = callMemory(ctx, client, raw, grant)
			}
			if err != nil {
				if hasID {
					b.writeRpcError(message.ID, -32050, boundedCode(err))
				}
				continue
			}
		}
		if response.StatusCode < 200 || response.StatusCode >= 300 {
			if hasID {
				b.writeRpcError(message.ID, -32050, fmt.Sprintf("http_%d", response.StatusCode))
			}
			continue
		}
		// Notifications never produce stdout bytes, regardless of which 2xx
		// status the remote stateless transport chose.
		if !hasID {
			continue
		}
		contentType := strings.ToLower(response.Header.Get("content-type"))
		if !strings.HasPrefix(contentType, "application/json") || !json.Valid(body) {
			b.writeRpcError(message.ID, -32050, "invalid_response")
			continue
		}
		var remote jsonRpcMessage
		if json.Unmarshal(body, &remote) != nil || remote.JSONRPC != "2.0" || remote.ID == nil ||
			!bytes.Equal(bytes.TrimSpace(*message.ID), bytes.TrimSpace(*remote.ID)) {
			b.writeRpcError(message.ID, -32050, "invalid_response")
			continue
		}
		if len(body) > 0 && body[len(body)-1] != '\n' {
			body = append(body, '\n')
		}
		_, _ = b.Stdout.Write(body)
	}
}

func withoutRedirects(client *http.Client) *http.Client {
	clone := *client
	clone.CheckRedirect = func(_ *http.Request, _ []*http.Request) error {
		return http.ErrUseLastResponse
	}
	return &clone
}

func callMemory(
	ctx context.Context,
	client *http.Client,
	raw []byte,
	grant Grant,
) (*http.Response, []byte, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodPost,
		grant.Origin+"/mcp", bytes.NewReader(raw))
	if err != nil {
		return nil, nil, errors.New("internal_error")
	}
	request.Header.Set("content-type", "application/json")
	request.Header.Set("accept", "application/json, text/event-stream")
	request.Header.Set("authorization", "Bearer "+grant.Token)
	response, err := client.Do(request)
	if err != nil {
		return nil, nil, errors.New("memory_unreachable")
	}
	body, readErr := io.ReadAll(io.LimitReader(response.Body, (2<<20)+1))
	_ = response.Body.Close()
	if readErr != nil || len(body) > 2<<20 {
		return nil, nil, errors.New("response_too_large")
	}
	return response, body, nil
}

func (b *Bridge) writeRpcError(id *json.RawMessage, code int, message string) {
	response := map[string]any{
		"jsonrpc": "2.0",
		"id":      id,
		"error":   map[string]any{"code": code, "message": message},
	}
	data, err := json.Marshal(response)
	if err != nil {
		return
	}
	_, _ = b.Stdout.Write(append(data, '\n'))
}

// RunBridgeStdio is the `pocketctl memory-mcp` entrypoint: stdio MCP framing
// on this process, remote Memory /mcp on the other side.
func RunBridgeStdio(ctx context.Context) error {
	source := &CachingGrantSource{
		Inner: &IPCGrantSource{SocketPath: config.MemoryMcpSocketPath()},
	}
	bridge := &Bridge{
		Grants: source,
		Stdin:  os.Stdin,
		Stdout: os.Stdout,
		Stderr: os.Stderr,
	}
	return bridge.Run(ctx)
}

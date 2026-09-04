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
	Method  string           `json:"method"`
	Params  json.RawMessage  `json:"params"`
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
		if !allowedMemoryTool(message) {
			if hasID {
				b.writeRpcError(message.ID, -32601, "tool_not_allowed")
			}
			continue
		}
		selectedScopes, selectionErr := selectedScopesForMCPMessage(message)
		if selectionErr != nil {
			if hasID {
				b.writeRpcError(message.ID, -32602, "invalid_scope_selection")
			}
			continue
		}
		grant, err := b.Grants.Token(ctx, selectedScopes)
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
			grant, err = b.Grants.Token(ctx, selectedScopes)
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
		body, ok := normalizedJSONRPCResponse(response.Header.Get("content-type"), body)
		if !ok {
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

// The bridge exposes only the server's bounded read tools; mutations never
// obtain a grant or reach the remote endpoint.
func allowedMemoryTool(message jsonRpcMessage) bool {
	if message.Method != "tools/call" {
		return true
	}
	var params struct {
		Name string `json:"name"`
	}
	if json.Unmarshal(message.Params, &params) != nil {
		return false
	}
	switch params.Name {
	case "memory_search", "memory_recall", "memory_get_claim", "memory_get_evidence",
		"memory_find_related_episodes", "memory_get_repository_context", "memory_get_code_graph",
		"memory_analyze_change_impact", "memory_get_wiki_page", "memory_list_skills", "memory_get_skill", "memory_resolve_skill":
		return true
	default:
		return false
	}
}

// selectedScopesForMCPMessage extracts only the bounded selection field from
// the two federated read tools. The bridge neither interprets permissions nor
// parses the returned JWT; it forwards the requested installation IDs to the
// authenticated daemon so Relay can make the authorization decision.
func selectedScopesForMCPMessage(message jsonRpcMessage) ([]string, error) {
	if message.Method != "tools/call" || len(message.Params) == 0 {
		return nil, nil
	}
	var params struct {
		Name      string          `json:"name"`
		Arguments json.RawMessage `json:"arguments"`
	}
	if json.Unmarshal(message.Params, &params) != nil {
		return nil, nil // the MCP server owns general JSON-RPC validation
	}
	var args map[string]json.RawMessage
	if len(params.Arguments) == 0 || json.Unmarshal(params.Arguments, &args) != nil {
		return nil, nil
	}
	if params.Name == "memory_search" || params.Name == "memory_recall" {
		raw, present := args["scope_installation_ids"]
		if !present {
			return nil, nil
		}
		var selected []string
		if json.Unmarshal(raw, &selected) != nil {
			return nil, errors.New("invalid_scope_selection")
		}
		bounded, ok := BoundedSelectedScopes(selected)
		if !ok {
			return nil, errors.New("invalid_scope_selection")
		}
		return bounded, nil
	}
	if params.Name == "memory_get_claim" || params.Name == "memory_get_evidence" ||
		params.Name == "memory_list_skills" || params.Name == "memory_get_skill" || params.Name == "memory_resolve_skill" {
		raw, present := args["installation_id"]
		if !present {
			return nil, nil
		}
		var installationID string
		if json.Unmarshal(raw, &installationID) != nil {
			return nil, errors.New("invalid_scope_selection")
		}
		bounded, ok := BoundedSelectedScopes([]string{installationID})
		if !ok {
			return nil, errors.New("invalid_scope_selection")
		}
		return bounded, nil
	}
	return nil, nil
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
	// MCP servers may choose either a JSON body or a single SSE-framed JSON-RPC
	// response. normalizedJSONRPCResponse below supports both encodings.
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

// normalizedJSONRPCResponse accepts the two MCP response encodings permitted
// by the SDK. Stdio hosts receive exactly one JSON-RPC object per line, so a
// single SSE data field is unwrapped only after its JSON is validated; multiple
// data fields are deliberately rejected rather than ambiguously concatenated.
func normalizedJSONRPCResponse(contentType string, body []byte) ([]byte, bool) {
	contentType = strings.ToLower(contentType)
	if strings.HasPrefix(contentType, "application/json") {
		return body, json.Valid(body)
	}
	if !strings.HasPrefix(contentType, "text/event-stream") {
		return nil, false
	}

	var data []byte
	for _, rawLine := range bytes.Split(body, []byte{'\n'}) {
		line := bytes.TrimSuffix(rawLine, []byte{'\r'})
		if !bytes.HasPrefix(line, []byte("data:")) {
			continue
		}
		if data != nil {
			return nil, false
		}
		data = bytes.TrimSpace(bytes.TrimPrefix(line, []byte("data:")))
	}
	return data, len(data) > 0 && json.Valid(data)
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

package agentteams

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
)

// WorkerClient targets one installation-owned QwenPaw console on the isolated
// service network. Its endpoint is never accepted from a task or remote receipt.
// The console has no auth of its own in this pinned deployment: do not expose it
// outside that network. The public-facing PocketCtl bridge authenticates requests.
type WorkerClient struct {
	base string
	http *http.Client
}
type TurnUsage struct {
	OriginalID        string `json:"original_id"`
	Model             string `json:"model"`
	FinishedAt        string `json:"finished_at"`
	InputTokens       int64  `json:"input_tokens"`
	OutputTokens      int64  `json:"output_tokens"`
	CacheReadTokens   int64  `json:"cache_read_tokens"`
	CacheCreateTokens int64  `json:"cache_create_tokens"`
	TotalTokens       int64  `json:"total_tokens"`
}
type WorkerUsage struct {
	ChatID    string      `json:"chat_id"`
	SessionID string      `json:"session_id"`
	Turns     []TurnUsage `json:"turns"`
}

func NewWorkerClient(endpoint string, client *http.Client) (*WorkerClient, error) {
	u, err := url.Parse(endpoint)
	if err != nil || u == nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || u.Opaque != "" || (u.Scheme != "http" && u.Scheme != "https") || (u.Path != "" && u.Path != "/") {
		return nil, ErrConfiguration
	}
	if client == nil {
		client = &http.Client{}
	}
	copyClient := *client
	copyClient.Jar = nil
	copyClient.Timeout = 15 * time.Second
	copyClient.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return &WorkerClient{strings.TrimSuffix(endpoint, "/"), &copyClient}, nil
}
func (c *WorkerClient) get(ctx context.Context, path string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.base+path, nil)
	if err != nil {
		return nil, ErrConfiguration
	}
	response, err := c.http.Do(req)
	if err != nil {
		return nil, ErrTransport
	}
	if response.StatusCode != 200 {
		response.Body.Close()
		return nil, &HTTPError{response.StatusCode}
	}
	return readBounded(response, 4*1024*1024)
}
func (c *WorkerClient) Usage(ctx context.Context, room string) (WorkerUsage, error) {
	var value WorkerUsage
	if len(room) < 4 || len(room) > 256 || room[0] != '!' || !strings.Contains(room, ":") || strings.ContainsAny(room, "\x00\r\n ") {
		return value, ErrIdentity
	}
	data, err := c.get(ctx, "/api/chats")
	if err != nil {
		return value, err
	}
	var chats []struct {
		ID        string `json:"id"`
		SessionID string `json:"session_id"`
		Channel   string `json:"channel"`
	}
	if decode(data, &chats) != nil {
		return value, ErrResponse
	}
	for _, chat := range chats {
		if chat.SessionID == "matrix:"+room && chat.Channel == "agentteams_matrix" {
			if value.ChatID != "" || !safeID(chat.ID) {
				return WorkerUsage{}, ErrIdentity
			}
			value.ChatID = chat.ID
			value.SessionID = chat.SessionID
		}
	}
	if value.ChatID == "" {
		return value, ErrResponse
	}
	data, err = c.get(ctx, "/api/chats/"+url.PathEscape(value.ChatID))
	if err != nil {
		return value, err
	}
	value.Turns, err = parseWorkerUsage(data)
	return value, err
}
func parseWorkerUsage(data []byte) ([]TurnUsage, error) {
	var body struct {
		Status   string `json:"status"`
		Messages []struct {
			Role     string `json:"role"`
			Metadata struct {
				OriginalID string `json:"original_id"`
				FinishedAt string `json:"finished_at"`
				Metadata   struct {
					Turn *struct {
						Usage struct {
							Model      string `json:"model_name"`
							Prompt     *int64 `json:"prompt_tokens"`
							Completion *int64 `json:"completion_tokens"`
							Total      *int64 `json:"total_tokens"`
							CacheRead  *int64 `json:"cache_read_tokens"`
							CacheWrite *int64 `json:"cache_write_tokens"`
						} `json:"usage"`
					} `json:"qwenpaw_turn_usage"`
				} `json:"metadata"`
			} `json:"metadata"`
		} `json:"messages"`
	}
	if len(data) > 4*1024*1024 || json.Unmarshal(data, &body) != nil || body.Status != "idle" {
		return nil, ErrResponse
	}
	unique := map[string]TurnUsage{}
	for _, message := range body.Messages {
		md := message.Metadata
		if md.Metadata.Turn == nil {
			continue
		}
		u := md.Metadata.Turn.Usage
		if message.Role != "assistant" || !safeID(md.OriginalID) || len(u.Model) == 0 || len(u.Model) > 128 || strings.ContainsAny(u.Model, "\x00\r\n") {
			return nil, ErrResponse
		}
		if _, err := time.Parse(time.RFC3339Nano, md.FinishedAt); err != nil {
			return nil, ErrResponse
		}
		for _, n := range []*int64{u.Prompt, u.Completion, u.Total, u.CacheRead, u.CacheWrite} {
			if n == nil || *n < 0 || *n > 1<<50 {
				return nil, ErrResponse
			}
		}
		if *u.Total != *u.Prompt+*u.Completion || *u.CacheRead+*u.CacheWrite > *u.Prompt {
			return nil, ErrResponse
		}
		fact := TurnUsage{md.OriginalID, u.Model, md.FinishedAt, *u.Prompt - *u.CacheRead - *u.CacheWrite, *u.Completion, *u.CacheRead, *u.CacheWrite, *u.Total}
		if old, ok := unique[fact.OriginalID]; ok && old != fact {
			return nil, ErrResponse
		}
		unique[fact.OriginalID] = fact
	}
	if len(unique) == 0 || len(unique) > 1000 {
		return nil, ErrResponse
	}
	turns := make([]TurnUsage, 0, len(unique))
	for _, v := range unique {
		turns = append(turns, v)
	}
	sort.Slice(turns, func(i, j int) bool { return turns[i].OriginalID < turns[j].OriginalID })
	return turns, nil
}
